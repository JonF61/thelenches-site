// scripts/publish/index.js
// Regenerates src/_data/pipeline.json from approved and auto rows in Pending,
// and saves each item's image (resized WebP) the first time it is published.
// The stored part may be a photo, an iPhone HEIC or a 1-2 page PDF flyer:
// images.toRaster() turns it into a picture first (PDF = page 1).
// Each WebP also gets a JPEG copy (same name, .jpg) for the email newsletter:
// classic Outlook can't show WebP. Missing JPEGs are made from the WebP, so
// existing items are backfilled on the next run, including images used in src/items/ (hand-written).
// Each item carries "village" from the Pending village column, so the site's
// inLenches filter (lib/lenches.js) doesn't have to guess from the text.
// Idempotent: safe to run as often as you like; the workflow commits only if files changed.
// Edits made in the Sheet to a live row (title, summary, link, dates) flow through on the next run.
// Image overrides in the image_url cell: "none" = no image; clear a "failed: ..." cell to retry.
// Body: the rewrite (summary) or the submitter's own wording (own_text), per lib/wording.js.
// Two lists only: events and notices. Rows still categorised "news" (before 21 Oct 2026)
// are notices. Notices carry "added" (approval date, for the home page's "new this week"),
// "official": true from the Pending official column (site badge), and "source" for
// Evesham Journal signposts (lib/sources.js).
// Road items (one.network link, lib/roads.js) also carry "start" (event_date), "end" (Pending
// end_date, the works' last day) and "road" (Pending road, else guessed from the title), and
// stay listed until "end" if that is later than the usual expiry. Their roads are looked up
// once for the Roads page map and cached in src/_data/roadgeo.json (roadgeo.js), with any
// coordinates from Pending road_coords or the link used first.
// Suggested images (scripts/suggest): an item with no email image whose image_choice names an
// "Image suggestions" row gets that image on approval: an own photo is copied from
// src/images/photos, an organiser's or Pexels image is downloaded (scripts/suggest/web.js
// guards). Its caption goes to image_credit (and image_credit_url) unless already filled, and
// the item carries image.credit / image.creditUrl for the site and newsletter captions.
// image_choice "none" = no image.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const g = require('../ingest/google');
const { toRaster } = require('../ingest/images');
const { bodyOf, isOfficial } = require('../../lib/wording');
const { localSource } = require('../../lib/sources');
const { loadWhatson } = require('../../lib/whatson');
const { isRoad, guessRoad, parseCoords, coordsFromUrl } = require('../../lib/roads');
const { updateRoadGeo } = require('./roadgeo');
const { fetchImage } = require('../suggest/web');

const TZ = 'Europe/London';
const ROOT = path.join(__dirname, '..', '..');
const DATA_FILE = path.join(ROOT, 'src', '_data', 'pipeline.json');
const IMAGE_DIR = path.join(ROOT, 'src', 'images', 'items');
const PHOTO_DIR = path.join(ROOT, 'src', 'images', 'photos');
const SUGGESTIONS = 'Image suggestions';
const IMAGE_URL = '/images/items';
const IMAGE_EDGE = 1200;  // longest side, px
const NOTICE_DAYS = 21;   // notices show until their date, and for at least this long
const LIVE = new Set(['approved', 'auto']);

const londonDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
const str = (v) => String(v ?? '').trim();
const later = (a, b) => (a > b ? a : b);
const normTitle = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const safeUrl = (u) => (/^(https?:\/\/|mailto:)/i.test(str(u)) ? str(u) : '');

// Accepts 2026-10-15, 2026-10-15 09:30 or 15/10/2026 (in case the Sheet reformats).
function ymd(value) {
  const v = str(value);
  let m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Re-fetches the email (attachment IDs aren't stable) and finds the image by part ID.
async function saveImage(row) {
  const file = `${row.id}.webp`;
  const dest = path.join(IMAGE_DIR, file);
  if (!fs.existsSync(dest)) {
    const msg = await g.getMessage(str(row.message_id));
    const att = msg.attachments.find((a) => a.partId === str(row.image_part_id));
    if (!att) throw new Error(`image part ${row.image_part_id} not found in the email`);
    const raw = await g.getAttachmentData(msg.id, att);
    const { data: raster } = await toRaster(raw, att.mimeType, att.filename);
    if (!raster) throw new Error(`${att.filename || 'attachment'} can't be shown as an image`);
    await writeItemImage(row.id, raster);
  }
  return `${IMAGE_URL}/${file}`;
}

// Resized WebP of any image as /images/items/<id>.webp.
async function writeItemImage(id, raster) {
  const webp = await sharp(raster)
    .rotate()
    .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGE_DIR, `${id}.webp`), webp);
  console.log(`Image saved for ${id} (${Math.round(webp.length / 1024)} KB).`);
  return `${IMAGE_URL}/${id}.webp`;
}

