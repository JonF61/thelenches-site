// Test lib/webfetch.js against a local server that refuses Node's fetch (it sends
// sec-fetch-mode) but answers curl, as Wychavon's firewall did (27 Nov 2026).
'use strict';

const assert = require('assert');
const http = require('http');
const { webFetch, parseHeaders } = require('../lib/webfetch');

process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';

const server = http.createServer((req, res) => {
  const node = Boolean(req.headers['sec-fetch-mode']);
  if (req.url === '/open') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>open</p>'); }
  if (req.url === '/gone') { res.writeHead(404); return res.end('missing'); }
  if (req.url === '/both') { res.writeHead(403); return res.end('no'); }
  if (req.url === '/loop') { res.writeHead(307, { location: node ? '/loop' : '/page' }); return res.end(); }
  if (node) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('blocked'); }
  if (req.url === '/redir') { res.writeHead(302, { location: '/page' }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-ua': req.headers['user-agent'] || '' });
  res.end('<title>Planning</title>' + 'x'.repeat(5000));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const log = (s) => logs.push(s);
  const init = { headers: { 'User-Agent': 'test-agent/1.0', Accept: 'text/html' }, redirect: 'follow' };

  // Fetch works: no curl, no log.
  let r = await webFetch(`${base}/open`, init, { log });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), '<p>open</p>');
  assert.strictEqual(logs.length, 0);

  // Blocked for Node, curl reads it: body, headers, user agent, url.
  r = await webFetch(`${base}/page`, init, { log });
  assert.strictEqual(r.status, 200);
  assert.ok(r.ok);
  assert.match(await r.text(), /^<title>Planning<\/title>x{5000}$/);
  assert.strictEqual(r.headers.get('x-ua'), 'test-agent/1.0');
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.strictEqual(r.url, `${base}/page`);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /^webfetch: 127\.0\.0\.1:\d+ refused Node's fetch \(HTTP 403\); read with curl \(HTTP 200\)$/);

  // Redirects followed by curl; final url reported; stream readable (suggest/web.js reads it so).
  r = await webFetch(`${base}/redir`, init, { log });
  assert.strictEqual(r.url, `${base}/page`);
  const reader = r.body.getReader();
  let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
  assert.strictEqual(n, 5023);

  // A redirect loop for Node (fetch throws) falls back too.
  r = await webFetch(`${base}/loop`, init, { log });
  assert.strictEqual(r.status, 200);
  assert.match(logs[logs.length - 1], /refused Node's fetch \(.*redirect.*\)/i);

  // Not a block (404): fetch's answer, no curl.
  const before = logs.length;
  r = await webFetch(`${base}/gone`, init, { log });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(logs.length, before);

  // Refused by both: fetch's own answer, no log.
  r = await webFetch(`${base}/both`, init, { log });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(logs.length, before);

  // POST never falls back.
  r = await webFetch(`${base}/page`, { method: 'POST', body: 'a=1' }, { log });
  assert.strictEqual(r.status, 403);

  // curl cannot answer (no such server): fetch's 403 kept; fetch error rethrown.
  const fake = { fetchImpl: async () => new Response('no', { status: 503 }), curl: async () => { throw new Error('x'); }, log };
  assert.strictEqual((await webFetch(`${base}/page`, init, fake)).status, 503);
  await assert.rejects(webFetch('http://127.0.0.1:1/x', init, { log }), /fetch failed/);

  // A timeout never falls back (it would double the wait).
  let curled = false;
  const slow = { fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, curl: async () => { curled = true; }, log };
  await assert.rejects(webFetch(`${base}/page`, init, slow), /t/);
  assert.strictEqual(curled, false);

  // Header blocks: the last one after redirects.
  const h = parseHeaders('HTTP/1.1 302 Found\r\nLocation: /a\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n');
  assert.strictEqual(h.get('content-type'), 'text/plain');
  assert.strictEqual(h.get('location'), null);

  server.close();
  console.log('test-webfetch: all passed');
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
