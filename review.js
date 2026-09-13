import { die } from './google-client.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

export const SYSTEM_PROMPT = `You are a shipping reviewer for finished documents.

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

Set "second_channel" only when there is a distinct positive reason, and state that reason. Most documents have exactly one destination. Never add a second channel just in case.`;

const CHANNELS = ['github', 'drive', 'gmail'];

function ledgerSummary(history) {
  const last = history[history.length - 1];
  return [
    `turns: ${history.length}`,
    `author sequence: ${history.map((t) => t.author).join(' -> ')}`,
    `last turn: ${last.timestamp}`,
  ].join('\n');
}

// Strip a ```json fence if the model wraps the object despite the instruction.
function stripFences(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
}

function validate(verdict, raw) {
  const bad = (why) => die(`review response ${why}\n--- raw response ---\n${raw}`);
  if (typeof verdict !== 'object' || verdict === null) bad('is not a JSON object');
  if (typeof verdict.ready !== 'boolean') bad('has no boolean `ready`');
  if (!Array.isArray(verdict.reasons) || verdict.reasons.length < 1 || verdict.reasons.length > 4) {
    bad('has no `reasons` array of 1-4 items');
  }
  if (verdict.reasons.some((r) => typeof r !== 'string')) bad('has a non-string in `reasons`');
  if (verdict.ready && !CHANNELS.includes(verdict.channel)) {
    bad(`is ready but \`channel\` is not one of ${CHANNELS.join('/')}`);
  }
  const second = verdict.second_channel;
  if (second !== null && second !== undefined) {
    if (typeof second !== 'object' || !CHANNELS.includes(second.channel) || typeof second.why !== 'string') {
      bad('has a malformed `second_channel`');
    }
  }
  return verdict;
}

export async function reviewDraft({ draft, history }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) die('missing ANTHROPIC_API_KEY (set it in .env)');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `<ledger>\n${ledgerSummary(history)}\n</ledger>\n\n<draft>\n${draft}\n</draft>`,
      }],
    }),
  });

  const body = await res.text();
  if (!res.ok) die(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);

  let message;
  try {
    message = JSON.parse(body);
  } catch {
    die(`Anthropic API returned non-JSON\n--- raw response ---\n${body}`);
  }
  if (message.stop_reason === 'refusal') die(`review refused by the model\n--- raw response ---\n${body}`);

  const raw = (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!raw.trim()) die(`review returned no text\n--- raw response ---\n${body}`);

  let verdict;
  try {
    verdict = JSON.parse(stripFences(raw));
  } catch (e) {
    die(`review response is not valid JSON (${e.message})\n--- raw response ---\n${raw}`);
  }
  return { verdict: validate(verdict, raw), raw };
}
