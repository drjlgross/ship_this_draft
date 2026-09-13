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

function buildMime({ to, subject, body, filename, buffer }) {
  const boundary = `ship_${Date.now().toString(36)}`;
  const b64 = buffer.toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
    `--${boundary}`,
    `Content-Type: ${DOCX_MIME}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export async function createGmailDraft(auth, opts) {
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = Buffer.from(buildMime(opts)).toString('base64url');
  const { data } = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  if (!data.id) throw new Error('Gmail drafts.create returned no draft id');
  return data.id;
}
