// worker/src/admin/b64.js
// base64url helpers for JWTs (Cloudflare Access in, Google service account out).

const enc = new TextEncoder();

export function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64url(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const jsonToB64url = (o) => bytesToB64url(enc.encode(JSON.stringify(o)));
export const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
