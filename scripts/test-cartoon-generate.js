// Offline test for scripts/cartoon/generate.js (OpenAI mocked): settings checks, the request it
// sends, signing every returned picture, and a refusal surfacing OpenAI's message.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const g = require('./cartoon/generate');

(async () => {
  let n = 0;
  const ok = (c, m) => { assert.ok(c, m); n++; };
  const env = { OPENAI_API_KEY: 'test', CARTOON_ISSUE: '2026-11-26', CARTOON_SLUG: 'frosty-bins', CARTOON_COUNT: '3' };

  ok(g.settings(env).model === 'gpt-image-2', 'default model');
  ok(g.settings({ ...env, CARTOON_MODEL: 'x' }).model === 'x', 'model override');
  for (const bad of [{ CARTOON_ISSUE: '26 Nov' }, { CARTOON_SLUG: 'Bad Slug' }, { CARTOON_SLUG: 'a;rm -rf' }, { CARTOON_COUNT: '9' }]) {
    assert.throws(() => g.settings({ ...env, ...bad })); n++;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoon-'));
  const promptFile = path.join(tmp, 'next-prompt.md');
  const template = fs.readFileSync(path.join(__dirname, 'cartoon', 'prompt.md'), 'utf8');
  fs.writeFileSync(promptFile, template.split('## Template')[1].split('## Jon')[0]);
  assert.throws(() => g.readPrompt(path.join(tmp, 'missing.md'))); n++;

  const png = (await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64');
  let sent;
  const fakeFetch = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body), auth: opts.headers.authorization };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png }, { b64_json: png }, { b64_json: png }] }) };
  };
  const outDir = path.join(tmp, 'out');
  const files = await g.main({ env, fetchImpl: fakeFetch, outDir, promptFile });
  ok(sent.url.endsWith('/v1/images/generations'), 'endpoint');
  ok(sent.body.n === 3 && sent.body.size === '1024x1024' && sent.body.quality === 'medium', 'request');
  ok(/Strict requirements:/.test(sent.body.prompt), 'prompt sent');
  ok(sent.auth === 'Bearer test', 'key in header');
  ok(files.map((f) => path.basename(f)).join() === ['a', 'b', 'c'].map((l) => `2026-11-26-frosty-bins-${l}-signed.jpg`).join(), 'file names');
  const meta = await sharp(files[0]).metadata();
  ok(meta.format === 'jpeg' && meta.width === 920, 'signed 920px JPEG');

  const refuse = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Organization must be verified' } }) });
  await assert.rejects(g.main({ env, fetchImpl: refuse, outDir, promptFile }), /verified/); n++;
  await assert.rejects(g.main({ env: { ...env, OPENAI_API_KEY: '' }, fetchImpl: fakeFetch, outDir, promptFile }), /OPENAI_API_KEY/); n++;

  console.log(`cartoon generate: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
