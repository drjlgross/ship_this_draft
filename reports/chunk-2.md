# Chunk 2 — Google: Drive upload + Gmail draft

Status: **done, all three artifacts observed.**

One run of `node ship.js` produced:

- GitHub: `shipped/demo-doc-20260913-1455.docx`, commit `0b6384a5`
- Drive: `demo-doc-20260913-1455.docx` in folder `ship_this_draft` at My Drive root
- Gmail: draft `r-8583338864019277263`, label `DRAFT` only

## Gate check

`git check-ignore -v client_secret_*.json` → matched by `.gitignore:4:client_secret*.json`.
Gate passed, so the chunk proceeded.

`token.json` was **not** covered by the existing `token-cache.json` pattern, as the
chunk warned. Added as a one-line `.gitignore` entry and committed on its own
(`5ace0f6`) before any Google code was written. Verified afterwards with a real
file on disk: invisible to `git status`, and not staged even by `git add .`.
The written `token.json` is mode `0600`.

## Versions

- `googleapis` **180.0.0** (installed as `^180.0.0`)
- `google-auth-library` **11.0.2** (transitive, ships with googleapis)

## Scopes granted, as echoed back by Google

The token response's `scope` field came back as exactly:

```
https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.compose
```

No broader scope was requested or granted. `auth.js` diffs the echoed scopes
against the requested pair and refuses to write `token.json` if either is absent,
so a half-ticked consent screen fails at bootstrap rather than at the Drive or
Gmail call.

## Consent-screen friction

The **first `node auth.js` attempt timed out and wrote nothing.** Two causes, one
mine:

1. The operator was reading the scope list in the auth URL by hand before
   consenting — reasonable, and the 5-minute window I had chosen was too tight
   for it.
2. My timeout rejected from a bare `setTimeout` at module top level, so it
   surfaced as an unhandled rejection with a Node stack trace. That violates the
   standing rule of failing loud in one line.

`auth.js` was rewritten: 15-minute window, `main().catch(e => die(e.message))` so
every failure path prints one `ship: <cause>` line, listener and timer released in
a `finally`, and the per-run redirect port is printed. The second attempt
succeeded and wrote `token.json`.

Note for re-runs: the loopback port is ephemeral and freshly allocated each run,
so a URL from a previous attempt is dead. Use the URL the current run prints.

## Verification (observed, not asserted)

- **Drive**: `files.get` reports name `demo-doc-20260913-1455.docx`, the docx MIME
  type, 8850 bytes, parent folder `ship_this_draft`, whose own parent is the My
  Drive root. Exactly **one** folder of that name is visible to the app.
- **Folder reuse**: re-running `ensureFolder`'s exact list query returns 1 match,
  so a second run takes the reuse branch rather than creating a duplicate.
- **Gmail**: `drafts.get` shows `To: drjlgross@gmail.com`, `Subject: Shipped:
  demo-doc`, body of two lines, and one attachment
  `demo-doc-20260913-1455.docx` (docx MIME, 8850 bytes). `labelIds` is
  `['DRAFT']` with no `SENT` — **nothing was sent.**
- **Byte integrity**: the local scratch copy, the copy downloaded back from
  GitHub, and the copy downloaded back from Drive all hash to
  `f408a493…c20d61`. One SHA-256 across all three.

## Failure isolation

The Google half runs inside a `try`; its catch prints the GitHub URL that already
succeeded (and the Drive link if it got that far) before dying loud. To make that
guarantee real, two things changed from my first draft:

- `google-ship.js` and `authorizedClient()` now **throw** instead of calling
  `die()`. `die()` calls `process.exit`, which bypasses the catch and would have
  swallowed the GitHub URL on a Google failure.
- `SHIP_NOTIFY_EMAIL` and `token.json` are **preflighted before the WordWright
  fetch and GitHub commit**, so a missing address or token fails with nothing
  shipped rather than half-shipped. Confirmed: with `SHIP_NOTIFY_EMAIL` unset the
  run dies `ship: missing SHIP_NOTIFY_EMAIL (set it in .env)` before any side
  effect.

## Assumptions and deviations

