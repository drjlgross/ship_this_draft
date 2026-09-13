# Chunk 3 — review pass: model assesses, routes, human greenlights

Status: **done, all three seeded scenarios observed.**

A model review now sits between the WordWright fetch and any conversion or
shipping. It returns a JSON verdict; the human greenlights; only chosen channels
ship.

## System prompt (verbatim)

Sent as the `system` field on every review call:

```
You are a shipping reviewer for finished documents.

Respond ONLY with JSON. No prose, no code fences.

Schema:
{
  "ready": true | false,
  "reasons": ["<short string>", ...],
  "channel": "github" | "drive" | "gmail",
  "second_channel": null | {"channel": "github" | "drive" | "gmail", "why": "<string>"}
}

"reasons" is always present and has 1 to 4 items. "channel" is present only when "ready" is true.

Readiness. A document is not ready if it contains placeholders or TODOs, unresolved meta-questions addressed to a collaborator, or obvious incompleteness. Obvious typos alone do not block readiness: mark it ready and note them in a reason.

Channel. Choose the SINGLE natural destination.
- "github": a work product worth version-controlled archiving.
- "drive": a document a human will store, print, or hand to someone.
- "gmail": correspondence; it reads as written TO a recipient.

Set "second_channel" only when there is a distinct positive reason, and state that reason. Most documents have exactly one destination. Never add a second channel just in case.
```

The user message is the ledger summary and the draft, each in a tag:

```
<ledger>
turns: 6
author sequence: human -> ai -> human -> ai -> ai -> human
last turn: 2026-09-13T17:26:42.270Z
</ledger>

<draft>
...full draft text...
</draft>
```

Request: `POST https://api.anthropic.com/v1/messages`, `model: claude-sonnet-4-6`,
`max_tokens: 1000`, headers `x-api-key`, `anthropic-version: 2023-06-01`.

## One full JSON response per seeded doc

**demo-doc** (thank-you letter):

```json
{
  "ready": true,
  "reasons": [
    "Document is complete, sincere, and contains no placeholders, TODOs, or unresolved questions.",
    "Minor observation: 'Rookie Gross' is an unusual name but appears to be the author's actual name, not a placeholder."
  ],
  "channel": "gmail",
  "second_channel": null
}
```

**fiber-memo** (junk doc) — returned **inside a ```json fence** and with
`second_channel` **absent**, both handled (see surprises below):

````
```json
{
  "ready": false,
  "reasons": [
    "All three cost entries are explicit placeholders requiring real pricing data.",
    "The Conclusion/Final Recommendation section is an unfilled placeholder.",
    "Document cannot fulfill its stated purpose (identify which supplement to recommend) while the conclusion is missing."
  ]
}
```
````

**how-to-vibecode-well** (archival doc):

```json
{
  "ready": true,
  "reasons": [
    "No placeholders, TODOs, or unresolved collaborator questions found.",
    "Document is complete and coherent end-to-end.",
    "Minor stylistic note: 'pretty soon' reads slightly informal relative to the surrounding register, but does not block shipping.",
    "Reads as a personal reflective essay suitable for sharing or publishing, not as direct correspondence to a named recipient."
  ],
  "channel": "drive",
  "second_channel": {
    "channel": "github",
    "why": "The piece is a practitioner methodology document with durable reference value; version-controlled archiving would let it be cited, revised, and linked over time."
  }
}
```

## Prompt-shape surprises

1. **The fence instruction is not reliably obeyed.** "Respond ONLY with JSON. No
   prose, no code fences" held for demo-doc and how-to-vibecode-well but not for
   fiber-memo, which came back wrapped in ```json. The chunk anticipated this and
   the stripper handles it. Worth stating plainly: the fence-stripping step is
   load-bearing, not defensive decoration.
2. **`second_channel` is omitted, not nulled, when not ready.** The schema says
   `null | {...}`, and the spec says `channel` appears only when ready; the model
   generalized that to dropping `second_channel` too. The validator treats absent
   and `null` alike, so this passes. A stricter reading of the schema would have
   died here on a correct verdict.
3. **Verdicts are not deterministic across runs.** The same document produced
   different `reasons` wording, a different number of reasons (2 to 4), and — for
   how-to-vibecode-well — a differently-worded `why` on every call. Readiness and
   channel were stable across the runs observed; the prose around them was not. No
   temperature is set, so this is the default sampling behavior. Anything that
   depends on exact reason text would be building on sand.
4. **Scenario (c) did not match the expected verdict.** The done condition
   anticipated "ready, channel github only". The model instead consistently chose
   `channel: "drive"` with `second_channel: "github"`, reasoning that the essay is
   a document a human would store or hand to someone, and separately worth version
   control. That is a defensible reading of the channel definitions rather than a
   malfunction, and it did state a distinct positive reason for the second channel
   as instructed. The commit still shipped, both on the accept path and on an
   edited `github`-only run. Recording it because the chunk's expected verdict and
   the observed verdict differ, and the observed one wins.

