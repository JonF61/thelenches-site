// scripts/ingest/rss.js
// RSS feeds -> Claude (signpost mode) -> Pending tab. Called by index.js after the Gmail loop.
// Feeds are Settings source rows whose "match" is a URL; "mode" ignore disables a feed.
// Never uses article wording: only the feed text. For non-newspaper feeds it reads the links on the item's own page (pagelinks.js) so a second link can be picked. No submitter replies.
// Each feed item is logged once in the Log tab as "rss:<hash of guid>".
// Local-news feeds (Evesham Journal): only stories that pass lib/sources.js keepLocalStory
// (naming our villages or nearby places, or a county-wide topic such as scams, burglaries,
// flooding, power cuts or the landline switchover) go to Claude (local mode: one-line notice);
// the rest are logged as "skipped" without a Claude call, so the daily diagnostic still sees
// them as handled.
// Already listed (3 Nov, duplicates.js): each feed item is checked as emailed ones are; a match
// stays pending with the banner and Add details. Roadworks alerts (one.network, published
// without Jon) aren't checked: repeats of those are caught by findRepeat.
'use strict';

const crypto = require('crypto');
const g = require('./google');
const { extract, holdRegular } = require('./extract');
const replies = require('./replies');
const trust = require('./trusted');
const itemFeedback = require('./itemfeedback');
const { LOCAL_FEED, keepLocalStory } = require('../../lib/sources');
const { pageInfo, USER_AGENT: PAGE_AGENT } = require('./pagelinks');
const dupes = require('./duplicates');

const MAX_FEED_ITEMS_PER_RUN = 10; // across all feeds; the rest wait for the next run
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'LenchesPipeline/1.0 (+https://thelenches.org.uk)';
// Tracking parameters removed from article links (plus any utm_*).
const TRACKING_PARAMS = ['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref'];

// Newsletters (25 Nov, Jon, after the Harvington PC November newsletter was written up as "read
// our newsletter"): when a non-newspaper feed item announces a newsletter, bulletin or magazine
// and its page carries a PDF, the PDF goes to Claude in newsletter mode (extract.js DIGEST) and
// each thing in it becomes its own item. If no PDF can be read the item fails (retried, then
// the run fails so GitHub emails Jon) rather than advertising the other newsletter.
const NEWSLETTER_RE = /\b(news ?letters?|bulletin|magazine|messenger|parish news)\b/i;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_TEXT_PAGES = 30;
const isNewsletterItem = (item) => NEWSLETTER_RE.test(`${item.title}\n${item.text}`);

async function fetchPdf(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': PAGE_AGENT, Accept: 'application/pdf,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_PDF_BYTES) throw new Error('over 25 MB');
  if (data.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF (blocked or a web page)');
  const filename = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() || 'newsletter.pdf');
  return { filename, data };
}

// The PDF's words, only to check a second link Claude takes from it is really written there.
async function pdfText(data) {
  try {
    const mupdf = await import('mupdf');
    const doc = mupdf.Document.openDocument(data, 'application/pdf');
    const n = Math.min(doc.countPages(), MAX_PDF_TEXT_PAGES);
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(doc.loadPage(i).toStructuredText().asText());
    return out.join('\n');
  } catch {
    return '';
  }
}

// The newsletter PDF for a feed item: the item's own link if it is a PDF, else the first PDF on
// its page that downloads. Returns { pdf, text } or throws with why none could be read.
async function newsletterPdf(link, pdfUrls, opts, pageProblem = '') {
  const urls = [...(/\.pdf(\?|$)/i.test(link) ? [link] : []), ...pdfUrls].slice(0, 3);
  if (!urls.length) throw new Error(`Newsletter PDF could not be read: no PDF found on its page${pageProblem ? ` (${pageProblem})` : ''}`);
  const why = [];
  for (const url of urls) {
    try {
      const pdf = await fetchPdf(url, opts);
      return { pdf, text: await pdfText(pdf.data) };
    } catch (err) {
      why.push((err && err.message) || String(err));
    }
  }
  throw new Error(`Newsletter PDF could not be read: ${why.join('; ')}`);
}

const isLocalFeed = (feed) => LOCAL_FEED.test(`${feed.source} ${feed.match}`);
const aboutPlaces = keepLocalStory;

/* ------------------------------------------------------------- parsing -- */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

const unCdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? unCdata(m[1]).trim() : '';
}

// HTML (already un-CDATA'd, possibly still entity-escaped) -> plain text.
function htmlToText(html) {
  let s = String(html || '');
  if (!/<[a-z]/i.test(s) && /&lt;[a-z]/i.test(s)) s = decodeEntities(s); // escaped HTML
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseFeed(xml) {
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const link = decodeEntities(tag(b, 'link'));
    const guid = decodeEntities(tag(b, 'guid')) || link;
    const content = tag(b, 'content:encoded') || tag(b, 'description');
    return {
      title: htmlToText(tag(b, 'title')),
      link,
      guid,
      publishedMs: Date.parse(tag(b, 'pubDate')),
      text: htmlToText(content),
    };
  }).filter((it) => it.guid && it.title);
}

