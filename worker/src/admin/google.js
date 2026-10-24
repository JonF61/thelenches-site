// worker/src/admin/google.js
// Google APIs for the admin panel with the pipeline's service account (Worker secret
// GOOGLE_SA_KEY, the same JSON key as the GitHub secret). Access tokens come from a JWT
// signed with WebCrypto and are cached until shortly before they expire.
//   Sheets   read and write the Lenches Pipeline Sheet (SHEET_ID in wrangler.toml)
//   Drive    read-only, for Photos-tab images (the folder is already shared with the account)
//   Gmail    read-only, impersonating GMAIL_USER (Worker secret) through the same
//            domain-wide delegation the ingestion uses: Pending images are still
//            email attachments until publish.

import { bytesToB64url, jsonToB64url } from './b64.js';

const enc = new TextEncoder();
export const SCOPES = {
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

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

// The signed assertion exchanged for an access token (exported for tests).
export async function serviceAccountJwt(sa, scope, sub = '', nowS = Math.floor(Date.now() / 1000)) {
  const claims = { iss: sa.client_email, scope, aud: TOKEN_URL, iat: nowS, exp: nowS + 3600 };
  if (sub) claims.sub = sub;
  const body = `${jsonToB64url({ alg: 'RS256', typ: 'JWT' })}.${jsonToB64url(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa.private_key), enc.encode(body));
  return `${body}.${bytesToB64url(sig)}`;
}

export async function accessToken(env, scope, sub = '') {
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
