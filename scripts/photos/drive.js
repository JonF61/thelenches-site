// scripts/photos/drive.js
// Read-only Google access for the Drive photos job.
// Drive: the service account is shared directly on "Lenches Photos" as Viewer
// (no delegation), so drive.readonly reaches only what is shared with it.
'use strict';

const { google } = require('googleapis');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const SHEETS_READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'nextPageToken, files(id, name, mimeType, size, modifiedTime, resourceKey, webViewLink, imageMediaMetadata(width, height, time))';

let driveClient;
let sheetsClient;

function jwt(scope) {
  const raw = process.env.GOOGLE_SA_KEY;
  if (!raw) throw new Error('GOOGLE_SA_KEY is not set');
  const key = JSON.parse(raw);
  return new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: [scope] });
}

function drive() {
  if (!driveClient) driveClient = google.drive({ version: 'v3', auth: jwt(DRIVE_SCOPE) });
  return driveClient;
}

// Every file under rootId, each with segs = folder names from the root down.
// Folders whose name starts with "_" (drafts) are skipped with everything in them.
async function walk(rootId) {
  const files = [];
  const queue = [{ id: rootId, segs: [] }];
  while (queue.length) {
    const { id, segs } = queue.shift();
    let pageToken;
    do {
      const res = await drive().files.list({
        q: `'${id}' in parents and trashed = false`,
        fields: FIELDS,
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === FOLDER) {
          if (!String(f.name).startsWith('_')) queue.push({ id: f.id, segs: [...segs, f.name.trim()] });
        } else {
          files.push({ ...f, segs });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  return files;
}

// File bytes. Older files (pre-2021 link security update) may carry a resource key.
async function download(file) {
  const headers = file.resourceKey
    ? { 'X-Goog-Drive-Resource-Keys': `${file.id}/${file.resourceKey}` }
    : {};
  const res = await drive().files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer', headers }
  );
  return Buffer.from(res.data);
}

// Row 1 of a tab, so the job can refuse to run if headers are missing.
async function sheetHeaders(tab) {
  if (!sheetsClient) sheetsClient = google.sheets({ version: 'v4', auth: jwt(SHEETS_READ_SCOPE) });
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `'${tab}'!1:1`,
  });
  return ((res.data.values || [])[0] || []).map((h) => String(h).trim());
}

module.exports = { walk, download, sheetHeaders };
