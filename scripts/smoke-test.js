// Offline smoke test for dependency upgrades (step 7F). Run by dependabot-check.yml
// on every PR into main, and by hand via its Run workflow button.
// Exercises the SDK, googleapis and sharp the way the pipeline uses them.
// No secrets and no real network calls: Claude is answered by a local mock server.
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const watchdog = setTimeout(() => { console.error('Smoke test timed out'); process.exit(1); }, 60000);
watchdog.unref();

// Minimal Messages API reply: one record_items tool call plus cache usage figures.
const MOCK_REPLY = {
  id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'tool_use', id: 'toolu_smoke', name: 'record_items', input: { items: [] } }],
  stop_reason: 'tool_use', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
};

// 1. Anthropic SDK: runs the real extract() (signpost mode) against the mock server,
//    so the real import line, client constructor, cached system prompt and response
//    parsing are all tested.
async function testSdk() {
  let seen = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(MOCK_REPLY));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // extract.js builds its client when loaded, so point it at the mock first.
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.ANTHROPIC_API_KEY = 'smoke-test';
    const { extract, stats } = require(path.join(ROOT, 'scripts/ingest/extract'));
    const out = await extract({
      signpost: true,
      feedItem: { title: 'Smoke test', published: '2026-10-01', text: 'Test item.', link: 'https://example.com/a' },
      sourceName: 'Smoke test',
      receivedIso: '2026-10-01T09:00:00Z',
      today: '2026-10-01',
    });
    assert.ok(seen, 'SDK made no request');
    assert.ok(seen.url.startsWith('/v1/messages'), `unexpected path ${seen.url}`);
    assert.deepStrictEqual(seen.body.system[0].cache_control, { type: 'ephemeral' }, 'cache_control not sent');
    assert.strictEqual(seen.body.tool_choice.name, 'record_items', 'tool_choice not sent');
    assert.ok(out && typeof out === 'object', 'extract() returned nothing');
    assert.strictEqual(stats.cacheRead, 7, 'cache_read_input_tokens not read');
    console.log('SDK OK (extract round trip, prompt caching fields)');
  } finally {
    server.close();
  }
}

// 2. googleapis: same JWT options shape as google.js (delegated Gmail) and the
//    diagnostic; checks the options are kept and the methods we call exist.
function testGoogle() {
  require(path.join(ROOT, 'scripts/ingest/google')); // the real module loads
  const { google } = require('googleapis');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const auth = new google.auth.JWT({
    email: 'smoke@example.iam.gserviceaccount.com',
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: 'jon@thelenches.org.uk',
  });
  assert.strictEqual(auth.email, 'smoke@example.iam.gserviceaccount.com', 'JWT email option ignored');
  assert.strictEqual(auth.subject, 'jon@thelenches.org.uk', 'JWT subject (delegation) ignored');
  const gmail = google.gmail({ version: 'v1', auth });
  for (const fn of [gmail.users.messages.list, gmail.users.messages.get, gmail.users.messages.send,
    gmail.users.messages.attachments.get, gmail.users.settings.sendAs.list]) {
    assert.strictEqual(typeof fn, 'function', 'a Gmail method is missing');
  }
  const sheets = google.sheets({ version: 'v4', auth });
  for (const fn of [sheets.spreadsheets.values.get, sheets.spreadsheets.values.update,
    sheets.spreadsheets.values.append, sheets.spreadsheets.values.batchUpdate]) {
    assert.strictEqual(typeof fn, 'function', 'a Sheets method is missing');
  }
  console.log('googleapis OK (JWT delegation options, Gmail and Sheets methods)');
}

// 3. sharp: the real dHash from images.js, the ingestion metadata/JPEG step and
//    the publish WebP resize chain.
async function testSharp() {
  const sharp = require('sharp');
  const { dHash, hashDistance } = require(path.join(ROOT, 'scripts/ingest/images'));
  const jpg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#6a8f3c' } })
    .jpeg({ quality: 85 }).toBuffer();
  const meta = await sharp(jpg).metadata();
  assert.strictEqual(meta.width, 1600, 'metadata width wrong');
  const h = await dHash(jpg);
  assert.ok(h && hashDistance(h, h) === 0, 'dHash failed');
  const webp = await sharp(jpg)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const wm = await sharp(webp).metadata();
  assert.strictEqual(wm.format, 'webp', 'publish output is not WebP');
  assert.strictEqual(wm.width, 1200, 'publish resize wrong');
  console.log('sharp OK (dHash, metadata, JPEG, WebP resize)');
}

(async () => {
  await testSdk();
  testGoogle();
  await testSharp();
  console.log('All smoke tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('Smoke test FAILED:', err);
  process.exit(1);
});
