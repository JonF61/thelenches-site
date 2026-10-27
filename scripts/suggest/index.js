// scripts/suggest/index.js
// Suggested images for Pending events that arrived without one. Suggestions only: Jon
// chooses in the admin panel (Queue card, "Suggested images") and nothing is published,
// saved to Lenches Photos or sent from here. Writes rows to the "Image suggestions" tab only.
// Up to 3 per event, in this order:
//   1. Own photo: approved Lenches Photos images matching venue, village or subject (own.js),
//      at most 2, so an organiser's image still has room.
//   2. Organiser's site: og:image, else twitter:image, else a clear logo (organiser.js).
//   3. Library: Pexels, else Pixabay, by event type and kind of place only (library.js),
//      only if the PEXELS_API_KEY or PIXABAY_API_KEY secret is set.
// External images are checked by Sonnet (scripts/eventimages/check.js): children = dropped,
// people recorded, but only a failed check ("unknown") needs "People OK" to Choose: adults in
// an organiser's or library image are promotional (27 Oct); logos allowed only as the
// organiser's fallback, screenshots and unrelated images dropped.
// An event that gets nothing has one "none" row so it isn't tried again (delete it to retry).
// No image means: Pending status "pending", category event, dated today or later, not a
// feed item, and image_part_id, image_url and image_choice all blank (needsImage).
'use strict';

const fs = require('fs');
const path = require('path');
const g = require('../ingest/google');
const { isRssRow } = require('../../lib/sources');
const { ownMatches, eventPlace } = require('./own');
const { organiserImage } = require('./organiser');
const { libraryQuery, searchLibrary, librarySource } = require('./library');
const { fetchImage, thumbnail, hostOf } = require('./web');
const { checkImage } = require('../eventimages/check');
const { villageFor, creditFor, filenameFor, keyOf, targetOf } = require('../eventimages/index');

const TAB = 'Image suggestions';
const HEADERS = ['id', 'item', 'event', 'rank', 'source', 'url', 'page', 'credit', 'caption', 'credit_url', 'licence',
  'people', 'check', 'thumb', 'village', 'subject', 'filename', 'target', 'alt', 'status', 'created'];
const ROOT = path.resolve(__dirname, '..', '..');
const MAX_PER_EVENT = 3;
const MAX_OWN = 2;
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 10);
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));

