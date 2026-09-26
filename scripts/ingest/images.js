// scripts/ingest/images.js
// Picks usable images and PDFs from an email, prepares them for Claude, and
// computes a perceptual hash for repeat/flyer detection.
// Nothing is committed here: images are resized to WebP and committed only on
// approval (step 5), using message ID + part ID stored in Pending.
'use strict';

const sharp = require('sharp');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
const MIN_IMAGE_BYTES = 5 * 1024;        // skips tracking pixels, icons, most signatures
const MIN_IMAGE_EDGE = 300;              // px on the longest side
const MAX_IMAGES = 8;                    // per email sent to Claude
const MAX_PDFS = 2;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const CLAUDE_EDGE = 1568;                // longest side sent to Claude

// 64-bit difference hash, as 16 hex characters.
async function dHash(buffer) {
  const data = await sharp(buffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

// Number of differing bits between two hashes (0 = identical, 64 = unrelated).
// Around 10 or fewer usually means the same picture, resized or recompressed.
function hashDistance(a, b) {
  const ok = (h) => /^[0-9a-f]{16}$/.test(String(h || ''));
  if (!ok(a) || !ok(b)) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// attachments: from google.getMessage(); fetchData(att) returns a Buffer.
async function prepareAttachments(attachments, fetchData) {
  const images = [];
  const pdfs = [];
  const notes = [];

  for (const att of attachments || []) {
    const mime = (att.mimeType || '').toLowerCase();
    const name = att.filename || '(inline)';
    try {
      if (IMAGE_TYPES.has(mime)) {
        if (att.size && att.size < MIN_IMAGE_BYTES) continue;
        if (images.length >= MAX_IMAGES) {
          notes.push(`Skipped image ${name}: more than ${MAX_IMAGES} images`);
          continue;
        }
        const raw = await fetchData(att);
        const meta = await sharp(raw).metadata();
        if (Math.max(meta.width || 0, meta.height || 0) < MIN_IMAGE_EDGE) continue;
        const data = await sharp(raw)
          .rotate()
          .resize({ width: CLAUDE_EDGE, height: CLAUDE_EDGE, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 85 })
          .toBuffer();
        images.push({
          filename: att.filename || '',
          partId: att.partId,
          mediaType: 'image/jpeg',
          data,
          hash: await dHash(raw),
        });
      } else if (mime === 'application/pdf' || /\.pdf$/i.test(att.filename || '')) {
        if (pdfs.length >= MAX_PDFS) {
          notes.push(`Skipped PDF ${name}: more than ${MAX_PDFS} PDFs`);
          continue;
        }
        if (att.size > MAX_PDF_BYTES) {
          notes.push(`Skipped PDF ${name}: larger than 25 MB`);
          continue;
        }
        pdfs.push({ filename: att.filename || 'attachment.pdf', partId: att.partId, data: await fetchData(att) });
      } else if (/^image\/hei[cf]$/.test(mime) || /\.hei[cf]$/i.test(att.filename || '')) {
        notes.push(`Couldn't read ${name} (iPhone HEIC format): ask the sender for a JPEG`);
      }
    } catch (err) {
      notes.push(`Couldn't process ${name}: ${err.message}`);
    }
  }
  return { images, pdfs, notes };
}

module.exports = { prepareAttachments, dHash, hashDistance };
