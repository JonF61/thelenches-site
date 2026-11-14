// scripts/cartoon/sign.js
// Prepares a newsletter cartoon (11 Nov 2026, Jon): resizes the picture Jon made to 920px wide,
// stamps the "Dave" signature (dave-signature.png: Reenie Beanie, an SIL Open Font Licence
// font, rendered once) in the bottom-right corner and saves an Outlook-safe JPEG.
// Run by Kryten when adding a cartoon to src/_data/cartoons.json:
//   node scripts/cartoon/sign.js <picture.png|jpg> src/images/cartoons/<issue date>-<slug>.jpg
'use strict';

const path = require('path');
const sharp = require('sharp');

const WIDTH = 920;
const RIGHT = 18;  // gap from the right edge, px at 920 wide
const BOTTOM = 10; // gap from the bottom edge
const SIGNATURE = path.join(__dirname, 'dave-signature.png');

async function sign(input, output) {
  const base = await sharp(input).resize({ width: WIDTH }).flatten({ background: '#ffffff' }).toBuffer({ resolveWithObject: true });
  const sig = await sharp(SIGNATURE).metadata();
  const left = base.info.width - sig.width - RIGHT;
  const top = base.info.height - sig.height - BOTTOM;
  return sharp(base.data).composite([{ input: SIGNATURE, left, top }])
    .jpeg({ quality: 82, mozjpeg: true }).toFile(output);
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !/\.jpe?g$/i.test(output || '')) {
    console.error('Usage: node scripts/cartoon/sign.js <picture> <output.jpg>');
    process.exit(1);
  }
  sign(input, output).then((i) => console.log(`Signed: ${output} (${i.width}x${i.height}, ${Math.round(i.size / 1024)} KB)`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { sign };