const str = (v) => String(v ?? '').trim();
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const ymd = (v) => {
  const s = str(v);
  let m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

// A Pending row that is an upcoming event still waiting for a decision, with no image at all.
function needsImage(row, today) {
  if (str(row.status).toLowerCase() !== 'pending') return false;
  if (str(row.category).toLowerCase() !== 'event') return false;
  if (isRssRow(row)) return false;
  const date = ymd(row.event_date);
  if (!date || date < today) return false;
  return !str(row.image_part_id) && !str(row.image_url) && !str(row.image_choice);
}

// What the external-image check decides: { drop: reason } or { people }.
function judge(c, source) {
  if (c.people === 'children') return { drop: 'shows children' };
  if (c.kind === 'screenshot') return { drop: 'a screenshot' };
  if (c.kind === 'logo' && source !== 'logo') return { drop: 'a logo' };
  if (!c.relevant) return { drop: 'not about this event' };
  return { people: c.people === 'identifiable' || c.people === 'unknown' ? c.people : (c.people || '') };
}

const checkLine = (c, extra) => oneLine(`kind=${c.kind}; people=${c.people}; stock=${c.stock}; ${extra}. ${c.reason}`, 300);

async function suggestFor(row, ctx) {
  const ev = { date: ymd(row.event_date), title: str(row.title), summary: str(row.summary), body: str(row.summary), village: str(row.village) };
  const village = eventPlace(ev) || villageFor(ev) || 'General';
  const base = {
    item: row.id, event: keyOf(ev), village, subject: 'Events', target: targetOf(ev), status: '', created: ctx.today,
  };
  const out = [];
  const notes = [];

  // 1. Own photos.
  for (const m of ownMatches(ev, ctx.photos, ctx.people, MAX_OWN)) {
    const file = path.join(ROOT, 'src', m.photo.src);
    let thumb = '';
    try { thumb = await thumbnail(fs.readFileSync(file)); } catch { notes.push(`own ${m.photo.slug}: no local file`); continue; }
    out.push({
      ...base, source: 'own', url: m.photo.src, page: '', credit: str(m.photo.credit),
      caption: str(m.photo.credit) ? `Photo: ${str(m.photo.credit)}` : '', credit_url: '', licence: '',
      people: m.people, check: `score=${m.score}${m.photo.village ? `; ${m.photo.village}` : ''}${m.photo.subject ? ` / ${m.photo.subject}` : ''}`,
      thumb, filename: '', alt: str(m.photo.alt).slice(0, 125),
    });
  }

  // 2. Organiser's site.
  if (out.length < MAX_PER_EVENT) {
    const r = await organiserImage(row);
    if (r.image) {
      const host = hostOf(r.page);
      const c = await ctx.check(r.image.buffer, {
        title: ev.title, date: ev.date, pageTitle: r.info.title, siteName: r.info.siteName, host, imageUrl: r.url, text: r.info.text,
      });
      const j = judge(c, r.via);
      if (j.drop) notes.push(`organiser image dropped: ${j.drop}`);
      else {
        const credit = creditFor(c.organiser, r.info.siteName, host);
        out.push({
          ...base, source: 'organiser', url: r.url, page: r.page, credit, caption: `Image: ${credit}`, credit_url: r.page,
          licence: '', people: j.people, check: checkLine(c, `${r.via} (${host}) ${r.image.width}x${r.image.height}`),
          thumb: await thumbnail(r.image.buffer), filename: filenameFor(ev, r.image.ext), alt: '',
        });
      }
    } else if (r.tried && r.tried.length) notes.push(`organiser: ${r.tried.join('; ')}`);
  }

  // 3. Library (Pexels or Pixabay).
  const lib = ctx.library;
  if (out.length < MAX_PER_EVENT && lib) {
    const query = libraryQuery(ev);
    const found = query ? await searchLibrary(query, { provider: lib.provider, key: lib.key }) : [];
    for (const cand of found) {
      if (out.length >= MAX_PER_EVENT) break;
      let img;
      try { img = await fetchImage(cand.url, { robots: false }); } catch (err) { notes.push(`library: ${err.message}`); continue; }
      const c = await ctx.check(img.buffer, {
        title: ev.title, date: ev.date, pageTitle: `${lib.name} photo`, siteName: lib.name, host: `${lib.provider}.com`, imageUrl: cand.url, text: cand.text,
      });
      const j = judge(c, 'library');
      if (j.drop) { notes.push(`library image dropped: ${j.drop}`); continue; }
      out.push({
        ...base, source: 'library', url: cand.url, page: cand.page, credit: cand.short,
        caption: cand.credit, credit_url: cand.creditUrl, licence: cand.licence, people: j.people,
        check: checkLine(c, `${lib.name} "${query}" ${img.width}x${img.height}`), thumb: await thumbnail(img.buffer),
        filename: filenameFor(ev, img.ext), alt: cand.alt,
      });
    }
  }

  if (!out.length) {
    return [{ ...base, id: `${row.id}#0`, rank: 0, source: 'none', url: '', page: '', credit: '', caption: '', credit_url: '',
      licence: '', people: '', check: oneLine(notes.join(' | ') || 'nothing found', 300), thumb: '', filename: '', alt: '' }];
  }
  return out.map((s, i) => ({ ...s, id: `${row.id}#${i + 1}`, rank: i + 1 }));
}

async function main(opts = {}) {
  const headers = await g.readHeaders(TAB).catch((err) => {
    throw new Error(`Can't read the "${TAB}" tab: ${err.message}`);
  });
  const missing = HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`${TAB} tab is missing headers: ${missing.join(', ')}`);

  const today = ukToday();
  const done = new Set((await g.readTable(TAB)).map((r) => str(r.item)).filter(Boolean));
  const pending = await g.readTable('Pending');
  const todo = pending.filter((r) => needsImage(r, today) && !done.has(str(r.id)));
  let people = new Map();
  try {
    people = new Map((await g.readTable('Photos')).filter((r) => str(r.slug)).map((r) => [str(r.slug), str(r.people)]));
  } catch (err) { console.warn(`Photos tab unreadable, own photos ranked without people: ${err.message}`); }
  let photos = [];
  try { photos = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', '_data', 'photos.json'), 'utf8')); } catch { photos = []; }
  const library = opts.library !== undefined ? opts.library : librarySource();
  console.log(`${todo.length} Pending event(s) with no image; looking at up to ${MAX_ITEMS}.${library ? ` Library: ${library.name}.` : ' No PEXELS_API_KEY or PIXABAY_API_KEY: library skipped.'}${DRY_RUN ? ' DRY RUN.' : ''}`);

  const ctx = { today, photos, people, library, check: opts.check || checkImage };
  const rows = [];
  let failures = 0;
  for (const row of todo.slice(0, MAX_ITEMS)) {
    try {
      const got = await suggestFor(row, ctx);
      rows.push(...got);
      console.log(`${row.id} ${str(row.title)}: ${got.map((s) => s.source).join(', ')}${got[0].source === 'none' ? ` (${got[0].check})` : ''}`);
    } catch (err) {
      failures += 1; // nothing written for it: tried again next run
      console.error(`${row.id}: ${err.message}`);
    }
  }
  if (DRY_RUN) for (const r of rows) console.log(JSON.stringify({ ...r, thumb: r.thumb ? `${r.thumb.length} chars` : '' }));
  else if (rows.length) await g.appendRows(TAB, rows);
  console.log(`Done. ${rows.filter((r) => r.source !== 'none').length} suggestion(s), ${failures} failure(s).`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { needsImage, suggestFor, judge, main, HEADERS, TAB };
