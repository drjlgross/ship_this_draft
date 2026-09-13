import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { SCOPES, TOKEN_PATH, oauthClient, die } from './google-client.js';

const CONSENT_TIMEOUT_MS = 15 * 60 * 1000;

async function main() {
  // Installed-app flow: loopback redirect on an ephemeral port. Desktop-app
  // OAuth clients accept any http://localhost:PORT redirect.
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const redirectUri = `http://localhost:${server.address().port}`;

  const client = oauthClient(redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('Open this URL and consent as the test user:\n');
  console.log(authUrl);
  console.log(`\nListening on ${redirectUri} — waiting up to 15 min for the redirect...`);
  spawn('open', [authUrl], { stdio: 'ignore', detached: true }).unref();

  let timer;
  try {
    const code = await new Promise((resolve, reject) => {
      server.on('request', (req, res) => {
        const url = new URL(req.url, redirectUri);
        const err = url.searchParams.get('error');
        const got = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(err ? `consent failed: ${err}` : 'ship_this_draft: consent received. Close this tab.');
        if (err) reject(new Error(`consent denied at the Google screen: ${err}`));
        else if (got) resolve(got);
      });
      timer = setTimeout(
        () => reject(new Error('timed out waiting for consent (15 min) — re-run `node auth.js`')),
        CONSENT_TIMEOUT_MS,
      );
    });

    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      die('no refresh_token in response — revoke at myaccount.google.com/permissions and retry');
    }

    const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
    const missing = SCOPES.filter((s) => !granted.includes(s));
    console.log('\nscopes granted (echoed by Google):');
    granted.forEach((s) => console.log('  ', s));
    if (missing.length) {
      die(`consent screen returned without these scopes: ${missing.join(', ')}`);
    }

    writeFileSync(
      TOKEN_PATH,
      `${JSON.stringify({ refresh_token: tokens.refresh_token, scope: tokens.scope }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log('wrote token.json');
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

main().catch((e) => die(e.message));