// Keeps the real article URL, minus tracking parameters.
function cleanLink(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    [...u.searchParams.keys()].forEach((k) => {
      if (/^utm_/i.test(k) || TRACKING_PARAMS.includes(k.toLowerCase())) {
        u.searchParams.delete(k);
      }
    });
    return u.toString();
  } catch {
    return '';
  }
}

const logKey = (guid) => `rss:${crypto.createHash('sha1').update(guid).digest('hex').slice(0, 16)}`;

// Some sites refuse the feed-type Accept header with 406 or 415 (15 Nov: Harvington and
// South Lenches PCs); on those, ask once more with a plain Accept. Same honest User-Agent.
const FEED_ACCEPTS = ['application/rss+xml, application/xml;q=0.9, */*;q=0.8', '*/*'];
const RETRY_STATUS = new Set([406, 415]);

async function fetchFeed(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let last;
  for (const Accept of FEED_ACCEPTS) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.text();
    last = res.status;
    if (!RETRY_STATUS.has(res.status)) break;
  }
  throw new Error(`HTTP ${last}`);
}

/* ------------------------------------------------------------- process -- */

async function processItem(entry, ctx, h) {
  const { feed, item, key } = entry;
  const received = h.londonDateTime(item.publishedMs);
  const link = cleanLink(item.link);
  if (!link) throw new Error(`No usable link for "${item.title}"`);

  // Council and other non-newspaper feeds: the article's own links, for a second link (pagelinks.js).
  const page = isLocalFeed(feed) ? { links: [], pdfs: [] } : await pageInfo(link);
  const pageLinksFound = page.links;
  // A newsletter: read its PDF and list what's in it, never the newsletter itself.
  const nl = !isLocalFeed(feed) && isNewsletterItem(item) ? await newsletterPdf(link, page.pdfs, undefined, page.problem) : null;
  const result = await extract({
    signpost: true,
    local: isLocalFeed(feed),
    feedItem: {
      title: item.title, published: received, text: item.text, link, pageLinks: pageLinksFound,
      ...(nl ? { pdfs: [nl.pdf], pdfText: nl.text } : {}),
    },
    sourceName: feed.source,
    receivedIso: received,
    today: ctx.today,
  });
  ctx.tokensIn += (result.usage && result.usage.input_tokens) || 0;
  ctx.tokensOut += (result.usage && result.usage.output_tokens) || 0;

  const id = key.replace(':', '-');
  // Links Holly may add: only ones in the feed text, the article link or the article's own links.
  const given = [item.text, link, ...pageLinksFound.map((l) => l.url), nl ? nl.text : ''].join('\n');
  const listed = result.items.length ? dupes.listings(ctx.existing) : [];
  const found = [];
  const roadworks = (it) => /one\.network/i.test(String(it.link_url || ''));
  for (const it of result.items) found.push(roadworks(it) ? null : await dupes.check(it, listed, { messageId: key, text: given }));
  const rows = result.items.map((it, n) => {
    const repeat = h.findRepeat(it, '', ctx.existing);
    const noteParts = [it.notes];
    if (repeat) noteParts.push(`Possible repeat of ${repeat.row.id} (same title/date)`);
    // Trusted feed (Settings URL): published without approval unless a human is needed.
    let decided = trust.applyTrust(h.decideStatus(it, feed.mode, ctx.holiday), it,
      feed.match, ctx.trusted, { anonymous: false, outOfScope: result.outOfScope });
    if (decided.byTrust) noteParts.push('trusted');
    else if (decided.trustedSource) noteParts.push('trusted source');
    const dup = found[n];
    if (dup) {
      noteParts.push(dupes.noteFor(dup));
      decided = { ...decided, status: 'pending' }; // never published as a new item, in any mode
    }
    decided = holdRegular(it, decided, noteParts);
    if (it.holly_note) noteParts.push(`Holly: ${it.holly_note}`);
    if (nl) noteParts.push(`From the ${feed.source} newsletter (${nl.pdf.filename})`);
    const row = {
      id: `${id}-${n + 1}`,
      received,
      source: feed.source,
      from: feed.source,
      subject: item.title,
      title: it.title,
      event_date: it.event_date,
      event_time: it.event_time,
      village: it.village,
      category: it.category,
      summary: it.summary,
      cost: '',
      contact: '',
      link_text: it.link_text,
      link_url: it.link_url,
      link2_text: it.link2_text,
      link2_url: it.link2_url,
      confidence: it.confidence,
      urgent: it.urgent,
      people_in_image: false,
      political_commercial: it.political_commercial,
      possible_repeat: Boolean(repeat),
      image_part_id: '',
      image_filename: '',
      image_hash: '',
      alt_text: '',
      image_url: '',
      gmail_link: link, // "Original" in the digest opens the article
      status: decided.status,
      newsletter_count: repeat ? Number(repeat.row.newsletter_count) || 0 : 0,
      flyer_count: 0,
      message_id: key,
      notes: noteParts.filter(Boolean).join(' | '),
      thread_id: '', // no thread: replies.js never answers feed items
      missing: '',
      duplicate: dup ? JSON.stringify(dup) : '',
    };
    row.policy_flags = replies.itemPolicy({ ...row, classified: it.classified }, item.publishedMs).join(',');
    return row;
  });

  if (rows.length) await g.appendRows('Pending', rows);
  rows.forEach((r) => ctx.existing.push(r));
  await itemFeedback.record(rows); // Holly's drafts, for Jon's edits to teach her

  return {
    status: 'ok',
    received,
    source: feed.source,
    items: rows.length,
    error: rows.length ? (nl ? `Newsletter: ${rows.length} item(s) from ${nl.pdf.filename}` : '')
      : `No items: ${result.skipReason || 'not relevant'}`,
  };
}

