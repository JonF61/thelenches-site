// scripts/suggest/candidates.js
// Library candidates for a hand-written item (library-candidates.yml, run by hand): searches
// the picture library (Pexels, else Pixabay; library.js) for QUERY, typed by Kryten or Jon,
// never taken from an email. Each result is cropped to 3:2 (1200x800 JPEG, the news-column
// shape) into OUT_DIR with candidates.json (credit, page, licence), for Kryten to look at on
// the library-candidates branch and copy the chosen one into src/images/items.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { searchLibrary, librarySource } = require('./library');
const { fetchImage } = require('./web');

async function main() {
  const query = String(process.env.QUERY || '').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const n = Math.min(10, Math.max(3, Number(process.env.COUNT) || 6));
  const out = path.resolve(process.env.OUT_DIR || 'candidates');
  const lib = librarySource();
  if (!query) throw new Error('No QUERY');
  if (!lib) throw new Error('No PEXELS_API_KEY or PIXABAY_API_KEY');
  fs.mkdirSync(out, { recursive: true });
  const found = await searchLibrary(query, { provider: lib.provider, key: lib.key, n });
  const list = [];
  for (const [i, c] of found.entries()) {
    try {
      const img = await fetchImage(c.url, { robots: false });
      const file = `${i + 1}.jpg`;
      await sharp(img.buffer).rotate().resize(1200, 800, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toFile(path.join(out, file));
      list.push({ file, credit: c.credit, page: c.page, creditUrl: c.creditUrl, licence: c.licence, tags: c.text, size: `${img.width}x${img.height}` });
    } catch (err) {
      console.log(`${i + 1}: skipped (${err.message})`);
    }
  }
  fs.writeFileSync(path.join(out, 'candidates.json'), `${JSON.stringify({ query, library: lib.name, list }, null, 2)}\n`);
  console.log(`${lib.name} "${query}": ${list.length} of ${found.length} saved.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
