// Google API retries (28 Nov): a Sheets 429 is retried with backoff long enough to
// outlast a per-minute quota, and only for GET/PUT (never append or send).
const assert = require('assert');
const http = require('http');
const { RETRY_CONFIG } = require('./ingest/google');
const { request } = require('gaxios');

// Delays gaxios will use: retryDelay first, then (multiplier^n - 1) / 2 seconds, capped.
const delays = [];
for (let n = 0; n < RETRY_CONFIG.retry; n++) {
  const base = n ? 0 : RETRY_CONFIG.retryDelay;
  delays.push(Math.min(base + ((RETRY_CONFIG.retryDelayMultiplier ** n - 1) / 2) * 1000, RETRY_CONFIG.maxRetryDelay));
}
const total = delays.reduce((a, b) => a + b, 0);
assert.ok(total >= 60000, `backoff should last at least a minute, got ${total}ms`);
assert.ok(total <= 120000, `backoff should stay under two minutes, got ${total}ms`);
assert.deepStrictEqual(RETRY_CONFIG.httpMethodsToRetry, ['GET', 'PUT']);
assert.ok(RETRY_CONFIG.statusCodesToRetry.some(([a, b]) => a <= 429 && 429 <= b));

// Real gaxios against a local server: two 429s, then success (delays shortened).
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (hits <= 2) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"quota"}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
});
server.listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const res = await request({ url, retry: true, retryConfig: { ...RETRY_CONFIG, retryDelay: 10, retryDelayMultiplier: 1.01, maxRetryDelay: 20 } });
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(hits, 3);
    hits = 0;
    await assert.rejects(request({ url, method: 'POST', retry: true, retryConfig: { ...RETRY_CONFIG, retryDelay: 10 } }));
    assert.strictEqual(hits, 1, 'POST must not be retried');
    console.log(`test-google-retry: ok (backoff ${Math.round(total / 1000)}s over ${RETRY_CONFIG.retry} retries)`);
  } finally { server.close(); }
});
