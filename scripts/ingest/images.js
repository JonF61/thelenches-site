// scripts/ingest/images.js
// Picks usable images and PDFs from an email, prepares them for Claude, and
// computes a perceptual hash for repeat/flyer detection.
// Nothing is committed here: images are resized to WebP and committed only on
// approval (publish), using message ID + part ID stored in Pending.
// toRaster() turns any accepted attachment into something sharp can read:
//   JPEG/PNG/GIF/WebP as they are; iPhone HEIC/HEIF decoded to JPEG (heic-convert);
//   PDFs of 1-2 pages rendered as page 1 (mupdf), so a PDF flyer can be published.
// Longer PDFs (ARCH Messenger, minutes) stay text only. Shared with publish.
'use strict';

const sharp = require('sharp');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;  // for attachments sent as application/octet-stream
const MIN_IMAGE_BYTES = 5 * 1024;        // skips tracking pixels, icons, most signatures
const MIN_IMAGE_EDGE = 300;              // px on the longest side
const MAX_IMAGES = 8;                    // per email sent to Claude (rendered PDF pages count)
const MAX_PDFS = 2;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const CLAUDE_EDGE = 1568;                // longest side sent to Claude
const PDF_RENDER_MAX_PAGES = 2;          // only short PDFs (flyers) become images
const RASTER_EDGE = 1600;                // longest side of a rendered PDF page, px

// mupdf is ESM only and large (WebAssembly), so it is loaded on first use.
let mupdfLoad = null;
const loadMupdf = () => (mupdfLoad = mupdfLoad || import('mupdf'));
const free = (o) => { try { if (o && typeof o.destroy === 'function') o.destroy(); } catch (e) { /* ignore */ } };

// 'image', 'heic', 'pdf' or '' (not usable).
function kindOf(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(filename || '');
  if (IMAGE_TYPES.has(mime)) return 'image';
  if (/^image\/hei[cf]$/.test(mime) || /\.hei[cf]$/i.test(name)) return 'heic';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if ((!mime || mime === 'application/octet-stream') && IMAGE_EXT.test(name)) return 'image';
  return '';
}

async function heicToJpeg(buffer) {
  const convert = require('heic-convert');
  const out = await convert({ buffer, format: 'JPEG', quality: 0.92 });
  return Buffer.from(out);
}

// Page 1 of a short PDF as a PNG, about RASTER_EDGE px on the longest side.
// Returns { pages, data } with data null if the PDF is too long to treat as a flyer.
async function renderPdfPage1(buffer) {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  try {
    if (typeof doc.needsPassword === 'function' && doc.needsPassword()) {
      throw new Error('PDF is password protected');
    }
    const pages = doc.countPages();
    if (pages < 1 || pages > PDF_RENDER_MAX_PAGES) return { pages, data: null };
    const page = doc.loadPage(0);
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      const longest = Math.max(x1 - x0, y1 - y0) || 1;
      const scale = Math.min(RASTER_EDGE / longest, 8);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return { pages, data: Buffer.from(pix.asPNG()) };
      } finally {
        free(pix);
      }
    } finally {
      free(page);
    }
  } finally {
    free(doc);
  }
}

// Any accepted attachment -> { kind, data, pages? }. data is a Buffer sharp can read,
// or null when there is nothing to publish (unsupported type, PDF longer than 2 pages).
// Throws if a HEIC or PDF can't be decoded.
async function toRaster(buffer, mimeType, filename) {
  const kind = kindOf(mimeType, filename);
  if (kind === 'image') return { kind, data: buffer };
  if (kind === 'heic') return { kind, data: await heicToJpeg(buffer) };
  if (kind === 'pdf') {
    const r = await renderPdfPage1(buffer);
    return { kind, data: r.data, pages: r.pages };
  }
  return { kind, data: null };
}

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

// Raster -> JPEG for Claude plus hash, or null if too small to be a real picture.
// filename stays the attachment's own name (e.g. flyer.pdf), which also tells
// Claude that image came from the PDF.
async function forClaude(raster, att) {
  const meta = await sharp(raster).metadata();
  if (Math.max(meta.width || 0, meta.height || 0) < MIN_IMAGE_EDGE) return null;
  const data = await sharp(raster)
    .rotate()
    .resize({ width: CLAUDE_EDGE, height: CLAUDE_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return {
    filename: att.filename || '',
    partId: att.partId,
    mediaType: 'image/jpeg',
    data,
    hash: await dHash(raster),
  };
}

// attachments: from google.getMessage(); fetchData(att) returns a Buffer.
async function prepareAttachments(attachments, fetchData) {
  const images = [];
  const pdfs = [];
  const notes = [];

  for (const att of attachments || []) {
    const kind = kindOf(att.mimeType, att.filename);
    const name = att.filename || '(inline)';
    try {
      if (kind === 'image' || kind === 'heic') {
        if (kind === 'image' && att.size && att.size < MIN_IMAGE_BYTES) continue;
        if (images.length >= MAX_IMAGES) {
          notes.push(`Skipped image ${name}: more than ${MAX_IMAGES} images`);
          continue;
        }
        let raster;
        try {
          raster = (await toRaster(await fetchData(att), att.mimeType, att.filename)).data;
        } catch (err) {
          if (kind !== 'heic') throw err;
          notes.push(`Couldn't read ${name} (iPhone HEIC format): ${err.message}`);
          continue;
        }
        const img = await forClaude(raster, att);
        if (img) images.push(img);
      } else if (kind === 'pdf') {
        if (pdfs.length >= MAX_PDFS) {
          notes.push(`Skipped PDF ${name}: more than ${MAX_PDFS} PDFs`);
          continue;
        }
        if (att.size > MAX_PDF_BYTES) {
          notes.push(`Skipped PDF ${name}: larger than 25 MB`);
          continue;
        }
        const data = await fetchData(att);
        pdfs.push({ filename: att.filename || 'attachment.pdf', partId: att.partId, data });
        // Short PDFs (flyers) also become an image Claude can pick for an item.
        // A render failure only loses the image: the PDF's text still goes to Claude.
        if (images.length >= MAX_IMAGES) continue;
        try {
          const r = await toRaster(data, att.mimeType, att.filename);
          const img = r.data ? await forClaude(r.data, att) : null;
          if (img) images.push(img);
        } catch (err) {
          notes.push(`PDF ${name} used as text only (couldn't render it as an image: ${err.message})`);
        }
      }
    } catch (err) {
      notes.push(`Couldn't process ${name}: ${err.message}`);
    }
  }
  return { images, pdfs, notes };
}

module.exports = { prepareAttachments, toRaster, kindOf, dHash, hashDistance };