// The image Jon chose in the panel's "Suggested images" strip (image_choice), saved as the
// item's own image. suggestions: Map id -> Image suggestions row, or null if the tab is unreadable.
async function chosenImage(row, suggestions) {
  const choice = str(row.image_choice);
  const s = suggestions && suggestions.get(choice);
  if (!s || str(s.item) !== str(row.id)) throw new Error(`suggestion ${choice} not found in the ${SUGGESTIONS} tab`);
  let raster;
  if (s.source === 'own') {
    const m = str(s.url).match(/^\/images\/photos\/([a-z0-9-]{1,150})\.webp$/);
    if (!m) throw new Error(`suggestion ${choice}: not one of our photos`);
    raster = fs.readFileSync(path.join(PHOTO_DIR, `${m[1]}.webp`));
  } else if (s.source === 'organiser' || s.source === 'library') {
    raster = (await fetchImage(str(s.url), { robots: s.source === 'organiser' })).buffer;
  } else {
    throw new Error(`suggestion ${choice} has no image`);
  }
  const url = await writeItemImage(row.id, raster);
  const fields = { image_url: url };
  if (!str(row.image_credit) && str(s.caption)) fields.image_credit = str(s.caption);
  if (!str(row.image_credit_url) && safeUrl(s.credit_url)) fields.image_credit_url = str(s.credit_url);
  if (!str(row.alt_text) && str(s.alt)) fields.alt_text = str(s.alt);
  return { url, fields };
}

// JPEG copy of a saved item WebP, for the newsletter. Only for our own
// /images/items/<id>.webp files; anything else (external URLs) is left alone.
async function ensureJpeg(url, id, failures) {
  const m = str(url).match(/^\/images\/items\/([A-Za-z0-9_-]{1,100})\.webp$/);
  if (!m) return;
  const src = path.join(IMAGE_DIR, `${m[1]}.webp`);
  const dest = path.join(IMAGE_DIR, `${m[1]}.jpg`);
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    const jpg = await sharp(src)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    fs.writeFileSync(dest, jpg);
    console.log(`JPEG copy saved for ${id} (${Math.round(jpg.length / 1024)} KB).`);
  } catch (err) {
    failures.push(`${id}: JPEG copy: ${String((err && err.message) || err)}`);
  }
}