- **I corrupted `.env` and repaired it.** Appending `SHIP_NOTIFY_EMAIL` with
  `printf >>` concatenated it onto the end of the `GITHUB_REPO` line, which had no
  trailing newline, producing
  `GITHUB_REPO=drjlgross/ship_this_draftSHIP_NOTIFY_EMAIL=...`. Caught on the
  read-back, split back into two lines, and all five keys confirmed to parse.
  A pre-repair backup is in the session scratchpad. No secret was exposed and no
  token value was altered, but this was a careless write to the one file holding
  live credentials.
- **Mail body read literally as two lines.** The chunk says "body = two lines: the
  ledger citation line ..., then the GitHub html_url and the Drive webViewLink."
  I put both URLs on the second line, space-separated. It is faithful to the
  instruction but reads poorly in a mail client; three lines (ledger, GitHub,
  Drive) would be friendlier. Left as specified — say the word and it is a
  one-line change.
- **`drive.file` bounds the reuse guarantee.** The folder query can only see
  folders this app created. A folder named `ship_this_draft` that you created by
  hand in the Drive UI is invisible to the app, so the app would create its own
  alongside it. This is inherent to the scope choice and is the correct tradeoff;
  noting it because "reuse if present" is only true for app-created folders.
- **Source files are untracked**, as at the end of chunk 1: `auth.js`,
  `google-client.js`, `google-ship.js`, the `ship.js` edits, `.env.example`, and
  this report are in the working tree, uncommitted. Only the `token.json`
  gitignore line was committed, because the chunk explicitly called for it.
- Scope held: no sending, no Slack, no WordWright change, no retry logic, no
  token-refresh persistence beyond what googleapis does in-process, no
  multi-account handling.

---

## Addendum — per-channel output (fix applied after ratification)

Commit `fc723ee`, "Per-channel output: each channel self-contained". `ship.js`
only. This supersedes the "mail body read literally as two lines" deviation noted
above, which is now moot.

**Rationale.** The chunk-2 body stitched all three channels together: a ledger
line, the GitHub URL and the Drive link in one mail. That makes each artifact
depend on the others to be legible, and it is wrong in two directions. A reader
who only gets the mail is handed links they may not be able to open, and the mail
describes the draft instead of being it. A run where only one channel fires
should still produce something correct and complete on its own. So each channel
now carries what belongs to it natively, with no cross-references:

- **Gmail** — the correspondence itself. Subject is the draft's first markdown
  heading, or the slug humanized (dashes and underscores to spaces) when it has
  none. Body is the draft's full text, plain, nothing above or below it. No
  ledger, no GitHub URL, no Drive link. The `.docx` stays attached.
- **GitHub** — unchanged. The ledger citation (slug, turn count, last-turn
  timestamp) is git-native provenance and belongs in the commit message.
- **Drive** — unchanged. Slug plus timestamp filename in the `ship_this_draft`
  folder.

**Content of the change.** Twelve lines in `ship.js`: a `marked` import, a
four-line `emailSubject(draft, slug)` helper, and the two changed properties in
the `createGmailDraft` call. Nothing in `google-ship.js`, `google-client.js`,
fetching, conversion, scopes, or the Drive/GitHub paths moved.

**Verified** on draft `r7876213886672915177`: subject `demo doc` (this draft has
no heading, so the slug branch ran); body string-compares exactly equal to a fresh
WordWright fetch of `draft`; ledger line, `github.com` and `docs.google.com` all
confirmed absent from the body; attachment present; label `DRAFT` only. The
heading branch was unit-tested separately (`# Quarterly Update` -> `Quarterly
Update`, including a heading that follows an opening paragraph). GitHub commit
`39e401bc` still carries the full ledger line, and Drive reused folder
`1Wjwn...41DEQ` rather than creating a duplicate.

**Known gap, not addressed.** Subjects now come from draft content rather than a
fixed ASCII string, and `buildMime` writes the subject header raw with no
RFC 2047 encoding. A heading containing an em-dash, curly quote or accent will go
out mis-encoded. The demo draft is pure ASCII so it did not bite. The fix belongs
in `buildMime` in `google-ship.js`, which this task explicitly placed out of
bounds, so it was flagged rather than made.
