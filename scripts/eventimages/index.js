// scripts/eventimages/index.js
// Event images from the web (agreed 4 Oct). Run by .github/workflows/eventimages.yml.
// For upcoming events (whatson.json + pipeline.json, next 28 days) with a link but no
// image and no matching photos.json target, find the organiser's share image on the
// linked page (find.js), check it with Sonnet (check.js) and add a row to the
// "Image fetch" tab. Apps Script (image-fetch.gs) saves it to Drive; the Photos job
// describes it and pre-fills target/credit (and people_ok for performer promo shots).
// Nothing publishes until Jon sets the Photos row to approved.
// Events that yield nothing are recorded as status "skipped" so they aren't retried:
// delete the row to retry; for a skipped row that has a url, clear status to use it anyway.
'use strict';

const fs = require('fs');
const path = require('path');
const g = require('../ingest/google');
const { sheetHeaders } = require('../photos/drive');
const { findImage } = require('./find');
const { checkImage } = require('./check');

const TAB = 'Image fetch';
const REQUIRED = ['url', 'village', 'subject', 'filename', 'credit', 'source_page', 'status', 'notes',
  'event', 'suggested_target', 'found_via', 'check'];
const DATA = path.resolve(__dirname, '..', '..', 'src', '_data');
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 28);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 15);
const SAME_IMAGE_LIMIT = 3; // one image found for this many events = a site-wide default
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));
// Folder under Lenches Photos; anywhere else goes to General.
const PLACES = ['Church Lench', 'Rous Lench', 'Ab Lench', 'Atch Lench', 'Sheriffs Lench', 'Harvington',
  'Abbots Morton', 'Lenchwick', 'Radford', 'Evesham', 'Pershore', 'Inkberrow'];

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return null; }
}
function normUrl(s) {
  try {
    const u = new URL(String(s || '').trim());
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, '') + u.search;
  } catch {
    return '';
  }
}

const keyOf = (e) => `${String(e.date).slice(0, 10)}|${oneLine(e.title, 200)}`;
// Full title as the target, so a one-off image can't match other events. Commas and
// semicolons separate targets in the Photos tab, so they are dropped here.
const targetOf = (e) => `event:${oneLine(e.title, 200).toLowerCase().replace(/[,;]+/g, ' ').replace(/\s+/g, ' ')}`;

function villageFor(e) {
  const title = String(e.title || '');
  const m = title.match(/\s[—–-]\s([^—–]+)$/);
  const tail = m ? m[1].trim().toLowerCase() : '';
  return PLACES.find((p) => p.toLowerCase() === tail)
    || PLACES.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(`${title} ${e.body || ''}`))
    || 'General';
}