// h: helpers from index.js { londonDateTime, findRepeat, decideStatus }.
// Returns { processed, failed, gaveUp, feedErrors, skipped }.
async function run(ctx, logById, startMs, h) {
  const feeds = ctx.sources.filter((s) => /^https?:\/\//i.test(s.match) && s.mode !== 'ignore');
  const out = { processed: 0, failed: 0, gaveUp: 0, feedErrors: 0, skipped: 0 };
  if (!feeds.length) return out;

  const todo = [];
  const skipped = [];
  for (const feed of feeds) {
    let items;
    try {
      items = parseFeed(await fetchFeed(feed.match));
    } catch (err) {
      // A wobbly council site shouldn't fail the run; the daily diagnostic spots silent feeds.
      out.feedErrors += 1;
      console.warn(`RSS ${feed.source}: fetch failed: ${(err && err.message) || err}`);
      continue;
    }
    let fresh = 0;
    for (const item of items) {
      if (!Number.isFinite(item.publishedMs) || item.publishedMs < startMs) continue;
      const key = logKey(item.guid);
      const r = logById.get(key);
      if (r && !(r.status === 'error' && (Number(r.retries) || 0) < MAX_RETRIES)) continue;
      if (isLocalFeed(feed) && !aboutPlaces(item)) {
        if (!r) skipped.push({ feed, item, key });
        continue;
      }
      todo.push({ feed, item, key });
      fresh += 1;
    }
    console.log(`RSS ${feed.source}: ${items.length} in feed, ${fresh} to process.`);
  }

  // Not about our villages: one Log row each, no Claude call, nothing in Pending.
  if (skipped.length) {
    const now = h.londonDateTime(Date.now());
    await g.appendRows('Log', skipped.map(({ feed, item, key }) => ({
      message_id: key,
      received: h.londonDateTime(item.publishedMs),
      processed_at: now,
      source: feed.source,
      status: 'skipped',
      items_created: 0,
      error: `Not about our area or a listed topic: ${item.title}`.slice(0, 500),
      retries: 0,
    })));
    out.skipped = skipped.length;
    console.log(`RSS: ${skipped.length} local-news item(s) skipped (not about our area or a listed topic).`);
  }

  todo.sort((a, b) => a.item.publishedMs - b.item.publishedMs); // oldest first
  const batch = todo.slice(0, MAX_FEED_ITEMS_PER_RUN);

  for (const entry of batch) {
    const prev = logById.get(entry.key);
    const prevRetries = prev ? Number(prev.retries) || 0 : 0;
    let outcome;
    try {
      outcome = await processItem(entry, ctx, h);
      outcome.retries = prevRetries;
      out.processed += 1;
    } catch (err) {
      const retries = prevRetries + 1;
      out.failed += 1;
      if (retries >= MAX_RETRIES) out.gaveUp += 1;
      outcome = {
        status: 'error',
        received: h.londonDateTime(entry.item.publishedMs),
        source: entry.feed.source,
        items: 0,
        error: String((err && err.message) || err).slice(0, 500),
        retries,
      };
    }
    const fields = {
      message_id: entry.key,
      received: outcome.received,
      processed_at: h.londonDateTime(Date.now()),
      source: outcome.source,
      status: outcome.status,
      items_created: outcome.items,
      error: outcome.error || `Feed item: ${entry.item.title}`.slice(0, 500),
      retries: outcome.retries,
    };
    if (prev) await g.updateRow('Log', prev._row, fields);
    else await g.appendRows('Log', [fields]);
    console.log(`${entry.key} (${entry.feed.source}): ${outcome.status}, ${outcome.items} item(s)${outcome.error ? ` — ${outcome.error}` : ''}`);
  }
  if (todo.length > batch.length) console.log(`RSS: ${todo.length - batch.length} left for the next run.`);
  return out;
}

module.exports = { run, fetchFeed, fetchPdf, newsletterPdf, isNewsletterItem, parseFeed, cleanLink, htmlToText, isLocalFeed, aboutPlaces, processItem };
