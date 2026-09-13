import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownToDocx } from './md-to-docx.js';
import { authorizedClient } from './google-client.js';
import { uploadToDrive, createGmailDraft } from './google-ship.js';

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
  const slug = process.argv[2] ?? env('WORDWRIGHT_SLUG');
  const notify = env('SHIP_NOTIFY_EMAIL');

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

  const filename = `${slug}-${stamp()}.docx`;
  const buffer = await markdownToDocx(draft);

  mkdirSync('shipped', { recursive: true });
  writeFileSync(join('shipped', filename), buffer);

  const ledger = `Ship ${slug}: ${turnCount} turns, last turn ${lastAt}`;
  const githubUrl = await commitToGitHub({
    repo, token: ghToken, path: `shipped/${filename}`, buffer, message: ledger,
  });

  // GitHub is shipped from here on. Anything that fails below must still
  // surface the GitHub URL before dying, so the run is never silently lost.
  let driveLink;
  try {
    driveLink = await uploadToDrive(auth, { filename, buffer });
    const draftId = await createGmailDraft(auth, {
      to: notify,
      subject: `Shipped: ${slug}`,
      body: `${ledger}\n${githubUrl} ${driveLink}`,
      filename,
      buffer,
    });
    console.log(githubUrl);
    console.log(driveLink);
    console.log(draftId);
  } catch (e) {
    console.log(githubUrl);
    if (driveLink) console.log(driveLink);
    die(`Google step failed after GitHub commit succeeded: ${e.message}`);
  }
}

main();
