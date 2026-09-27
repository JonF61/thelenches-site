// scripts/ingest/rss.js
// RSS feeds -> Claude (signpost mode) -> Pending tab. Called by index.js after the Gmail loop.
// Feeds are Settings source rows whose "match" is a URL; "mode" ignore disables a feed.
// Never fetches articles or images: only the feed text is used. No submitter replies.
// Each feed item is logged once in the Log tab as "rss:<hash of guid>".
'use strict';

const crypto = require('crypto');
const g = require('./google');
const { extract } = require('./extract');
const replies = require('./replies');

const MAX_FEED_ITEMS_PER_RUN = 10; // across all feeds; the rest wait for the next run
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'LenchesPipeline/1.0 (+https://thelenches.org.uk)';

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
      if (/^utm_/i.test(k) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(k.toLowerCase())) {
        u.searchParams.delete(k);
      }
    });
    return u.toString();
  } catch {
    return '';
  }
}

const logKey = (guid) => `rss:${crypto.createHash('sha1').update(guid).digest('hex').slice(0, 16)}`;

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ------------------------------------------------------------- process -- */

async function processItem(entry, ctx, h) {
  const { feed, item, key } = entry;
  const received = h.londonDateTime(item.publishedMs);
  const link = cleanLink(item.link);
  if (!link) throw new Error(`No usable link for "${item.title}"`);

  const result = await extract({
    signpost: true,
    feedItem: { title: item.title, published: received, text: item.text, link },
    sourceName: feed.source,
    receivedIso: received,
    today: ctx.today,
  });
  ctx.tokensIn += (result.usage && result.usage.input_tokens) || 0;
  ctx.tokensOut += (result.usage && result.usage.output_tokens) || 0;

  const id = key.replace(':', '-');
  const rows = result.items.map((it, n) => {
    const repeat = h.findRepeat(it, '', ctx.existing);
    const noteParts = [it.notes];
    if (repeat) noteParts.push(`Possible repeat of ${repeat.row.id} (same title/date)`);
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
      status: h.decideStatus(it, feed.mode, ctx.holiday),
      newsletter_count: repeat ? Number(repeat.row.newsletter_count) || 0 : 0,
      flyer_count: 0,
      message_id: key,
      notes: noteParts.filter(Boolean).join(' | '),
      thread_id: '', // no thread: replies.js never answers feed items
      missing: '',
    };
    row.policy_flags = replies.itemPolicy({ ...row, classified: it.classified }, item.publishedMs).join(',');
    return row;
  });

  if (rows.length) await g.appendRows('Pending', rows);
  rows.forEach((r) => ctx.existing.push(r));

  return {
    status: 'ok',
    received,
    source: feed.source,
    items: rows.length,
    error: rows.length ? '' : `No items: ${result.skipReason || 'not relevant'}`,
  };
}

// h: helpers from index.js { londonDateTime, findRepeat, decideStatus }.
// Returns { processed, failed, gaveUp, feedErrors }.
async function run(ctx, logById, startMs, h) {
  const feeds = ctx.sources.filter((s) => /^https?:\/\//i.test(s.match) && s.mode !== 'ignore');
  const out = { processed: 0, failed: 0, gaveUp: 0, feedErrors: 0 };
  if (!feeds.length) return out;

  const todo = [];
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
      todo.push({ feed, item, key });
      fresh += 1;
    }
    console.log(`RSS ${feed.source}: ${items.length} in feed, ${fresh} to process.`);
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

module.exports = { run, parseFeed, cleanLink, htmlToText };
