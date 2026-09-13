# Chunk 1 — WordWright → .docx → GitHub

Status: **done, verified on GitHub.**

Proof: https://github.com/drjlgross/ship_this_draft/blob/main/shipped/demo-doc-20260913-1355.docx

## What was built

- **Commit `00e4d6f`** (first commit, nothing else in it): `.gitignore` covering
  `.env`, `*.token`, `credentials/`, `client_secret*.json`, `token-cache.json`,
  `node_modules/`, `shipped/`; plus `.env.example` with placeholder values only.
- **`npm i docx@^9.7.1 marked`** — resolved docx 9.7.1, marked 18.0.13. Package is ESM.
- **`md-to-docx.js`** — `markdownToDocx(markdown) -> Buffer`. Lexes with
  `marked.lexer`, emits docx paragraphs. Supports headings H1–H6, paragraphs,
  bold/italic (nesting-aware, so `***both***` yields one run with both), bullet and
  ordered lists including nesting, and links rendered as their anchor text. Code
  spans/blocks get Courier New; no further styling.
- **`ship.js`** — `node ship.js <slug>`, slug optional, defaults to `WORDWRIGHT_SLUG`.
  Loads `.env` via `process.loadEnvFile`. Fetches the document, writes
  `shipped/<slug>-<YYYYMMDD-HHmm>.docx` locally (scratch, gitignored), then PUTs the
  same bytes to the GitHub contents API. No shelling out to git — the agent acts on
  GitHub as an external app through its REST API. Prints the file's `html_url`.

## Observed API shape (step 0)

`GET /api/t/{TOKEN}/documents/demo-doc` → HTTP 200, `application/json`.

Top-level keys: `schema_version`, `slug`, `created_at`, `draft`, `history`, `rules`.

The contract held. `draft` is the current Markdown string; `history` is an
append-only array of 6 turns, each `{ turn_id, timestamp, author, snapshot }` —
`author` observed as `"human"` or `"ai"`, `timestamp` an ISO-8601 string.
`doc.draft` was confirmed byte-identical to the final turn's `snapshot`, so the
`turns`/`snapshot` fallback the chunk warned about was not needed and is **not**
in the code — `readLedger` is pinned to the observed shape and fails loud on
anything else, rather than carrying speculative fallbacks.

Three fields are present that the contract does not mention:

- `schema_version` (number, `1`) — worth asserting on in a later chunk if the
  service starts versioning; this chunk ignores it.
- `created_at` (ISO-8601 string).
- `rules` — an array of 3 objects `{ id, text, scope, source, created_at }`
  holding the document's writing constraints (e.g. "no em-dashes.",
  scope "this document", source "human"). These are authoring constraints for
  WordWright's own editor, not instructions to this pipeline, and are treated as
  inert data. Nothing in this chunk reads or acts on them.

## Commit message / ledger citation

`Ship demo-doc: 6 turns, last turn 2026-09-13T17:26:42.270Z`

Landed as commit `e2aa111c`, authored as drjlgross via the PAT.

## Markdown features actually exercised by the demo doc

The demo draft is a four-paragraph thank-you letter: **plain paragraphs only.** It
exercises no headings, no bold/italic, no lists, no links. A green run on this doc
therefore proves almost nothing about the converter.

So the other features were verified separately, against real docx XML rather than
by assertion: a fixture covering H1/H2/H3, `**bold**`, `*italic*`, `***both***`,
a link, a nested bullet list and an ordered list was converted, unzipped, and
`word/document.xml` inspected. Confirmed: one `Heading1`/`Heading2`/`Heading3`
style ref each, 2 `<w:b/>` and 2 `<w:i/>` runs, 5 `<w:numPr>` list items, one at
`ilvl=1` (nesting), and the link emitted as its anchor text with the URL **not**
leaked into the document body. Fixture lives in the scratchpad, not the repo.

## Verification of the done condition

Not just a green run:

- `GET /contents/shipped` on the repo lists `demo-doc-20260913-1355.docx`, 8850 bytes.
- The file was downloaded back from GitHub; `file(1)` reports "Microsoft Word 2007+".
- SHA-256 of the GitHub copy and the local copy match (`b81eb38d…`), so the bytes
  committed are the bytes generated.
- Unzipping the GitHub copy yields 4 text runs matching the draft's paragraphs.
- `git ls-files` shows only `.env.example`, `.gitignore`, `LICENSE` tracked;
  `git check-ignore` confirms `.env`, `shipped/*.docx`, and `node_modules` ignored.

## Assumptions and deviations

- **`.env` was created by you, not by me** — no credentials were present in the
  repo, shell, or home directory at session start, so the shape check and the real
  run blocked until you supplied them. `GITHUB_REPO=drjlgross/ship_this_draft`.
- **`package.json` / `package-lock.json` are untracked.** The chunk specified the
  contents of the first commit exactly and said nothing about committing the source
  afterwards, so I did not commit `ship.js`, `md-to-docx.js`, the manifest, or this
  report. They sit in the working tree. Say the word and I'll commit them.
- **Errors fail loud, one line, no retries**: every failure path exits 1 via
  `die()` printing `ship: <cause>`. No retry logic, no partial writes.
- **Filename timestamp is local time**, not UTC — `YYYYMMDD-HHmm` as specified,
  which does not carry a zone. The ledger timestamp in the commit message is the
  service's own ISO-8601 UTC string, unmodified.
- **Re-running within the same minute** would target an existing path and get a
  422 from GitHub, which surfaces as a one-line failure rather than an overwrite.
  Consistent with "no retries, no partial writes"; flagging it since it is a
  plausible demo-day footgun.
- Scope held: no Drive, no Gmail, no config system, no subcommands, no test framework.
