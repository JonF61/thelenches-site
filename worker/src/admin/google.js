// worker/src/admin/google.js
// Google APIs for the admin panel with its own service account (Worker secret
// GOOGLE_SA_KEY: lenches-admin-panel, not the pipeline's key, whose delegation includes
// gmail.send). Access tokens come from a JWT signed with WebCrypto and are cached until
// shortly before they expire. Only the scopes in ALLOWED_SCOPES can ever be requested,
// each only in its one mode (impersonating or as the account itself); anything else,
// gmail.send and gmail.modify included, is refused before anything is signed.
//   Sheets   read and write the Lenches Pipeline Sheet (SHEET_ID in wrangler.toml)
//   Drive    read-only, for Photos-tab images (the folder is already shared with the account);
//            full drive scope only for the panel's rename / move (photofiles.js),
//            as the account itself, never impersonating anyone: it reaches only what is
//            shared with it (Lenches Photos, as Editor), and photofiles.js refuses anything
//            outside that tree. drive.file would not do: it covers only files the app made.
//   Gmail    read-only, impersonating GMAIL_USER (Worker secret) through the same
//            domain-wide delegation the ingestion uses: Pending images are still
//            email attachments until publish.

import { bytesToB64url, jsonToB64url } from './b64.js';

const enc = new TextEncoder();
export const SCOPES = {
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
  driveWrite: 'https://www.googleapis.com/auth/drive',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};
// scope -> true: impersonation only (a sub is required); false: own identity only (no sub).
const ALLOWED_SCOPES = new Map([
  [SCOPES.gmail, true],
  [SCOPES.sheets, false],
  [SCOPES.drive, false],
  [SCOPES.driveWrite, false],
]);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
export const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

const tokens = new Map(); // `${scope}|${sub}` -> { token, exp }
const keyCache = { pem: '', key: null };

export function resetTokenCache() {
  tokens.clear();
  keyCache.pem = '';
  keyCache.key = null;
}

function serviceAccount(env) {
  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SA_KEY || '');
  } catch {
    throw new Error('GOOGLE_SA_KEY is missing or not valid JSON');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SA_KEY has no client_email or private_key');
  return sa;
}

async function signingKey(pem) {
  if (keyCache.pem === pem && keyCache.key) return keyCache.key;
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  keyCache.pem = pem;
  keyCache.key = key;
  return key;
}

// Throws unless the scope is on the allow-list and asked for in its own mode.
export function checkScope(scope, sub = '') {
  if (!ALLOWED_SCOPES.has(scope)) throw new Error(`Google scope not allowed: ${scope}`);
  if (ALLOWED_SCOPES.get(scope) && !sub) throw new Error(`Google scope ${scope} is for impersonation only`);
  if (!ALLOWED_SCOPES.get(scope) && sub) throw new Error(`Google scope ${scope} is for the account's own identity only`);
}

// The key's client_email, for the panel's Health screen ('' if the key is unreadable).
export function serviceAccountEmail(env) {
  try {
    return serviceAccount(env).client_email;
  } catch {
    return '';
  }
}

