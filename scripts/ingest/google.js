// scripts/ingest/google.js
// Google access for the pipeline (ingestion, approvals, digest).
// Gmail read: gmail.readonly, domain-wide delegation impersonating GMAIL_USER.
// Gmail send: gmail.send, separate client with only that scope.
// Sheets: service account shared directly on the Sheet (no delegation).
'use strict';

const { google } = require('googleapis');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Retry reads and idempotent writes on rate limits / server errors.
// POST (append, send) is deliberately excluded so a retry can't duplicate rows or emails.
google.options({
  retry: true,
  retryConfig: {
    retry: 3,
    httpMethodsToRetry: ['GET', 'PUT'],
    statusCodesToRetry: [[429, 429], [500, 599]],
  },
});

let gmailClient;
let gmailSendClient;
let sheetsClient;
const headerCache = {};

function saKey() {
  const raw = process.env.GOOGLE_SA_KEY;
  if (!raw) throw new Error('GOOGLE_SA_KEY is not set');
  return JSON.parse(raw);
}

function spreadsheetId() {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error('SHEET_ID is not set');
  return id;
}

function gmail() {
  if (!gmailClient) {
    const key = saKey();
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [GMAIL_SCOPE],
      subject: process.env.GMAIL_USER,
    });
    gmailClient = google.gmail({ version: 'v1', auth });
  }
  return gmailClient;
}

function gmailSender() {
  if (!gmailSendClient) {
    const key = saKey();
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [GMAIL_SEND_SCOPE],
      subject: process.env.GMAIL_USER,
    });
    gmailSendClient = google.gmail({ version: 'v1', auth });
  }
  return gmailSendClient;
}

