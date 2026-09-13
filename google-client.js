import { readFileSync, readdirSync } from 'node:fs';
import { google } from 'googleapis';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.compose',
];

export const TOKEN_PATH = 'token.json';

export function die(msg) {
  console.error(`ship: ${msg}`);
  process.exit(1);
}

// The desktop-app client_secret_*.json Google hands out, keyed under "installed".
export function loadClientSecret() {
  const match = readdirSync('.').filter(
    (f) => f.startsWith('client_secret') && f.endsWith('.json'),
  );
  if (match.length === 0) die('no client_secret*.json in repo root');
  if (match.length > 1) die(`multiple client_secret*.json in repo root: ${match.join(', ')}`);
  const parsed = JSON.parse(readFileSync(match[0], 'utf8'));
  const creds = parsed.installed ?? parsed.web;
  if (!creds?.client_id || !creds?.client_secret) {
    die(`${match[0]} has no installed/web client credentials`);
  }
  return creds;
}

export function oauthClient(redirectUri) {
  const { client_id, client_secret } = loadClientSecret();
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

export function authorizedClient() {
  let saved;
  try {
    saved = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    throw new Error(`no ${TOKEN_PATH} — run \`node auth.js\` first`);
  }
  if (!saved.refresh_token) throw new Error(`${TOKEN_PATH} has no refresh_token — re-run \`node auth.js\``);
  const client = oauthClient();
  client.setCredentials({ refresh_token: saved.refresh_token });
  return client;
}
