import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { markdownToDocx } from './md-to-docx.js';
import { authorizedClient } from './google-client.js';
import { uploadToDrive, createGmailDraft } from './google-ship.js';
import { reviewDraft } from './review.js';
import { createInterface } from 'node:readline/promises';

const WW_BASE = 'https://wordwright.ink';

function die(msg) {
  console.error(`ship: ${msg}`);
  process.exit(1);
}

function env(key) {
  const v = process.env[key];
  if (!v) die(`missing ${key} (set it in .env)`);
  return v;
}

// YYYYMMDD-HHmm in local time.
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function fetchDocument(token, slug) {
  const url = `${WW_BASE}/api/t/${token}/documents/${slug}`;
  const res = await fetch(url);
  if (!res.ok) die(`WordWright GET ${slug} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// Pinned to the shape observed at https://wordwright.ink on 2026-09-13:
// { schema_version, slug, created_at, draft, history[{turn_id, timestamp,
//   author, snapshot}], rules }. See reports/chunk-1.md.
function readLedger(doc) {
  if (typeof doc.draft !== 'string' || !doc.draft.trim()) {
    die('WordWright document: `draft` missing or empty');
  }
  if (!Array.isArray(doc.history) || doc.history.length === 0) {
    die('WordWright document: `history` missing or empty');
  }
  const last = doc.history[doc.history.length - 1];
  if (typeof last.timestamp !== 'string') {
    die('WordWright document: last history turn has no `timestamp`');
  }
  return { draft: doc.draft, turnCount: doc.history.length, lastAt: last.timestamp };
}

// The draft is the correspondence, so the mail carries the draft itself: its
// first heading as the subject, or the humanized slug when it has none.
function emailSubject(draft, slug) {
  const heading = marked.lexer(draft).find((t) => t.type === 'heading');
  return heading ? heading.text : slug.replace(/[-_]+/g, ' ');
}

const CHANNELS = ['github', 'drive', 'gmail'];

// One interface for the whole run, read through its line iterator: creating a
// second readline on a piped stdin leaves the next question unresolved, and the
// iterator gives a clean end-of-input signal instead of a silent no-op.
let rl = null;
let lines = null;

async function ask(question) {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    lines = rl[Symbol.asyncIterator]();
  }
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) die('stdin closed before the prompt was answered');
  return (value ?? '').trim();
}

function endPrompts() {
  if (rl) rl.close();
  rl = null;
  lines = null;
}

function parseChannels(answer) {
  const names = answer.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((c) => !CHANNELS.includes(c));
  if (names.length === 0 || unknown.length > 0) return null;
  return [...new Set(names)];
}

function printVerdict(verdict) {
  console.log(`ready: ${verdict.ready}`);
  for (const r of verdict.reasons) console.log(`  - ${r}`);
  if (verdict.ready) {
    console.log(`channel: ${verdict.channel}`);
    if (verdict.second_channel) {
      console.log(`second channel: ${verdict.second_channel.channel} — ${verdict.second_channel.why}`);
    }
  }
}

// Returns { channels, override }. An empty channel list means ship nothing.
async function greenlight(verdict, autoYes) {
  const recommended = verdict.ready
    ? [verdict.channel, ...(verdict.second_channel ? [verdict.second_channel.channel] : [])]
    : [];

  if (verdict.ready) {
    if (autoYes) return { channels: [...new Set(recommended)], override: false };
    const answer = await ask(`ship via [${[...new Set(recommended)].join(', ')}]? (y / edit = comma list / n) `);
    if (answer.toLowerCase() === 'n') return { channels: [], override: false };
    if (answer === '' || answer.toLowerCase() === 'y') return { channels: [...new Set(recommended)], override: false };
    const edited = parseChannels(answer);
    if (!edited) die(`unrecognized channel list: ${answer}`);
    return { channels: edited, override: false };
  }

  // --yes never overrides a hold.
  if (autoYes) return { channels: [], override: false };
  const answer = await ask('hold recommended — override and ship anyway? (n / channel name to override) ');
  if (answer === '' || answer.toLowerCase() === 'n') return { channels: [], override: false };
  const overridden = parseChannels(answer);
  if (!overridden) die(`unrecognized channel list: ${answer}`);
  return { channels: overridden, override: true };
}

async function commitToGitHub({ repo, token, path, buffer, message }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content: buffer.toString('base64') }),
  });
  const body = await res.json();
  if (!res.ok) die(`GitHub PUT ${path} failed: ${res.status} ${body.message ?? res.statusText}`);
  return body.content.html_url;
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const wwToken = env('WORDWRIGHT_TOKEN');
  const ghToken = env('GITHUB_TOKEN');
  const repo = env('GITHUB_REPO');
  const args = process.argv.slice(2);
  const autoYes = args.includes('--yes');
  const slug = args.filter((a) => !a.startsWith('--'))[0] ?? env('WORDWRIGHT_SLUG');
  // Preflighted so a missing address fails loud before anything ships;
  // createGmailDraft reads it as the default recipient.
  env('SHIP_NOTIFY_EMAIL');

  // Preflight the Google credentials before any side effect, so a missing
  // token.json fails loud instead of half-shipping.
  let auth;
  try {
    auth = authorizedClient();
  } catch (e) {
    die(e.message);
  }

  const doc = await fetchDocument(wwToken, slug);
  const { draft, turnCount, lastAt } = readLedger(doc);

  const { verdict } = await reviewDraft({ draft, history: doc.history });
  printVerdict(verdict);

  const { channels, override } = await greenlight(verdict, autoYes);
  if (channels.length === 0) {
    endPrompts();
    for (const c of CHANNELS) console.log(`${c}: skipped`);
    return;
  }
  if (override) console.log('OVERRIDE: human shipped despite hold');

  let recipients;
  if (channels.includes('gmail')) {
    const answer = autoYes
      ? ''
      : await ask('recipients? (enter = SHIP_NOTIFY_EMAIL / comma-separated addresses) ');
    if (answer !== '') recipients = answer.split(',').map((a) => a.trim()).filter(Boolean);
  }
  endPrompts();

  // The .docx exists for the artifact channels only; gmail carries the text.
  let filename;
  let buffer;
  if (channels.includes('github') || channels.includes('drive')) {
    filename = `${slug}-${stamp()}.docx`;
    buffer = await markdownToDocx(draft);
    mkdirSync('shipped', { recursive: true });
    writeFileSync(join('shipped', filename), buffer);
  }

  if (channels.includes('github')) {
    const ledger = `Ship ${slug}: ${turnCount} turns, last turn ${lastAt}`;
    const githubUrl = await commitToGitHub({
      repo, token: ghToken, path: `shipped/${filename}`, buffer, message: ledger,
    });
    console.log(`github: ${githubUrl}`);
  } else {
    console.log('github: skipped');
  }

  // Each channel prints as it lands, so a later failure never erases an
  // earlier success — a completed GitHub commit is already on stdout.
  try {
    if (channels.includes('drive')) {
      console.log(`drive: ${await uploadToDrive(auth, { filename, buffer })}`);
    } else {
      console.log('drive: skipped');
    }

    if (channels.includes('gmail')) {
      const draftId = await createGmailDraft(auth, {
        recipients,
        subject: emailSubject(draft, slug),
        body: draft,
      });
      console.log(`gmail: ${draftId}`);
    } else {
      console.log('gmail: skipped');
    }
  } catch (e) {
    die(`Google step failed: ${e.message}`);
  }
}

main();
