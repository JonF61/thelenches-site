// Newsletter feed items (25 Nov): a council's newsletter PDF is read and its contents listed,
// never the newsletter itself; an unreadable PDF fails the item rather than advertising it.
process.env.ANTHROPIC_API_KEY = 'x';
const assert = require('assert');
const { pdfsFromHtml } = require('./ingest/pagelinks.js');
const { buildFeedContent, toSignpost, DIGEST_MAX } = require('./ingest/extract.js');
const rss = require('./ingest/rss.js');

(async () => {
  // PDFs found as links and inside a viewer iframe, made absolute, de-duplicated.
  const page = `<article>${'x'.repeat(300)}<iframe src="/wp-content/plugins/pdf/viewer.html?file=https%3A%2F%2Fexample.gov.uk%2Fwp-content%2Fuploads%2F2026%2F11%2FNL.pdf"></iframe>
    <a href="https://example.gov.uk/wp-content/uploads/2026/11/NL.pdf">Download</a><a href="/files/other.pdf">o</a></article>`;
  assert.deepStrictEqual(pdfsFromHtml(page, 'https://example.gov.uk/news/a'),
    ['https://example.gov.uk/wp-content/uploads/2026/11/NL.pdf', 'https://example.gov.uk/files/other.pdf']);

  assert.ok(rss.isNewsletterItem({ title: 'Harvington Parish Council Newsletter (November 2026)', text: '' }));
  assert.ok(rss.isNewsletterItem({ title: 'November update', text: 'Read our latest bulletin' }));
  assert.ok(!rss.isNewsletterItem({ title: 'Emergency closure of Hughes Lane', text: 'Road closed' }));

  const pdfBytes = Buffer.from('%PDF-1.4\n% test\n');
  const fakeFetch = (map) => async (url) => {
    const r = map[url];
    if (!r) return { ok: false, status: 404 };
    return { ok: r.status === 200, status: r.status, url, arrayBuffer: async () => r.body };
  };
  // A challenge page (HTML, 403) then a real PDF: the second is used.
  const got = await rss.newsletterPdf('https://example.gov.uk/news/a', ['https://example.gov.uk/a.pdf', 'https://example.gov.uk/b%20c.pdf'], {
    fetchImpl: fakeFetch({
      'https://example.gov.uk/a.pdf': { status: 403, body: Buffer.from('<!DOCTYPE html>') },
      'https://example.gov.uk/b%20c.pdf': { status: 200, body: pdfBytes },
    }),
  });
  assert.strictEqual(got.pdf.filename, 'b c.pdf');
  assert.ok(got.pdf.data.equals(pdfBytes));
  // HTML served with 200 is refused too.
  await assert.rejects(rss.newsletterPdf('https://example.gov.uk/news/a', ['https://example.gov.uk/a.pdf'], {
    fetchImpl: fakeFetch({ 'https://example.gov.uk/a.pdf': { status: 200, body: Buffer.from('<!DOCTYPE html><title>Just a moment</title>') } }),
  }), /Newsletter PDF could not be read: not a PDF/);
  await assert.rejects(rss.newsletterPdf('https://example.gov.uk/news/a', [], {}), /no PDF found/);

  // The PDF goes to Claude as a document; several items are kept, each linked to the article.
  const content = buildFeedContent({ feedItem: { title: 'T', text: 'x', pdfs: [{ filename: 'NL.pdf', data: pdfBytes }] }, sourceName: 'PC', today: '2026-11-25' });
  assert.strictEqual(content[0].type, 'document');
  assert.strictEqual(content[0].source.media_type, 'application/pdf');
  assert.strictEqual(buildFeedContent({ feedItem: { title: 'T', text: 'x' }, sourceName: 'PC' })[0].type, 'text');
  const many = Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}`, summary: 'A thing.', category: 'event' }));
  const kept = toSignpost(many, 'Harvington PC', 'https://example.gov.uk/news/a', false, DIGEST_MAX);
  assert.strictEqual(kept.length, DIGEST_MAX);
  assert.ok(kept.every((k) => k.link_url === 'https://example.gov.uk/news/a' && k.official === false));
  assert.strictEqual(toSignpost(many, 'PC', 'u', false).length, 1);
  console.log('test-newsletter-feed: all passed');
})().catch((e) => { console.error(e); process.exit(1); });

// Why no PDF was found is named in the error (25 Nov: the first live run only said "no PDF found").
(async () => {
  await assert.rejects(rss.newsletterPdf('https://example.gov.uk/news/a', [], {}, 'page answered HTTP 403'),
    /no PDF found on its page \(page answered HTTP 403\)/);
  console.log('test-newsletter-feed: diagnostics passed');
})().catch((e) => { console.error(e); process.exit(1); });
