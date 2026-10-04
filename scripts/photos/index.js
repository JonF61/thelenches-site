// scripts/photos/index.js
// Drive photos (plan item 9). Run by .github/workflows/photos.yml.
//  1. Scan "Lenches Photos": new files become Photos rows. The folder path carries
//     meaning: <Village or General>/<Subject>/file; any "Rejected" folder = never
//     use; folders starting "_" are ignored. A file that disappears = missing.
//     Files saved by the Image fetch tab (event images from the web) get target,
//     credit and, for performer promo shots, people_ok pre-filled from that row.
//  2. Describe new rows: dHash (duplicates), Sonnet alt text, note, people and stock check.
//  3. Publish rows with status "approved": 1400px WebP + JPEG, all metadata
//     (GPS, EXIF) stripped, to src/images/photos/<slug>; anything else that is
//     live is removed. People/children/unknown need people_ok (yes/TRUE).
//  4. Rewrite src/_data/photos.json from what is live. The workflow commits.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const g = require('../ingest/google');
const { dHash, hashDistance } = require('../ingest/images');
const drive = require('./drive');
const { describePhoto } = require('./describe');

const TAB = 'Photos';
const WEB_TAB = 'Image fetch';
const REQUIRED = ['drive_id', 'path', 'village', 'subject', 'filename', 'drive_link', 'status', 'target',
  'alt_text', 'credit', 'people', 'people_ok', 'description', 'duplicate_of', 'taken_at', 'width', 'height',
  'slug', 'image_url', 'published_at', 'drive_modified', 'first_seen', 'dhash', 'notes'];
const REPO = path.resolve(__dirname, '..', '..');
const IMG_DIR = path.join(REPO, 'src', 'images', 'photos');
const DATA_FILE = path.join(REPO, 'src', '_data', 'photos.json');
const WEB_PATH = '/images/photos';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/tiff']);
const MAX_DESCRIBE = 25;            // Claude calls per run
const MAX_RENDER = 20;              // photos resized per run
const MAX_BYTES = 50 * 1024 * 1024;
const EDGE = 1400;                  // longest side published (4 Oct: was 1600)
const WEBP_QUALITY = 72;            // 4 Oct: was 80 (WebP came out larger than the JPEG)
const JPEG_QUALITY = 80;
const CLAUDE_EDGE = 1024;           // longest side sent to Claude
const DUP_DISTANCE = 6;             // dHash bits: same picture, resized or recompressed
const PAUSE_MS = 1100;              // keeps Sheets writes well under 60/min
const CONSENT_NEEDED = new Set(['identifiable', 'children', 'unknown']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const today = () => now().slice(0, 10);
const low = (v) => String(v ?? '').trim().toLowerCase();
const isTrue = (v) => ['true', 'yes', 'y'].includes(low(v));
const validHash = (h) => /^[0-9a-f]{16}$/.test(String(h || ''));

// Folder path -> meaning. "Rous Lench/Churches/x.jpg": village Rous Lench, subject Churches.
function meaning(segs) {
  const rejected = segs.some((s) => low(s) === 'rejected');
  const parts = segs.filter((s) => low(s) !== 'rejected');
  const village = parts[0] && low(parts[0]) !== 'general' ? parts[0] : '';
  return { rejected, village, subject: parts[1] || '', path: segs.join(' / ') };
}

// Drive's EXIF time "2014:07:07 10:53:11" -> "2014-07-07 10:53".
function exifTime(t) {
  const m = String(t || '').match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
}

function slugify(s) {
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 70).replace(/-+$/, '');
}

