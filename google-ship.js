import { Readable } from 'node:stream';
import { google } from 'googleapis';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FOLDER_NAME = 'ship_this_draft';

// Note: under drive.file this only sees folders THIS app created, which is
// exactly the reuse we want and all the scope permits.
async function ensureFolder(drive) {
  const q = [
    `name='${FOLDER_NAME}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "'root' in parents",
    'trashed=false',
  ].join(' and ');
  const { data } = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 10 });
  if (data.files.length > 0) return data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    fields: 'id',
  });
  return created.data.id;
}

export async function uploadToDrive(auth, { filename, buffer }) {
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await ensureFolder(drive);
  const { data } = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: DOCX_MIME, body: Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  if (!data.webViewLink) throw new Error('Drive upload returned no webViewLink');
  return data.webViewLink;
}

function buildMime({ recipients, subject, body }) {
  return [
    `To: ${recipients.join(', ')}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
    '',
  ].join('\r\n');
}

// `recipients` is the seam a later caller uses to address correspondence.
// Unprovided, it falls back to the single notify address from .env.
export async function createGmailDraft(auth, { recipients, subject, body }) {
  const to = recipients ?? [process.env.SHIP_NOTIFY_EMAIL];
  if (!Array.isArray(to) || to.length === 0 || to.some((r) => !r)) {
    throw new Error('Gmail draft: recipients must be a non-empty array of addresses');
  }
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = Buffer.from(buildMime({ recipients: to, subject, body })).toString('base64url');
  const { data } = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  if (!data.id) throw new Error('Gmail drafts.create returned no draft id');
  return data.id;
}