function sheets() {
  if (!sheetsClient) {
    const key = saKey();
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [SHEETS_SCOPE],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

/* ---------------------------------------------------------------- Gmail -- */

async function getLabelId(name) {
  const res = await gmail().users.labels.list({ userId: 'me' });
  const label = (res.data.labels || []).find(
    (l) => l.name.toLowerCase() === name.toLowerCase()
  );
  if (!label) throw new Error(`Gmail label "${name}" not found`);
  return label.id;
}

// All message IDs carrying the label, received after the given epoch second.
async function listMessageIds(labelName, afterEpochSeconds) {
  const labelId = await getLabelId(labelName);
  const ids = [];
  let pageToken;
  do {
    const res = await gmail().users.messages.list({
      userId: 'me',
      labelIds: [labelId],
      q: `after:${afterEpochSeconds}`,
      maxResults: 100,
      pageToken,
    });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

function decode(data) {
  return Buffer.from(data, 'base64url');
}

function headerValues(headers, name) {
  return headers
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value);
}

function header(headers, name) {
  return headerValues(headers, name)[0] || '';
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      const target = href.replace(/^mailto:/i, '');
      if (!text) return target;
      return text.includes(target) ? text : `${text} (${target})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&pound;/gi, '£')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function walkParts(part, out) {
  if (!part) return;
  const mime = (part.mimeType || '').toLowerCase();
  const body = part.body || {};
  if (part.filename || body.attachmentId) {
    out.attachments.push({
      partId: part.partId || '',
      filename: part.filename || '',
      mimeType: mime,
      size: body.size || 0,
      // attachmentId is NOT stable between API calls: use it only within this
      // run. Store partId + message ID in the Sheet instead.
      attachmentId: body.attachmentId || null,
      inlineData: body.data || null,
    });
  } else if (mime === 'text/plain' && body.data) {
    out.text.push(decode(body.data).toString('utf8'));
  } else if (mime === 'text/html' && body.data) {
    out.html.push(decode(body.data).toString('utf8'));
  }
  for (const p of part.parts || []) walkParts(p, out);
}

async function getMessage(id) {
  const res = await gmail().users.messages.get({ userId: 'me', id, format: 'full' });
  const msg = res.data;
  const headers = (msg.payload && msg.payload.headers) || [];
  const out = { text: [], html: [], attachments: [] };
  walkParts(msg.payload, out);

  const plain = out.text.join('\n').trim();
  const text = plain || htmlToText(out.html.join('\n'));
  const recipients = ['To', 'Cc', 'Delivered-To', 'X-Original-To', 'X-Forwarded-To']
    .flatMap((h) => headerValues(headers, h))
    .join(', ');

  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: Number(msg.internalDate),
    from: header(headers, 'From'),
    recipients,
    subject: header(headers, 'Subject'),
    rfcMessageId: header(headers, 'Message-ID'),
    text,
    attachments: out.attachments,
  };
}

async function getAttachmentData(messageId, att) {
  if (att.inlineData) return decode(att.inlineData);
  const res = await gmail().users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: att.attachmentId,
  });
  return decode(res.data.data);
}

function gmailLink(msg) {
  return msg.rfcMessageId
    ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(msg.rfcMessageId)}`
    : `https://mail.google.com/mail/u/0/#all/${msg.id}`;
}

// Header value, RFC 2047-encoded if it contains anything beyond plain ASCII.
function encodeHeader(s) {
  const v = String(s || '');
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function base64Lines(s) {
  return Buffer.from(String(s || ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

// Send one email (plain text + HTML) as GMAIL_USER. Returns the Gmail message ID.
// Not retried automatically, so a network blip can never send it twice.
async function sendMail({ to, subject, text, html, fromName }) {
  const user = process.env.GMAIL_USER;
  if (!user) throw new Error('GMAIL_USER is not set');
  const boundary = `lenches_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const from = fromName ? `${encodeHeader(fromName)} <${user}>` : user;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
  const res = await gmailSender().users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data.id;
}

/* --------------------------------------------------------------- Sheets -- */

function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function getValues(range) {
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range,
  });
  return res.data.values || [];
}

async function readHeaders(tab) {
  if (!headerCache[tab]) {
    const rows = await getValues(`'${tab}'!1:1`);
    headerCache[tab] = (rows[0] || []).map((h) => String(h).trim());
  }
  return headerCache[tab];
}

// Rows as objects keyed by header, each with _row (1-based Sheet row number).
async function readTable(tab) {
  const rows = await getValues(`'${tab}'!A1:AZ`);
  const headers = (rows[0] || []).map((h) => String(h).trim());
  headerCache[tab] = headers;
  return rows.slice(1).map((r, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, c) => { if (h) obj[h] = r[c] ?? ''; });
    return obj;
  });
}

// Settings tab: sources in A:C, key/value settings in E:F.
async function readSettings() {
  const rows = await getValues(`'Settings'!A1:F100`);
  const sources = [];
  const settings = {};
  rows.slice(1).forEach((r) => {
    const [source, match, mode, , key, value] = r.map((v) => String(v ?? '').trim());
    if (source && match) sources.push({ source, match: match.toLowerCase(), mode: (mode || 'approve').toLowerCase() });
    if (key) settings[key] = value;
  });
  return { sources, settings };
}

// Numeric tab ID (the #gid= part of a Sheet URL), for links straight to a row.
async function getSheetGid(tab) {
  const res = await sheets().spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: 'sheets.properties(sheetId,title)',
  });
  const s = (res.data.sheets || []).find((x) => x.properties.title === tab);
  return s ? s.properties.sheetId : null;
}

// RAW input: nothing from an email can ever be evaluated as a formula.
async function appendRows(tab, objects) {
  if (!objects.length) return;
  const headers = await readHeaders(tab);
  const values = objects.map((o) => headers.map((h) => (o[h] === undefined || o[h] === null ? '' : o[h])));
  await sheets().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${tab}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// Update only the given fields of one row. Fields with no matching header are ignored.
async function updateRow(tab, rowNumber, fields) {
  const headers = await readHeaders(tab);
  const data = Object.entries(fields)
    .filter(([k]) => headers.includes(k))
    .map(([k, v]) => ({
      range: `'${tab}'!${colLetter(headers.indexOf(k))}${rowNumber}`,
      values: [[v === undefined || v === null ? '' : v]],
    }));
  if (!data.length) return;
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { valueInputOption: 'RAW', data },
  });
}

module.exports = {
  listMessageIds,
  getMessage,
  getAttachmentData,
  gmailLink,
  sendMail,
  readTable,
  readSettings,
  getSheetGid,
  appendRows,
  updateRow,
  spreadsheetId,
};