// The signed assertion exchanged for an access token (exported for tests).
export async function serviceAccountJwt(sa, scope, sub = '', nowS = Math.floor(Date.now() / 1000)) {
  checkScope(scope, sub);
  const claims = { iss: sa.client_email, scope, aud: TOKEN_URL, iat: nowS, exp: nowS + 3600 };
  if (sub) claims.sub = sub;
  const body = `${jsonToB64url({ alg: 'RS256', typ: 'JWT' })}.${jsonToB64url(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa.private_key), enc.encode(body));
  return `${body}.${bytesToB64url(sig)}`;
}

export async function accessToken(env, scope, sub = '') {
  checkScope(scope, sub);
  const id = `${scope}|${sub}`;
  const hit = tokens.get(id);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const sa = serviceAccount(env);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await serviceAccountJwt(sa, scope, sub),
    }),
  });
  if (!r.ok) throw new Error(`Google token: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  tokens.set(id, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

async function google(env, scope, url, init = {}, sub = '') {
  const token = await accessToken(env, scope, sub);
  const r = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const err = new Error(`Google API: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

/* --------------------------------------------------------------- Sheets -- */

const sheetId = (env) => {
  const id = String(env.SHEET_ID || '').trim();
  if (!id) throw new Error('SHEET_ID is not set');
  return id;
};

// Values as the scripts see them (formatted strings), rows padded to nothing.
export async function getValues(env, range) {
  const url = `${SHEETS}/${sheetId(env)}/values/${encodeURIComponent(range)}`;
  const r = await google(env, SCOPES.sheets, url);
  return (await r.json()).values || [];
}

// RAW input, as the scripts write: nothing typed can ever be evaluated as a formula.
export async function writeCells(env, data) {
  const url = `${SHEETS}/${sheetId(env)}/values:batchUpdate`;
  await google(env, SCOPES.sheets, url, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}

// New rows at the end of a tab (RAW, inserted, so nothing below is overwritten).
export async function appendValues(env, tab, rows) {
  const range = encodeURIComponent(`'${String(tab).replace(/'/g, "''")}'!A1`);
  const url = `${SHEETS}/${sheetId(env)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  await google(env, SCOPES.sheets, url, { method: 'POST', body: JSON.stringify({ values: rows }) });
}

// A new, empty tab at the end (no existing tab moves). Used for Feedback and Deleted contacts.
export async function addTab(env, title) {
  const url = `${SHEETS}/${sheetId(env)}:batchUpdate`;
  await google(env, SCOPES.sheets, url, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
}

// Removes one whole row (1-based) from the tab with this gid; rows below move up.
// Used only by the Contacts Delete (contacts.js), after re-checking the row's key.
export async function deleteRow(env, gid, row) {
  const url = `${SHEETS}/${sheetId(env)}:batchUpdate`;
  await google(env, SCOPES.sheets, url, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] }),
  });
}

// { tabTitle: gid } for links straight to a row.
export async function sheetGids(env) {
  const url = `${SHEETS}/${sheetId(env)}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`;
  const r = await google(env, SCOPES.sheets, url);
  const out = {};
  for (const s of (await r.json()).sheets || []) out[s.properties.title] = s.properties.sheetId;
  return out;
}

/* --------------------------------------------------------------- images -- */

// Only real raster images are ever served back to the browser (never HTML or SVG from
// someone's email), with nosniff so the browser can't reinterpret them.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function findPart(part, partId) {
  if (!part) return null;
  if (String(part.partId) === partId) return part;
  for (const p of part.parts || []) {
    const hit = findPart(p, partId);
    if (hit) return hit;
  }
  return null;
}

const b64urlBytes = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// One attachment of one message: { type, bytes }.
export async function gmailImage(env, messageId, partId) {
  const sub = String(env.GMAIL_USER || '').trim();
  if (!sub) throw new Error('GMAIL_USER is not set');
  const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`;
  const msg = await (await google(env, SCOPES.gmail, `${base}?format=full`, {}, sub)).json();
  const part = findPart(msg.payload, partId);
  if (!part) throw Object.assign(new Error('attachment not found'), { status: 404 });
  const type = String(part.mimeType || '').toLowerCase();
  if (!IMAGE_TYPES.includes(type)) throw Object.assign(new Error(`not an image (${type})`), { status: 415 });
  let data = part.body && part.body.data;
  if (!data && part.body && part.body.attachmentId) {
    const att = await (await google(env, SCOPES.gmail,
      `${base}/attachments/${encodeURIComponent(part.body.attachmentId)}`, {}, sub)).json();
    data = att.data;
  }
  if (!data) throw Object.assign(new Error('attachment empty'), { status: 404 });
  return { type, bytes: b64urlBytes(data) };
}

// Every image in one message (attachments and inline), so the panel can show them all
// next to the item: [{ partId, filename, type, size }].
export async function gmailImageParts(env, messageId) {
  const sub = String(env.GMAIL_USER || '').trim();
  if (!sub) throw new Error('GMAIL_USER is not set');
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
  const msg = await (await google(env, SCOPES.gmail, url, {}, sub)).json();
  const out = [];
  const walk = (part) => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    if (IMAGE_TYPES.includes(type) && part.partId) {
      out.push({ partId: String(part.partId), filename: part.filename || '', type, size: (part.body && part.body.size) || 0 });
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  return out;
}

// The text of one message, for the Replies screen ("their email"): { from, subject, date, text,
// more } (more: their signature block and earlier emails, folded by the panel).
// text/plain if there is one, else the HTML with its tags taken out; always shown as plain
// text by the panel (never as HTML). Capped at MAX_MAIL_TEXT characters.
const MAX_MAIL_TEXT = 8000;
const b64urlText = (s) => new TextDecoder().decode(b64urlBytes(s));
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Where their own words end: the first signature delimiter ("--"), quoted line (">"), "On …
// wrote:", forwarded/original-message header, Outlook rule or "Sent from my …" after some text.
// { text, more }: more = the rest (signature block, earlier emails), '' if none.
const CUT = [/^--\s*$/, /^>/, /^On\b.*\bwrote:\s*$/i, /^-{2,}\s*(Original|Forwarded) Message/i, /^_{8,}\s*$/, /^Sent from my /i];
export function splitSignature(text) {
  const lines = String(text || '').split('\n');
  let seen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const header = /^From:\s/.test(l) && lines.slice(i + 1, i + 4).some((x) => /^(Sent|Date|To|Subject):\s/.test(x));
    const wrote = /\bwrote:\s*$/.test(l) && /^On\b/.test(lines[i - 1] || '') && !lines[i - 1].includes('wrote:');
    if (seen && (header || CUT.some((re) => re.test(l)) || wrote)) {
      const at = wrote ? i - 1 : i;
      return { text: lines.slice(0, at).join('\n').trim(), more: lines.slice(at).join('\n').trim() };
    }
    if (l.trim()) seen = true;
  }
  return { text: String(text || '').trim(), more: '' };
}

export function messageText(msg) {
  const headers = Object.fromEntries(((msg.payload && msg.payload.headers) || []).map((x) => [String(x.name).toLowerCase(), String(x.value)]));
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    const data = part.body && part.body.data;
    if (data && !part.filename && type === 'text/plain' && !plain) plain = b64urlText(data);
    if (data && !part.filename && type === 'text/html' && !html) html = b64urlText(data);
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  const all = (plain ? plain.replace(/\r\n?/g, '\n').trim() : htmlToText(html)) || String(msg.snippet || '');
  const cap = (t) => (t.length > MAX_MAIL_TEXT ? `${t.slice(0, MAX_MAIL_TEXT)}…` : t);
  const { text, more } = splitSignature(all);
  return { from: headers.from || '', subject: headers.subject || '', date: headers.date || '', text: cap(text), more: cap(more) };
}
export async function gmailText(env, messageId) {
  const sub = String(env.GMAIL_USER || '').trim();
  if (!sub) throw new Error('GMAIL_USER is not set');
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
  return messageText(await (await google(env, SCOPES.gmail, url, {}, sub)).json());
}

// A contact's history (messages.js): up to `max` messages matching a Gmail search, each as
// messageText plus { id, to, auto (Auto-Submitted), internalDate }. Fetched in parallel.
export async function gmailSearchTexts(env, q, max = 25) {
  const sub = String(env.GMAIL_USER || '').trim();
  if (!sub) throw new Error('GMAIL_USER is not set');
  const list = await (await google(env, SCOPES.gmail,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, {}, sub)).json();
  const ids = (list.messages || []).map((m) => m.id).slice(0, max);
  return Promise.all(ids.map(async (id) => {
    const msg = await (await google(env, SCOPES.gmail,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {}, sub)).json();
    const h = Object.fromEntries(((msg.payload && msg.payload.headers) || []).map((x) => [String(x.name).toLowerCase(), String(x.value)]));
    return { ...messageText(msg), id, to: h.to || '', auto: h['auto-submitted'] || '', internalDate: msg.internalDate || '' };
  }));
}

// True if a Gmail search (in GMAIL_USER's mailbox) finds any message.
export async function gmailAny(env, q) {
  const sub = String(env.GMAIL_USER || '').trim();
  if (!sub) throw new Error('GMAIL_USER is not set');
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(q)}`;
  const j = await (await google(env, SCOPES.gmail, url, {}, sub)).json();
  return Array.isArray(j.messages) && j.messages.length > 0;
}

// A Drive image: Drive's own thumbnail (about `size` px on the long side) when it has
// one, else the file itself. { type, bytes }.
export async function driveImage(env, fileId, size = 0) {
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const meta = await (await google(env, SCOPES.drive,
    `${base}?fields=mimeType,thumbnailLink&supportsAllDrives=true`)).json();
  if (size && meta.thumbnailLink) {
    try {
      const r = await google(env, SCOPES.drive, String(meta.thumbnailLink).replace(/=s\d+$/, `=s${size}`));
      const type = String(r.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (IMAGE_TYPES.includes(type)) return { type, bytes: new Uint8Array(await r.arrayBuffer()) };
    } catch (e) {
      console.log(`Drive thumbnail for ${fileId} failed, serving the file: ${e.message}`);
    }
  }
  const type = String(meta.mimeType || '').toLowerCase();
  if (!IMAGE_TYPES.includes(type)) throw Object.assign(new Error(`not a web image (${type})`), { status: 415 });
  const r = await google(env, SCOPES.drive, `${base}?alt=media&supportsAllDrives=true`);
  return { type, bytes: new Uint8Array(await r.arrayBuffer()) };
}

/* ---------------------------------------------------------- Drive files -- */

// Drive metadata reads and the panel's file changes, as the service account itself (no
// sub). The only write is PATCH (rename, change of folder): POST (which would create files
// or folders owned by the account), DELETE, emptyTrash and "trashed" are refused here, so
// nothing can be created, binned or deleted.
export async function driveJson(env, path, { method = 'GET', body } = {}) {
  if (!['GET', 'PATCH'].includes(method)) throw new Error(`Drive ${method} is not allowed`);
  if (method !== 'GET' && (/trash/i.test(path) || (body && Object.keys(body).some((k) => /trash/i.test(k))))) {
    throw new Error('Drive: binning files is not allowed');
  }
  const scope = method === 'GET' ? SCOPES.drive : SCOPES.driveWrite;
  const sep = path.includes('?') ? '&' : '?';
  const r = await google(env, scope, `${DRIVE_FILES}${path}${sep}supportsAllDrives=true`, {
    method, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
}
