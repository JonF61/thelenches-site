// scripts/test-claudeusage.js — offline test of lib/claudeusage.js (no API, no Sheet).
'use strict';
const assert = require('assert');
const u = require('../lib/claudeusage');
const Anthropic = require('@anthropic-ai/sdk');

(async () => {
  // Prices and cost sums.
  assert.strictEqual(u.priceFor('claude-haiku-4-5-20251001').input, 1);
  assert.strictEqual(u.priceFor('something-new').input, 4, 'unknown models cost as Opus');
  // 1M input + 1M output on Opus 5.5 = $24; 1M cache reads = $0.20; 1M 5m writes = $5.
  assert.strictEqual(u.costOf('claude-opus-5-5', { input: 1e6, output: 1e6 }), 24);
  assert.strictEqual(u.costOf('claude-opus-5-5', { read: 1e6, write5m: 1e6 }), 5.2);
  assert.strictEqual(u.costOf('claude-opus-5-5', { write1h: 1e6 }), 8);

  // record() splits 1h writes from 5m writes and adds up per model.
  u.reset();
  u.record('claude-opus-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 100 } });
  u.record('claude-opus-5-5', { input_tokens: 10, output_tokens: 5 });
  u.record('claude-haiku-4-5', { input_tokens: 8, output_tokens: 1 });
  u.record('x', null);
  let r = u.rows({ job: 'Ingest', run: '42', at: 'T' });
  assert.strictEqual(r.length, 2);
  const opus = r.find((x) => x.model === 'claude-opus-5-5');
  assert.deepStrictEqual({ calls: opus.calls, input: opus.input, output: opus.output, cache_read: opus.cache_read, cache_write: opus.cache_write, job: opus.job, run: opus.run },
    { calls: 2, input: 110, output: 55, cache_read: 1000, cache_write: 300, job: 'Ingest', run: '42' });
  // 110*4 + 55*20 + 1000*0.2 + 200*5 + 100*8 = 440+1100+200+1000+800 = 3540 per 1e6
  assert.strictEqual(opus.cost_usd, '0.0035');

  // The SDK wrapper sees calls made through any client, including tool-call helpers.
  u.reset();
  assert.strictEqual(u.patchSdk(), true);
  assert.strictEqual(u.patchSdk(), false, 'wraps once');
  const fakeFetch = async () => new Response(JSON.stringify({
    id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  for (const C of [Anthropic, Anthropic.Anthropic, Anthropic.default].filter(Boolean)) {
    const client = new C({ apiKey: 'test', fetch: fakeFetch, maxRetries: 0 });
    const res = await client.messages.create({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(res.content[0].text, 'ok');
  }
  await new Promise((ok) => setImmediate(ok));
  r = u.rows({});
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].calls >= 2, true);
  assert.strictEqual(r[0].cache_read, 600 * r[0].calls);

  console.log('test-claudeusage: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