function uniqueSlug(row, used) {
  const stem = String(row.filename || 'photo').replace(/\.[^.]+$/, '');
  const base = slugify([row.village, row.subject, stem].filter(Boolean).join(' ')) || 'photo';
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

const fileFor = (slug, ext) => path.join(IMG_DIR, `${slug}.${ext}`);

async function render(buf, slug) {
  // sharp drops all metadata (EXIF, GPS, XMP) unless told to keep it.
  const base = sharp(buf, { failOn: 'none' })
    .rotate()
    .resize({ width: EDGE, height: EDGE, fit: 'inside', withoutEnlargement: true });
  await base.clone().webp({ quality: WEBP_QUALITY, effort: 5 }).toFile(fileFor(slug, 'webp'));
  await base.clone().flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toFile(fileFor(slug, 'jpg'));
}

// True if a published WebP is bigger than the current EDGE (rendered under older settings).
async function oversized(slug) {
  try {
    const meta = await sharp(fileFor(slug, 'webp')).metadata();
    return Math.max(meta.width || 0, meta.height || 0) > EDGE;
  } catch {
    return true;
  }
}

function removeFiles(slug) {
  if (!slug) return;
  for (const ext of ['webp', 'jpg']) {
    const f = fileFor(slug, ext);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// Image fetch rows saved to Drive, by Drive file ID. A missing tab only means no pre-fill.
async function webRows() {
  try {
    const out = new Map();
    for (const r of await g.readTable(WEB_TAB)) {
      const id = String(r.drive_file_id || '').trim();
      if (id && low(r.status) === 'saved') out.set(id, r);
    }
    return out;
  } catch (err) {
    console.log(`${WEB_TAB} tab not read (${err.message}): no pre-fill this run.`);
    return new Map();
  }
}

// Pre-fill for a new Photos row from its Image fetch row. Publishing still needs
// status approved; performer promo shots (no children) get people_ok yes (agreed 4 Oct).
function webPrefill(w) {
  const check = String(w.check || '');
  const performer = /performer=yes/.test(check) && !/people=children/.test(check);
  return {
    target: String(w.suggested_target || '').trim(),
    credit: String(w.credit || '').trim(),
    people_ok: performer ? 'yes' : '',
    notes: `From the web: ${check}`.slice(0, 300),
  };
}

// Sheet writes, one row per call, paced.
const pending = new Map();
function set(row, fields) {
  Object.assign(row, fields);
  pending.set(row._row, { ...(pending.get(row._row) || {}), ...fields });
}
async function flush() {
  for (const [rowNumber, fields] of pending) {
    await g.updateRow(TAB, rowNumber, fields);
    await sleep(PAUSE_MS);
  }
  pending.clear();
}

async function main() {
  const root = process.env.PHOTOS_FOLDER_ID;
  if (!root) throw new Error('PHOTOS_FOLDER_ID is not set');
  const headers = await drive.sheetHeaders(TAB).catch((err) => {
    throw new Error(`Can't read the "${TAB}" tab (does it exist?): ${err.message}`);
  });
  const missingHeaders = REQUIRED.filter((h) => !headers.includes(h));
  if (missingHeaders.length) throw new Error(`${TAB} tab is missing headers: ${missingHeaders.join(', ')}`);
  fs.mkdirSync(IMG_DIR, { recursive: true });

  let failures = 0;
  const stats = { added: 0, described: 0, published: 0, removed: 0 };

  /* ------------------------------------------------------------- 1. Scan -- */
  const files = await drive.walk(root);
  const byId = new Map(files.map((f) => [f.id, f]));
  let rows = await g.readTable(TAB);
  const web = await webRows();
  console.log(`Drive: ${files.length} file(s). Sheet: ${rows.length} row(s).`);

  // A failed or partial listing must never unpublish the library.
  const known = rows.filter((r) => r.drive_id && low(r.status) !== 'missing');
  const seen = known.filter((r) => byId.has(r.drive_id)).length;
  if (known.length >= 5 && seen < known.length / 2) {
    throw new Error(`Drive listing found only ${seen} of ${known.length} known photos: stopping so nothing is unpublished by mistake`);
  }

  const rowIds = new Set(rows.map((r) => r.drive_id).filter(Boolean));
  const added = [];
  for (const f of files) {
    if (rowIds.has(f.id)) continue;
    const m = meaning(f.segs);
    const mime = low(f.mimeType);
    const heic = /^image\/hei[cf]$/.test(mime) || /\.hei[cf]$/i.test(f.name);
    if (!IMAGE_TYPES.has(mime) && !heic) {
      console.log(`Ignored (not an image): ${m.path} / ${f.name} (${f.mimeType})`);
      continue;
    }
    const meta = f.imageMediaMetadata || {};
    const w = web.get(f.id);
    const pre = w ? webPrefill(w) : {};
    added.push({
      drive_id: f.id,
      path: m.path,
      village: m.village,
      subject: m.subject,
      filename: f.name,
      drive_link: f.webViewLink || '',
      status: m.rejected ? 'rejected' : heic ? 'unsupported' : 'new',
      taken_at: exifTime(meta.time),
      width: meta.width || '',
      height: meta.height || '',
      drive_modified: f.modifiedTime || '',
      first_seen: now(),
      ...pre,
      notes: heic ? "iPhone HEIC can't be read yet: save a JPEG copy into the same folder" : (pre.notes || ''),
    });
  }
  if (added.length) {
    await g.appendRows(TAB, added);
    stats.added = added.length;
    rows = await g.readTable(TAB);
  }

  for (const row of rows) {
    if (!row.drive_id) continue;
    const f = byId.get(row.drive_id);
    const st = low(row.status);
    if (!f) {
      if (st !== 'missing') set(row, { status: 'missing', notes: `${today()} not found in Drive (deleted, moved out, or in a _ folder)` });
      continue;
    }
    const m = meaning(f.segs);
    const fields = {};
    if (row.path !== m.path) Object.assign(fields, { path: m.path, village: m.village, subject: m.subject });
    if (row.filename !== f.name) fields.filename = f.name;
    if (f.modifiedTime && row.drive_modified !== f.modifiedTime) {
      Object.assign(fields, { drive_modified: f.modifiedTime, dhash: '' }); // edited in Drive: look again
    }
    if (st === 'missing') Object.assign(fields, { status: 'new', notes: `${today()} back in Drive` });
    if (m.rejected && st !== 'rejected') Object.assign(fields, { status: 'rejected', notes: `${today()} moved to a Rejected folder` });
    if (Object.keys(fields).length) set(row, fields);
  }
  await flush();

  /* --------------------------------------------------------- 2. Describe -- */
  for (const row of rows) {
    if (stats.described >= MAX_DESCRIBE) {
      console.log(`Describe cap (${MAX_DESCRIBE}) reached: the rest wait for the next run.`);
      break;
    }
    const st = low(row.status);
    if (!row.drive_id || row.dhash || ['rejected', 'missing', 'unsupported'].includes(st)) continue;
    const f = byId.get(row.drive_id);
    if (!f) continue;
    stats.described++;
    try {
      if (Number(f.size) > MAX_BYTES) {
        set(row, { dhash: 'too large', notes: `${today()} larger than 50 MB: save a smaller copy` });
        await flush();
        continue;
      }
      const buf = await drive.download(f);
      const hash = await dHash(buf);
      const dup = rows.find((o) => o !== row && validHash(o.dhash) && hashDistance(o.dhash, hash) <= DUP_DISTANCE);
      const fields = { dhash: hash, duplicate_of: dup ? `${dup.filename} (${dup.path || 'top level'})` : '' };
      const thumb = await sharp(buf, { failOn: 'none' })
        .rotate()
        .resize({ width: CLAUDE_EDGE, height: CLAUDE_EDGE, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80 })
        .toBuffer();
      try {
        const d = await describePhoto(thumb, { village: row.village, subject: row.subject });
        const fromWeb = web.has(row.drive_id);
        const notes = [
          fromWeb ? 'From the web' : '',
          d.kind === 'photo' ? '' : `Looks like a ${d.kind}`,
          d.stock === 'likely' ? 'Likely a stock photo' : d.stock === 'possible' ? 'Possibly a stock photo' : '',
        ];
        Object.assign(fields, { description: d.description, people: d.people });
        // Children always wait for Jon, even if people_ok was pre-filled for a performer.
        if (fromWeb && d.people === 'children' && isTrue(row.people_ok)) {
          fields.people_ok = '';
          notes.push('people_ok cleared: children visible');
        }
        fields.notes = notes.filter(Boolean).join('; ');
        if (!String(row.alt_text || '').trim()) fields.alt_text = d.alt_text;
      } catch (err) {
        failures++;
        Object.assign(fields, { people: 'unknown', notes: `${today()} description failed: ${err.message}`.slice(0, 300) });
      }
      set(row, fields);
    } catch (err) {
      failures++;
      set(row, { dhash: 'unreadable', notes: `${today()} couldn't read (clear dhash to retry): ${err.message}`.slice(0, 300) });
    }
    await flush();
  }

  /* ---------------------------------------------------------- 3. Publish -- */
  const used = new Set(rows.map((r) => r.slug).filter(Boolean));
  let rendered = 0;
  for (const row of rows) {
    if (!row.drive_id) continue;
    const f = byId.get(row.drive_id);
    const live = Boolean(row.published_at);
    const approved = low(row.status) === 'approved' && f && validHash(row.dhash);
    const blocked = approved && CONSENT_NEEDED.has(low(row.people)) && !isTrue(row.people_ok);

    if (approved && !blocked) {
      const slug = row.slug || uniqueSlug(row, used);
      const present = fs.existsSync(fileFor(slug, 'webp')) && fs.existsSync(fileFor(slug, 'jpg'));
      const stale = !live || !present || row.slug !== slug
        || (row.drive_modified && row.drive_modified > row.published_at)
        || (await oversized(slug));
      if (!stale) continue;
      if (rendered >= MAX_RENDER) {
        console.log(`Publish cap (${MAX_RENDER}) reached: the rest wait for the next run.`);
        continue;
      }
      rendered++;
      try {
        await render(await drive.download(f), slug);
        set(row, {
          slug,
          image_url: `${WEB_PATH}/${slug}.webp`,
          published_at: now(),
          notes: String(row.alt_text || '').trim() ? '' : `${today()} live without alt text: add some`,
        });
        stats.published++;
      } catch (err) {
        failures++;
        removeFiles(slug);
        set(row, { notes: `${today()} publish failed: ${err.message}`.slice(0, 300) });
      }
      await flush();
    } else if (live) {
      removeFiles(row.slug);
      set(row, {
        published_at: '',
        image_url: '',
        notes: blocked ? `${today()} taken down: put yes in people_ok to republish` : `${today()} taken down (status ${low(row.status) || 'blank'})`,
      });
      stats.removed++;
      await flush();
    } else if (blocked && !String(row.notes || '').includes('people_ok')) {
      set(row, { notes: `${today()} approved, but people = ${row.people}: put yes in people_ok once consent is confirmed` });
      await flush();
    }
  }

  /* -------------------------------------------------------- 4. Site data -- */
  const liveRows = rows
    .filter((r) => r.published_at && r.slug && fs.existsSync(fileFor(r.slug, 'webp')))
    .sort((a, b) => [a.village, a.subject, a.slug].join('|').localeCompare([b.village, b.subject, b.slug].join('|')));

  // Files in src/images/photos belong to this job alone: drop any no row claims.
  if (rows.length) {
    const keep = new Set(liveRows.map((r) => r.slug));
    for (const name of fs.readdirSync(IMG_DIR)) {
      const m = name.match(/^(.+)\.(webp|jpg)$/);
      if (m && !keep.has(m[1])) fs.unlinkSync(path.join(IMG_DIR, name));
    }
  }

  const entries = [];
  for (const r of liveRows) {
    const meta = await sharp(fileFor(r.slug, 'webp')).metadata();
    entries.push({
      slug: r.slug,
      src: `${WEB_PATH}/${r.slug}.webp`,
      jpg: `${WEB_PATH}/${r.slug}.jpg`,
      width: meta.width,
      height: meta.height,
      alt: String(r.alt_text || '').trim(),
      credit: String(r.credit || '').trim(),
      village: r.village || '',
      subject: r.subject || '',
      targets: String(r.target || '').split(/[,;]/).map((t) => low(t)).filter(Boolean),
      taken: String(r.taken_at || '').slice(0, 10),
    });
  }
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(entries, null, 2)}\n`);

  console.log(`Done. Added ${stats.added}, described ${stats.described}, published ${stats.published}, taken down ${stats.removed}, live ${entries.length}, failures ${failures}.`);
  if (failures) process.exitCode = 1; // GitHub emails me; the commit step still runs
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