function filenameFor(e, ext) {
  const stem = oneLine(e.title, 200).replace(/[—–]/g, '-').replace(/[^\w .()&-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${String(e.date).slice(0, 10)} ${stem}`.slice(0, 90).trim() + `.${ext}`;
}

// Same test as the eventImage filter in .eleventy.js.
function covered(e, photos) {
  if (e.image && e.image.url) return true;
  const title = squash(e.title);
  return photos.some((p) => (p.targets || []).some((t) => {
    const k = String(t).startsWith('event:') ? squash(String(t).slice(6)) : '';
    return k && title.includes(k);
  }));
}

function creditFor(organiser, siteName, host) {
  const site = siteName || host.replace(/^www\./, '');
  if (!organiser) return site;
  const a = squash(organiser);
  const b = squash(site);
  return a.includes(b) || b.includes(a) ? organiser : `${organiser} via ${site}`;
}

async function main() {
  const headers = await sheetHeaders(TAB).catch((err) => {
    throw new Error(`Can't read the "${TAB}" tab: ${err.message}`);
  });
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`${TAB} tab is missing headers: ${missing.join(', ')}`);

  const existing = await g.readTable(TAB);
  const doneEvents = new Set(existing.map((r) => String(r.event || '').trim()).filter(Boolean));
  // Rows added by hand (no event column) are matched on their source page.
  const donePages = new Set(existing.filter((r) => !String(r.event || '').trim())
    .map((r) => normUrl(r.source_page)).filter(Boolean));
  const imageUses = new Map();
  for (const r of existing) {
    const u = String(r.url || '').trim();
    if (u) imageUses.set(u, (imageUses.get(u) || 0) + 1);
  }

  const whatson = readJson('whatson.json') || {};
  const pipeline = readJson('pipeline.json') || {};
  const photos = readJson('photos.json') || [];
  const from = ukToday();
  const to = addDays(from, WINDOW_DAYS);
  const seen = new Set();
  const events = [...(whatson.events || []), ...(pipeline.events || [])]
    .filter((e) => e && e.title && /^\d{4}-\d{2}-\d{2}/.test(String(e.date || '')))
    .filter((e) => { const d = String(e.date).slice(0, 10); return d >= from && d <= to; })
    .filter((e) => e.link && e.link.url && !covered(e, photos))
    .filter((e) => !doneEvents.has(keyOf(e)) && !donePages.has(normUrl(e.link.url)))
    .filter((e) => { const k = keyOf(e); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  console.log(`${events.length} event(s) need an image (${from} to ${to}); looking at up to ${MAX_EVENTS}.${DRY_RUN ? ' DRY RUN: nothing will be written.' : ''}`);

  /* ---------------------------------------------------- 1. Find images -- */
  const found = [];
  for (const e of events.slice(0, MAX_EVENTS)) {
    let r;
    try { r = await findImage(e.link.url); } catch (err) { r = { retry: err.message }; }
    found.push({ e, r });
    if (r.ok) imageUses.set(r.url, (imageUses.get(r.url) || 0) + 1);
  }

  /* ------------------------------------------- 2. Check and build rows -- */
  const today = ukToday();
  const rows = [];
  let queued = 0;
  let failures = 0;
  for (const { e, r } of found) {
    const base = {
      village: villageFor(e),
      subject: 'Events',
      source_page: e.link.url,
      event: keyOf(e),
      suggested_target: targetOf(e),
    };
    const skip = (reason, extra = {}) => {
      rows.push({ ...base, url: '', filename: '', credit: '', status: 'skipped', notes: `${today} ${reason}`.slice(0, 300), found_via: '', check: '', ...extra });
      console.log(`Skipped: ${e.title} (${reason})`);
    };

    if (r.retry) { console.log(`Try again tomorrow: ${e.title} (${r.retry})`); continue; }
    if (r.fail) { skip(r.fail); continue; }
    const host = new URL(r.finalUrl).hostname;
    const via = `${r.via} (${host})`;
    if ((imageUses.get(r.url) || 0) >= SAME_IMAGE_LIMIT) {
      skip('same image found for several events (site-wide default)', { url: r.url, found_via: via });
      continue;
    }

    let c;
    try {
      c = await checkImage(r.buffer, {
        title: e.title, date: String(e.date).slice(0, 10), pageTitle: r.page.title,
        siteName: r.page.siteName, host, imageUrl: r.url, text: r.page.text,
      });
    } catch (err) {
      failures++;
      console.log(`Check failed, try again tomorrow: ${e.title} (${err.message})`);
      continue;
    }
    const check = oneLine(`kind=${c.kind}; people=${c.people}; performer=${c.performer ? 'yes' : 'no'}; stock=${c.stock}; ${r.width}x${r.height}. ${c.reason}`, 300);
    const row = {
      ...base,
      url: r.url,
      filename: filenameFor(e, r.ext),
      credit: creditFor(c.organiser, r.page.siteName, host),
      status: '',
      notes: '',
      found_via: via,
      check,
    };
    const reason = ['logo', 'screenshot'].includes(c.kind) ? `Sonnet: looks like a ${c.kind}`
      : c.stock === 'likely' ? 'Sonnet: likely a stock photo'
        : !c.relevant ? 'Sonnet: not about this event' : '';
    if (reason) {
      rows.push({ ...row, status: 'skipped', notes: `${today} ${reason} (clear status to use it anyway)` });
      console.log(`Skipped: ${e.title} (${reason})`);
      continue;
    }
    rows.push(row);
    queued++;
    console.log(`Queued: ${e.title} <- ${r.url} [${check}]`);
  }

  if (DRY_RUN) {
    console.log('DRY RUN rows:');
    for (const row of rows) console.log(JSON.stringify(row));
  } else if (rows.length) {
    await g.appendRows(TAB, rows);
  }
  console.log(`Done. Queued ${queued}, skipped ${rows.length - queued}, check failures ${failures}.`);
  if (failures) process.exitCode = 1; // GitHub emails me
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