async function imageFor(row, failures, suggestions) {
  const current = str(row.image_url);
  if (current.toLowerCase() === 'none' || current.startsWith('failed')) return '';
  if (current.startsWith('/') || /^https:\/\//i.test(current)) return current;
  const choice = str(row.image_choice);
  const chosen = !str(row.image_part_id) && choice && choice.toLowerCase() !== 'none';
  if (!chosen && (!str(row.image_part_id) || !str(row.message_id))) return '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(row.id)) return '';
  try {
    if (chosen) {
      const { url, fields } = await chosenImage(row, suggestions);
      await g.updateRow('Pending', row._row, fields);
      Object.assign(row, fields);
      return url;
    }
    const url = await saveImage(row);
    await g.updateRow('Pending', row._row, { image_url: url });
    return url;
  } catch (err) {
    const msg = String((err && err.message) || err);
    failures.push(`${row.id}: ${msg}`);
    // Recorded so the run fails (and emails you) once, not every two hours.
    await g.updateRow('Pending', row._row, { image_url: `failed: ${msg}`.slice(0, 200) });
    return '';
  }
}

async function main() {
  const today = londonDate(Date.now());
  const rows = (await g.readTable('Pending'))
    .filter((r) => LIVE.has(str(r.status).toLowerCase()) && str(r.title));

  // Later rows win, so a resubmitted item replaces the earlier copy on the site.
  const byKey = new Map();
  for (const r of rows) byKey.set(`${normTitle(r.title)}|${ymd(r.event_date)}`, r);

  const out = { events: [], notices: [] };
  const failures = [];
  // Only needed when an item has a chosen suggestion; a missing tab fails just those items.
  let suggestions = null;
  if (rows.some((r) => str(r.image_choice) && str(r.image_choice).toLowerCase() !== 'none')) {
    try {
      suggestions = new Map((await g.readTable(SUGGESTIONS)).map((s) => [str(s.id), s]));
    } catch (err) {
      console.warn(`${SUGGESTIONS} tab unreadable: ${err.message}`);
    }
  }
  const roadsWanted = [];

  for (const row of byKey.values()) {
    const date = ymd(row.event_date);
    const start = ymd(row.decided_at) || ymd(row.received) || today;
    const cat = str(row.category).toLowerCase();
    let list;
    let expires;
    if (cat === 'event' && date) {
      list = 'events';
      expires = date;
    } else {
      // notice, the old "news", or an event with no date
      list = 'notices';
      expires = later(date, addDays(start, NOTICE_DAYS));
    }
    const url = safeUrl(row.link_url);
    const road = isRoad({ link: { url } });
    const end = road ? ymd(row.end_date) : '';
    if (end) expires = later(expires, end);
    if (expires < today) continue;

    const item = { id: row.id, title: str(row.title), body: bodyOf(row) };
    if (date) item.date = date;
    const village = str(row.village);
    if (village) item.village = village;
    if (road) {
      const name = str(row.road) || guessRoad(item.title);
      if (date) item.start = date;
      if (end) item.end = end;
      if (name) item.road = name;
      roadsWanted.push({ road: name, village, coords: parseCoords(row.road_coords) || coordsFromUrl(url) });
    }
    item.expires = expires;
    if (list === 'notices') {
      item.added = start;
      if (isOfficial(row)) item.official = true;
      const source = localSource(row);
      if (source) item.source = source;
    }
    if (url) item.link = { text: str(row.link_text) || 'More details', url };
    const img = await imageFor(row, failures, suggestions);
    if (img) {
      item.image = { url: img, alt: str(row.alt_text) };
      if (str(row.image_credit)) item.image.credit = str(row.image_credit).slice(0, 120);
      if (item.image.credit && /^https:\/\//i.test(str(row.image_credit_url))) item.image.creditUrl = str(row.image_credit_url);
      await ensureJpeg(img, row.id, failures);
    }
    out[list].push({ item, start });
  }

  out.events.sort((a, b) => a.item.date.localeCompare(b.item.date) || a.item.title.localeCompare(b.item.title));
  out.notices.sort((a, b) => b.start.localeCompare(a.start));
  const data = {
    events: out.events.map((x) => x.item),
    notices: out.notices.map((x) => x.item),
  };

  // JPEG copies for hand-added src/items/ images too (the newsletter uses them).
  const whatson = loadWhatson({ all: true });
  for (const list of ['events', 'news', 'notices']) {
    for (const it of whatson[list] || []) {
      if (it && it.image && it.image.url) await ensureJpeg(it.image.url, `whatson: ${str(it.title)}`, failures);
    }
  }

  // Road geometry for the Roads page map, pipeline and hand-written road items alike.
  // Lookup problems are logged for fixing by hand but never fail the run (village pins instead).
  for (const it of loadWhatson().notices) {
    if (!isRoad(it)) continue;
    const name = str(it.road) || guessRoad(it.title);
    roadsWanted.push({ road: name, village: str(it.village), coords: coordsFromUrl(it.link && it.link.url) });
  }
  const geo = await updateRoadGeo(roadsWanted);
  if (geo.failed.length) console.warn(`Road map lookups to check by hand:\n${geo.failed.join('\n')}`);
  if (geo.changed) console.log('src/_data/roadgeo.json updated.');

  const json = `${JSON.stringify(data, null, 2)}\n`;
  const old = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '';
  if (json !== old) fs.writeFileSync(DATA_FILE, json);
  console.log(`${data.events.length} events, ${data.notices.length} notices`
    + `${json === old ? ' (unchanged)' : ' (updated)'}.`);

  if (failures.length) {
    console.error(`Image failures (published without image):\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { imageFor, chosenImage };
