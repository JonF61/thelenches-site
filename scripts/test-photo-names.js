// scripts/test-photo-names.js
// Offline test: suggested file names (photos/naming.js), the describe call's new
// fields, and a whole photos run (photos/index.js) on a copy of scripts/ in a temp
// folder, with Google Sheets, Drive and Claude as stand-ins: nothing leaves the
// machine and the real src/_data/photos.json is never touched.
// Run: node scripts/test-photo-names.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const naming = require('./photos/naming');

/* ------------------------------------------------------------ naming.js -- */
for (const n of ['IMG_1234.jpg', 'IMG-20260101-WA0003.jpg', 'PXL_20260412_101500123.jpg', 'DSC01234.JPG', 'DSCN0042.jpg',
  'WhatsApp Image 2026-05-01 at 10.12.33.jpeg', 'Screenshot 2026-05-01 at 10.12.33.png', 'Screen Shot 2021-06-11 at 15.12.50.png',
  '20260501_101233.jpg', '3f9a1c0b7d2e4f6a.jpg', '0b7d2e4f-1c3a-4b5c-9d8e-112233445566.jpg', 'image.jpg', 'image (1).jpg',
  'unnamed.jpg', 'P1010123.JPG', 'MVIMG_20260101_101010.jpg', 'Ab12Cd34Ef56Gh78Ij90.jpg', 'IMG_3113 (1).jpg']) {
  assert.ok(naming.machineName(n), `machine name: ${n}`);
}
for (const n of ['St Peter west door.jpg', 'All Saints Church Lench snow.jpg', 'Village hall harvest supper.jpeg',
  'General photo 01.jpg', 'Fete 2026.jpg', 'Bonfire night.jpg', 'gloquiz.png']) {
  assert.ok(!naming.machineName(n), `fine name: ${n}`);
}
assert.strictEqual(naming.cleanName('  Church: Lench / snow?.jpg \n'), 'Church Lench snow');
assert.strictEqual(naming.cleanName('x'.repeat(80)).length, 60);
assert.strictEqual(naming.suggestion('IMG_1.jpg', { name_fits: true, suggested_name: 'Church Lench snow' }), 'Church Lench snow');
assert.strictEqual(naming.suggestion('Fete.jpg', { name_fits: false, suggested_name: 'Ab Lench Road in snow' }), 'Ab Lench Road in snow');
assert.strictEqual(naming.suggestion('Fete.jpg', { name_fits: true, suggested_name: 'Village fete' }), '-');
assert.strictEqual(naming.suggestion('IMG_1.jpg', { name_fits: false, suggested_name: '' }), '-');
assert.strictEqual(naming.suggestion('Snow.jpg', { name_fits: false, suggested_name: 'snow' }), '-');

