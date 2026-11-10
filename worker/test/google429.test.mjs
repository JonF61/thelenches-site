// The panel's Google calls wait and retry when a per-minute quota answers 429
// (e.g. Sheets reads while approving several items quickly), then give up.
import assert from 'node:assert/strict';
import { getValues, resetTokenCache, retry, RETRY_WAITS } from '../src/admin/google.js';

const key = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const env = { SHEET_ID: 'sheet1', GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: pem }) };

const waits = [];
retry.wait = async (ms) => { waits.push(ms); };

function mock(statuses, headers = {}) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    const s = statuses[Math.min(calls++, statuses.length - 1)];
    return s === 200
      ? new Response(JSON.stringify({ values: [['a']] }))
      : new Response('{"error":{"code":429}}', { status: s, headers });
  };
  return () => calls;
}

// Two 429s then success: waits 5s and 10s, returns the values.
resetTokenCache(); waits.length = 0;
let calls = mock([429, 429, 200]);
assert.deepEqual(await getValues(env, 'Pending!A1:B2'), [['a']]);
assert.equal(calls(), 3);
assert.deepEqual(waits, [5000, 10000]);

// Retry-After is honoured (capped at 30s).
resetTokenCache(); waits.length = 0;
mock([429, 200], { 'retry-after': '7' });
await getValues(env, 'Pending!A1');
assert.deepEqual(waits, [7000]);

// Still 429 after every retry: the error is thrown as before.
resetTokenCache(); waits.length = 0;
calls = mock([429]);
await assert.rejects(getValues(env, 'Pending!A1'), (e) => e.status === 429 && /HTTP 429/.test(e.message));
assert.equal(calls(), RETRY_WAITS.length + 1);

// Other errors are not retried.
resetTokenCache(); waits.length = 0;
calls = mock([403]);
await assert.rejects(getValues(env, 'Pending!A1'), (e) => e.status === 403);
assert.equal(calls(), 1);
assert.deepEqual(waits, []);

console.log('google429 ok');
