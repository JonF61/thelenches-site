// fetchFeed asks again with a plain Accept after a 406/415, and gives up on anything else.
const { fetchFeed } = require('./ingest/rss');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) fails += 1; };
const fake = (statuses) => {
  const seen = [];
  const impl = async (url, opts) => {
    seen.push(opts.headers);
    const status = statuses[seen.length - 1];
    return { ok: status === 200, status, text: async () => '<rss/>' };
  };
  return { impl, seen };
};
(async () => {
  let f = fake([200]);
  ok(await fetchFeed('u', { fetchImpl: f.impl }) === '<rss/>' && f.seen.length === 1, 'first try works');
  f = fake([415, 200]);
  ok(await fetchFeed('u', { fetchImpl: f.impl }) === '<rss/>' && f.seen[1].Accept === '*/*'
    && /^LenchesPipeline/.test(f.seen[1]['User-Agent']), '415 retried with plain Accept, same User-Agent');
  f = fake([415, 415]);
  await fetchFeed('u', { fetchImpl: f.impl }).then(() => ok(false, 'should throw'), (e) => ok(e.message === 'HTTP 415' && f.seen.length === 2, 'gives up after two'));
  f = fake([500]);
  await fetchFeed('u', { fetchImpl: f.impl }).then(() => ok(false, 'should throw'), (e) => ok(e.message === 'HTTP 500' && f.seen.length === 1, '500 not retried'));
  if (fails) process.exit(1);
})();
