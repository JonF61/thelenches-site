// scripts/publish/index.js
// Regenerates src/_data/pipeline.json from approved and auto rows in Pending,
// and saves each item's image (resized WebP) the first time it is published.
// Idempotent: safe to run as often as you like; the workflow commits only if files changed.
// Edits made in the Sheet to a live row (title, summary, link, dates) flow through on the next run.
// Image overrides in the image_url cell: "none" = no image; clear a "failed: ..." cell to retry.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const g = require('../ingest/google');

const TZ = 'Europe/London';
const ROOT = path.join(__dirname, '..', '..');
const DATA_FILE = path.join(ROOT, 'src', '_data', 'pipeline.json');
const IMAGE_DIR = path.join(ROOT, 'src', 'images', 'items');
const IMAGE_URL = '/images/items';
const IMAGE_EDGE = 1200;  // longest side, px
const NEWS_DAYS = 14;     // news shows for this long after publication
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
    const webp = await sharp(raw)
      .rotate()
      .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(dest, webp);
    console.log(`Image saved for ${row.id} (${Math.round(webp.length / 1024)} KB).`);
  }
  return `${IMAGE_URL}/${file}`;
}

async function imageFor(row, failures) {
  const current = str(row.image_url);
  if (current.toLowerCase() === 'none' || current.startsWith('failed')) return '';
  if (current.startsWith('/') || /^https:\/\//i.test(current)) return current;
  if (!str(row.image_part_id) || !str(row.message_id)) return '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(row.id)) return '';
  try {
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

  const out = { events: [], news: [], notices: [] };
  const failures = [];

  for (const row of byKey.values()) {
    const date = ymd(row.event_date);
    const start = ymd(row.decided_at) || ymd(row.received) || today;
    const cat = str(row.category).toLowerCase();
    let list;
    let expires;
    if (cat === 'event' && date) {
      list = 'events';
      expires = date;
    } else if (cat === 'notice') {
      list = 'notices';
      expires = later(date, addDays(start, NOTICE_DAYS));
    } else {
      list = 'news';
      expires = addDays(start, NEWS_DAYS);
    }
    if (expires < today) continue;

    const item = { id: row.id, title: str(row.title), body: str(row.summary) };
    if (date) item.date = date;
    item.expires = expires;
    const url = safeUrl(row.link_url);
    if (url) item.link = { text: str(row.link_text) || 'More details', url };
    const img = await imageFor(row, failures);
    if (img) item.image = { url: img, alt: str(row.alt_text) };
    out[list].push({ item, start });
  }

  out.events.sort((a, b) => a.item.date.localeCompare(b.item.date) || a.item.title.localeCompare(b.item.title));
  out.news.sort((a, b) => b.start.localeCompare(a.start));
  out.notices.sort((a, b) => b.start.localeCompare(a.start));
  const data = {
    events: out.events.map((x) => x.item),
    news: out.news.map((x) => x.item),
    notices: out.notices.map((x) => x.item),
  };

  const json = `${JSON.stringify(data, null, 2)}\n`;
  const old = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '';
  if (json !== old) fs.writeFileSync(DATA_FILE, json);
  console.log(`${data.events.length} events, ${data.news.length} news, ${data.notices.length} notices`
    + `${json === old ? ' (unchanged)' : ' (updated)'}.`);

  if (failures.length) {
    console.error(`Image failures (published without image):\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