/* ----------------------------------------------------- the photos run -- */
const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-names-'));
fs.cpSync(path.join(REPO, 'scripts'), path.join(TMP, 'scripts'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'), 'dir');
fs.symlinkSync(path.join(REPO, 'lib'), path.join(TMP, 'lib'), 'dir');
fs.mkdirSync(path.join(TMP, 'src', '_data'), { recursive: true });

const HEADERS = ['drive_id', 'path', 'village', 'subject', 'filename', 'drive_link', 'status', 'target',
  'alt_text', 'credit', 'people', 'people_ok', 'description', 'duplicate_of', 'taken_at', 'width', 'height',
  'slug', 'image_url', 'published_at', 'drive_modified', 'first_seen', 'dhash', 'notes'];
const HASH = 'aaaaaaaaaaaaaaaa';

function stubs({ headers, rows, files, claude }) {
  const sheet = rows.map((r, i) => ({ _row: i + 2, ...r }));
  const writes = [];
  const asked = [];
  const google = {
    readTable: async (tab) => (tab === 'Photos' ? sheet.map((r) => ({ ...r })) : []),
    appendRows: async (tab, add) => { for (const r of add) sheet.push({ _row: sheet.length + 2, ...r }); },
    updateRow: async (tab, n, fields) => {
      const known = Object.fromEntries(Object.entries(fields).filter(([k]) => headers.includes(k)));
      writes.push({ n, fields: known });
      Object.assign(sheet.find((r) => r._row === n), known);
    },
  };
  const drive = {
    walk: async () => Object.assign(files.map((f) => ({ mimeType: 'image/jpeg', size: '1000', segs: ['Church Lench', 'Views'], ...f })), { toDelete: new Set() }),
    download: async (f) => images[f.id],
    sheetHeaders: async () => headers,
  };
  class Anthropic {
    constructor() { this.messages = { create: async (req) => {
      const text = req.messages[0].content[1].text;
      const name = text.match(/Current file name: (.*)/)[1];
      asked.push(name);
      return { content: [{ type: 'text', text: JSON.stringify({ alt_text: 'Snowy lane', description: 'A lane.', people: 'none', children: false, kind: 'photo', stock: 'unlikely', ...claude[name] }) }] };
    } }; }
  }
  return { google, drive, Anthropic, sheet, writes, asked };
}

const images = {};

async function run(opts) {
  const s = stubs(opts);
  const mod = (rel) => require.resolve(path.join(TMP, rel));
  for (const k of Object.keys(require.cache)) if (k.startsWith(TMP)) delete require.cache[k];
  require.cache[mod('scripts/ingest/google.js')] = { exports: s.google, loaded: true };
  require.cache[mod('scripts/photos/drive.js')] = { exports: s.drive, loaded: true };
  require.cache[require.resolve('@anthropic-ai/sdk', { paths: [path.join(TMP, 'scripts', 'photos')] })] = { exports: s.Anthropic, loaded: true };
  process.env.PHOTOS_FOLDER_ID = 'root';
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    require(path.join(TMP, 'scripts', 'photos', 'index.js'));
    for (let i = 0; i < 1200 && !lines.some((l) => l.startsWith('Done.')); i++) await new Promise((r) => setTimeout(r, 50));
  } finally { console.log = log; }
  assert.ok(lines.some((l) => l.startsWith('Done.')), `run finished:\n${lines.join('\n')}`);
  s.lines = lines;
  return s;
}

(async () => {
  const sharp = require('sharp');
  let i = 0;
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    images[id] = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40 * i, g: 200 - 30 * i++, b: 90 } } })
      .composite([{ input: Buffer.from(`<svg width="64" height="48"><rect x="${i * 8}" y="0" width="8" height="48" fill="#000"/></svg>`), left: 0, top: 0 }])
      .jpeg().toBuffer();
  }
  const files = [
    { id: 'a', name: 'IMG_1234.jpg' },               // new, camera name
    { id: 'b', name: 'St Peter west door.jpg' },     // new, fine
    { id: 'c', name: 'Fete.jpg' },                   // new, Claude says it doesn't fit
    { id: 'd', name: 'PXL_20260101_101010.jpg' },    // described before: looked at again
    { id: 'e', name: 'Lane in snow.jpg' },           // already checked
    { id: 'f', name: 'Bonfire night.jpg' },          // renamed since the last run
  ];
  const old = { path: 'Church Lench / Views', village: 'Church Lench', subject: 'Views', status: 'new', dhash: HASH };
  const rows = [
    { ...old, drive_id: 'd', filename: 'PXL_20260101_101010.jpg' },
    { ...old, drive_id: 'e', filename: 'Lane in snow.jpg', suggested_name: '-', dhash: 'bbbbbbbbbbbbbbbb' },
    { ...old, drive_id: 'f', filename: 'WhatsApp Image 2026-01-01.jpg', suggested_name: 'Old idea', dhash: 'cccccccccccccccc' },
  ];
  const claude = {
    'IMG_1234.jpg': { name_fits: true, suggested_name: 'Church Lench in snow' },
    'St Peter west door.jpg': { name_fits: true, suggested_name: 'Church door' },
    'Fete.jpg': { name_fits: false, suggested_name: 'Village hall harvest supper.jpg' },
    'PXL_20260101_101010.jpg': { name_fits: false, suggested_name: 'Ab Lench Road: in snow' },
  };

  const r1 = await run({ headers: [...HEADERS, 'suggested_name'], rows, files, claude });
  const by = (s, id) => s.sheet.find((r) => r.drive_id === id);
  assert.strictEqual(by(r1, 'a').suggested_name, 'Church Lench in snow');
  assert.strictEqual(by(r1, 'b').suggested_name, '-');
  assert.strictEqual(by(r1, 'c').suggested_name, 'Village hall harvest supper');
  assert.strictEqual(by(r1, 'd').suggested_name, 'Ab Lench Road in snow');
  assert.strictEqual(by(r1, 'd').description, undefined, 'older rows: only the name is written');
  assert.strictEqual(by(r1, 'e').suggested_name, '-');
  assert.strictEqual(by(r1, 'f').suggested_name, '-', 'a rename clears the suggestion');
  assert.strictEqual(by(r1, 'f').filename, 'Bonfire night.jpg');
  assert.deepStrictEqual(r1.asked.sort(), ['Fete.jpg', 'IMG_1234.jpg', 'PXL_20260101_101010.jpg', 'St Peter west door.jpg']);

  // Without the header: descriptions as before, no names, no extra calls.
  const r2 = await run({ headers: HEADERS, rows, files, claude });
  assert.ok(r2.lines.some((l) => l.includes('No suggested_name header')));
  assert.ok(r2.writes.every((w) => !('suggested_name' in w.fields)));
  assert.deepStrictEqual(r2.asked.sort(), ['Fete.jpg', 'IMG_1234.jpg', 'St Peter west door.jpg']);
  assert.strictEqual(by(r2, 'a').alt_text, 'Snowy lane');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('test-photo-names: all passed');
})().catch((err) => { console.error(err); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