## Observed runs (the done condition)

**(a) demo-doc** — `printf 'y\n\n' | node ship.js`

```
ready: true
channel: gmail
ship via [gmail]? (y / edit = comma list / n) recipients? (enter = SHIP_NOTIFY_EMAIL / comma-separated addresses)
github: skipped
drive: skipped
gmail: r352839278578059001
```

Draft verified: `To: drjlgross@gmail.com` (equal to `SHIP_NOTIFY_EMAIL`), subject
`demo doc`, single-part `text/plain` with no attachment, label `DRAFT` only.
GitHub and Drive confirmed to have gained no file from this run.

**(b) fiber-memo, run 1** — `printf '\n' | node ship.js fiber-memo`

```
ready: false
  - All three products have explicit placeholders for cost calculations requiring data from external sources.
  - The conclusion/final recommendation is an unfilled placeholder.
hold recommended — override and ship anyway? (n / channel name to override)
github: skipped
drive: skipped
gmail: skipped
```

Exit 0, nothing shipped. Reasons name the placeholders, as required.

**(b) fiber-memo, run 2 (override)** — `printf 'drive\n' | node ship.js fiber-memo`

```
OVERRIDE: human shipped despite hold
github: skipped
drive: https://docs.google.com/document/d/1BUrtFtzrt4OZU3_L4sDRCKLFm-RKxqAn/edit?...
gmail: skipped
```

`fiber-memo-20260913-1643.docx` (9059 bytes) confirmed in the Drive folder.

**(c) how-to-vibecode-well** — `printf 'y\n' | node ship.js how-to-vibecode-well`
shipped the recommended `drive, github` pair: commit `065d78ce` plus the Drive
file. A second run answering `github` exercised the **edit** path, narrowing to
one channel: commit `e1179b78`, `drive: skipped`. Both commits read
`Ship how-to-vibecode-well: 6 turns, last turn 2026-09-13T20:37:56.647Z`.

**`--yes`** — verified in both directions. On fiber-memo (not ready) it printed
the hold and shipped nothing, never overriding. On demo-doc (ready) it accepted
the recommendation and created draft `r6965245477456374045` with the default
recipient, asking nothing.

## A bug found and fixed during the chunk

The first working version created a fresh `readline` interface per question and
closed it after each. On a piped stdin the second `createInterface` produced a
question that never resolved: the event loop drained and **the process exited 0
having shipped nothing**, with no error. A green exit code, no output, no
artifact. Replaced with one interface for the whole run, read through its line
iterator so end-of-input is an explicit `done` that dies loud
(`ship: stdin closed before the prompt was answered`) rather than a silent no-op.
Noting it because the failure mode was exactly the one the standing rules exist
to prevent — a run that looks successful and did nothing.

## Assumptions and deviations

- **Raw `fetch`, not the Anthropic SDK.** The chunk specifies
  `POST https://api.anthropic.com/v1/messages` by URL, and the repo already
  consumes GitHub the same way. No new dependency was added. The bundled API
  reference prefers the official SDK for a JS project, so this is a deliberate
  departure from that guidance in favor of the chunk's explicit instruction and
  the existing house style.
- **Model is `claude-sonnet-4-6`, as specified.** The same reference defaults to
  `claude-opus-5` and treats anything else as needing an explicit request; this
  chunk named the model, so the named one was used. Flagging it only so the choice
  is visible: this is a prior-generation model.
- **Conversion now happens after the greenlight**, not before, since the chunk
  places the review ahead of "any conversion/shipping" and a gmail-only run has no
  use for a `.docx`. A gmail-only run therefore writes nothing to `shipped/`.
- **Failure isolation is now structural.** Each channel prints its result as it
  lands, so a completed GitHub commit is already on stdout before the Google half
  runs. The explicit re-print on the catch path is gone because it is redundant.
- **WordWright shape note.** An unknown slug 404s correctly. But
  `GET /api/t/{token}/documents` with no slug returns HTTP 200 and an empty
  document (`slug: "draft"`, empty `draft`, empty `history`) rather than an error.
  `ship.js` always appends a slug so it cannot hit this, and `readLedger` would
  die loud on the empty draft anyway. Recorded as an observation about the
  service, not a problem in this code.
- **Verification note on Gmail.** `gmail.compose` permits `users.drafts.list`,
  which returns the account's pre-existing personal drafts alongside the ones this
  tool creates. Verification should filter to the draft id the run printed rather
  than listing the mailbox. No draft content beyond this pipeline's own is
  reproduced in this report.
- Scope held: no model-written prose in any shipped output (the model's text
  reaches the terminal only, never a document, commit message, or mail body), no
  retries, no streaming, no WordWright changes, no new integrations.
