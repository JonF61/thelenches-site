// scripts/test-photos.js
// Offline test: the Drive photos walk (scripts/photos/drive.js) ignores "To delete"
// (filled by the admin panel) but still reports its files by ID, so their rows are
// marked rejected rather than missing; "_" folders and Rejected work as before; and
// folder meaning (photos/meaning.js), with new top-level folders as subjects.
// Drive is a stand-in; nothing leaves the machine. Run: node scripts/test-photos.js
'use strict';

const assert = require('assert');
const drive = require('./photos/drive');
const { meaning } = require('./photos/meaning');

const FOLDER = 'application/vnd.google-apps.folder';
const tree = {
  root: [
    { id: 'rl', name: 'Rous Lench', mimeType: FOLDER },
    { id: 'bin', name: 'To delete', mimeType: FOLDER },
    { id: 'draft', name: '_drafts', mimeType: FOLDER },
    { id: 'top', name: 'top.jpg', mimeType: 'image/jpeg' },
  ],
  rl: [
    { id: 'rlbin', name: 'To delete', mimeType: FOLDER }, // only the top-level one is special
    { id: 'church', name: 'church.jpg', mimeType: 'image/jpeg' },
  ],
  rlbin: [{ id: 'kept', name: 'kept.jpg', mimeType: 'image/jpeg' }],
  bin: [
    { id: 'dup1', name: 'dup1.jpg', mimeType: 'image/jpeg' },
    { id: 'binsub', name: '_old', mimeType: FOLDER },
  ],
  binsub: [{ id: 'dup2', name: 'dup2.jpg', mimeType: 'image/jpeg' }],
  draft: [{ id: 'hidden', name: 'hidden.jpg', mimeType: 'image/jpeg' }],
};

drive.setClient({
  files: {
    list: async ({ q }) => {
      const id = q.match(/^'([^']+)' in parents/)[1];
      return { data: { files: tree[id] || [] } };
    },
  },
});

(async () => {
  const files = await drive.walk('root');
  assert.deepStrictEqual(files.map((f) => f.id).sort(), ['church', 'kept', 'top']);
  assert.deepStrictEqual([...files.toDelete].sort(), ['dup1', 'dup2']);
  assert.deepStrictEqual(files.find((f) => f.id === 'church').segs, ['Rous Lench']);
  assert.deepStrictEqual(files.find((f) => f.id === 'kept').segs, ['Rous Lench', 'To delete']);

  // Folder meaning: places are villages, General has none, and a new top-level folder
  // made in Drive ("Amphitheatre", "Lenches Club") is a subject, never a village.
  const m = (p) => { const x = meaning(p.split('/').filter(Boolean)); return [x.village, x.subject, x.rejected]; };
  assert.deepStrictEqual(m('Rous Lench/Churches'), ['Rous Lench', 'Churches', false]);
  assert.deepStrictEqual(m('Abbots Lench'), ['Ab Lench', '', false]); // variant -> first name (lib/places.js)
  assert.deepStrictEqual(m('Bishampton/Events'), ['Bishampton', 'Events', false]);
  assert.deepStrictEqual(m('General/Events'), ['', 'Events', false]);
  assert.deepStrictEqual(m('Amphitheatre'), ['', 'Amphitheatre', false]);
  assert.deepStrictEqual(m('Amphitheatre/Shows 2026'), ['', 'Amphitheatre', false]);
  assert.deepStrictEqual(m('Lenches Club'), ['', 'Lenches Club', false]);
  assert.deepStrictEqual(m('Lenches Club/Rejected/Quiz'), ['', 'Lenches Club', true]);
  assert.deepStrictEqual(m(''), ['', '', false], 'top level of Lenches Photos');
  assert.strictEqual(meaning(['Lenches Club', 'Quiz']).path, 'Lenches Club / Quiz');
  console.log('test-photos: all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
