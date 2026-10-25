// scripts/photos/naming.js
// Suggested file names for the Photos tab's suggested_name column. The admin panel
// pre-fills its New name box with the suggestion; nothing is ever renamed here.
//   ''   not checked yet (the photos run fills it, MAX_DESCRIBE a run)
//   '-'  checked: the current name is fine (also set when a file is renamed)
//   text a descriptive name, without the extension, for Jon to accept or change
// A name is replaced when it looks machine-made (camera, phone, WhatsApp, screenshot,
// hash) or when Claude says it doesn't match the picture.
'use strict';

const FINE = '-';

const MACHINE = [
  /^(img|pxl|dsc[fn]?|dcim|mvimg|vid|pict?|sam|gopr|dji|cimg|p|imag|photo|image|picture)[-_ ]?\d/i,
  /^(whatsapp|screenshot|screen[ _-]?shot|screen[ _-]?recording|snapshot|signal-|telegram|fb_img|received_|inshot|edited|capture|scan)\b/i,
  /^(untitled|download(ed)?|image|photo|picture|unnamed|file|attachment)$/i,
  /^[\d\s_.:-]+$/,                                    // only digits and date punctuation
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i,           // UUID
  /^[0-9a-f]{12,}$/i,                                 // hex hash
];

function stemOf(name) {
  return String(name ?? '').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

// True for names that say nothing about the picture.
function machineName(name) {
  const stem = stemOf(name).replace(/\s*\(\d+\)$/, '').replace(/[-_ ]copy$/i, '').trim();
  if (!stem) return true;
  if (MACHINE.some((re) => re.test(stem))) return true;
  // A long run of letters and digits with no separators: an id, not words.
  return /^[A-Za-z0-9_-]{16,}$/.test(stem) && (stem.match(/\d/g) || []).length >= 4;
}

// Claude's suggestion made safe for a Drive file name: one line, no extension, no
// characters the panel's rename would drop, at most 60 characters.
function cleanName(s) {
  return stemOf(String(s ?? '').replace(/\s+/g, ' '))
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

// The value for suggested_name from the current file name and describePhoto's reply.
function suggestion(filename, d) {
  if (!machineName(filename) && d.name_fits !== false) return FINE;
  const s = cleanName(d.suggested_name);
  return s && s.toLowerCase() !== stemOf(filename).toLowerCase() ? s : FINE;
}

module.exports = { FINE, machineName, cleanName, suggestion, stemOf };
