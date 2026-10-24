// worker/src/admin/photofiles.js
// Photos file management for the admin panel: rename, change of folder, and "Move to
// To delete" for duplicate copies. Drive calls go through google.js driveJson,
// as the service account itself (shared on Lenches Photos as Editor).
// Safety rules:
//   - every file or folder touched must sit under the Lenches Photos root
//     (PHOTOS_FOLDER_ID in wrangler.toml), found from one listing of the folders shared
//     with the account; anything else is refused
//   - only files with a Photos-tab row; never folders, never the root
//   - stale checks: rename carries the Drive name the page loaded, a move the folder it
//     loaded, a discard also the Photos status it loaded; any change since = 409, nothing written
//   - "delete" is a move to "To delete" directly under the root; nothing is ever binned or
//     deleted, Jon empties that folder himself. The photos run ignores it, and takes a
//     published photo whose file is there off the site on its next run.
//   - a move into To delete records where the file came from on the file itself (Drive
//     properties lenchesFrom, lenchesFromPath, lenchesMovedAt, lenchesStatus), so Restore
//     can put it back and set its Photos status back; files moved there by hand fall back
//     to the Photos tab's path (the run leaves it as it was)
//   - rejecting now always means To delete: a move into a "Rejected" folder is refused
//   - the panel never creates folders (To delete included): anything the account made would
//     belong to it, not to Jon, and would be at risk if the account were ever deleted.
//     Jon makes folders in Drive; the panel picks them up on Reload.
//   - a published copy needs a second, explicit confirm (confirmPublished) before it moves
//   - a rename never reuses a name: if any file under Lenches Photos (To delete included)
//     has the same core name and extension, it is saved as core-N (numberedName); checked
//     again at write time and once more after it, so two quick renames can't collide
// Renaming is safe for published photos too: the run fixes a photo's slug (its web
// address and committed file names) at first publish and keeps it, alt text is its own
// column, and nothing else reads the Drive name.

import { driveJson } from './google.js';
import { readTable, checkedWrite } from './sheet.js';
import { photoPages, pagesFor } from './photopages.js';

export const FOLDER = 'application/vnd.google-apps.folder';
export const TO_DELETE = 'To delete';
export const DUP_DISTANCE = 6;      // as scripts/photos/index.js
const MAX_STEM = 80;
const MAX_GROUP = 12;
const FILE_FIELDS = 'id,name,mimeType,parents,size,createdTime,trashed,properties,imageMediaMetadata(width,height)';
const REJECTED = 'rejected';
const PROP_MAX = 100; // Drive allows 124 bytes for key and value together

const low = (v) => String(v ?? '').trim().toLowerCase();
const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/* ---------------------------------------------------------------- names -- */

// Characters unsafe in paths or awkward in Drive and on disk become spaces; runs of
// spaces collapse; leading and trailing dots and spaces go.
export function cleanName(s, max) {
  return String(s ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, max)
    .replace(/[\s.]+$/, '');
}

export function splitExt(name) {
  const m = String(name).match(/^(.+?)(\.[A-Za-z0-9]{1,5})$/);
  return m ? { stem: m[1], ext: m[2] } : { stem: String(name), ext: '' };
}

// The new Drive name: what was typed, cleaned, with the current extension kept (a typed
// copy of it is dropped first). { name } or { error }.
export function newFileName(current, typed) {
  const { ext } = splitExt(current);
  let stem = String(typed ?? '').trim();
  if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length);
  stem = cleanName(stem, MAX_STEM);
  if (!stem) return { error: 'Type a name' };
  const name = stem + ext;
  if (name === current) return { error: 'That is already its name' };
  return { name };
}

// A name's parts for clash checks: core (no extension, no trailing -N of 1 to 3 digits,
// so camera names like IMG-3113 keep their number), N (null if
// none) and extension, core and extension in lower case for comparing.
export function nameParts(name) {
  const { stem, ext } = splitExt(name);
  const m = stem.match(/^(.+)-(\d{1,3})$/);
  const core = m ? m[1] : stem;
  return { core, num: m ? Number(m[2]) : null, ext, key: `${low(core)}\u0000${low(ext)}` };
}

// The name to save as: wanted itself if no other file (names, the renamed file left out)
// has its core and extension, else core-N with N one more than the highest in use
// (a plain core counts as 1; gaps are not filled).
export function numberedName(wanted, names) {
  const w = nameParts(wanted);
  const nums = names.map(nameParts).filter((p) => p.key === w.key).map((p) => p.num ?? 1);
  if (!nums.length) return wanted;
  return `${w.core}-${Math.max(...nums) + 1}${w.ext}`;
}

/* ---------------------------------------------------------------- folders -- */

const rootOf = (env) => {
  const id = String(env.PHOTOS_FOLDER_ID || '').trim();
  if (!id) throw new Error('PHOTOS_FOLDER_ID is not set');
  return id;
};

// Folders shared with the account, as [{ id, name, parents }] (paged).
async function listFolders(env) {
  const out = [];
  let page = '';
  for (let n = 0; n < 20; n += 1) {
    const q = encodeURIComponent(`mimeType = '${FOLDER}' and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,parents)');
    const j = await driveJson(env, `?q=${q}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    out.push(...(j.files || []));
    page = j.nextPageToken || '';
    if (!page) break;
  }
  return out;
}

// Folders under root only: Map id -> { id, name, parent, names (root down), toDelete }.
// A folder whose chain of parents doesn't reach root is left out, so it can never be used.
export function folderTree(rootId, folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const tree = new Map();
  const resolve = (id, seen = new Set()) => {
    if (tree.has(id)) return tree.get(id);
    const f = byId.get(id);
    if (!f || seen.has(id) || id === rootId) return null;
    seen.add(id);
    const parent = (f.parents || [])[0];
    let node = null;
    if (parent === rootId) {
      node = { id, name: f.name, parent, names: [f.name], toDelete: low(f.name) === low(TO_DELETE) };
    } else {
      const up = resolve(parent, seen);
      if (up) node = { id, name: f.name, parent, names: [...up.names, f.name], toDelete: up.toDelete };
    }
    if (node) tree.set(id, node);
    return node;
  };
  folders.forEach((f) => resolve(f.id));
  return tree;
}

const inRoot = (rootId, tree, id) => id === rootId || tree.has(id);
const pathOf = (rootId, tree, id) => (id === rootId ? 'Lenches Photos' : ['Lenches Photos', ...tree.get(id).names].join(' / '));
const childrenOf = (tree, parent) => [...tree.values()].filter((f) => f.parent === parent);
const relOf = (rootId, tree, id) => (id === rootId ? '' : tree.get(id).names.join(' / '));
// A "Rejected" folder anywhere on the way (the photos run's old "never use").
const inRejected = (rootId, tree, id) => id !== rootId && tree.has(id) && tree.get(id).names.some((n) => low(n) === REJECTED);

// Folders a photo can be moved to (never To delete or anything in it), sorted by path.
export function folderChoices(rootId, tree) {
  return [{ id: rootId, path: pathOf(rootId, tree, rootId) },
    ...[...tree.values()].filter((f) => !f.toDelete).map((f) => ({ id: f.id, path: pathOf(rootId, tree, f.id) }))
      .sort((a, b) => a.path.localeCompare(b.path))];
}

// Folders under root for the panel's Photos menu and drop targets (not To delete), live
// from Drive so a folder Jon makes appears on Reload: [{ id, parent, names }], by path.
// parent is the root's id for a top-level folder.
export async function folderList(env) {
  const { tree } = await loadTree(env);
  return [...tree.values()].filter((f) => !f.toDelete)
    .map((f) => ({ id: f.id, parent: f.parent, names: f.names.map((n) => String(n).trim()) }))
    .sort((a, b) => a.names.join(' / ').localeCompare(b.names.join(' / ')));
}

async function loadTree(env) {
  const root = rootOf(env);
  return { root, tree: folderTree(root, await listFolders(env)) };
}

/* ------------------------------------------------------------------ files -- */

const MAX_PAGES = 20;

// Every file (not folder) anywhere under root, To delete included: [{ id, name }] (paged).
// Refuses rather than guess if there are more than it can check.
async function filesUnder(env, root, tree) {
  const out = [];
  let page = '';
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const q = encodeURIComponent(`mimeType != '${FOLDER}' and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,parents)');
    const j = await driveJson(env, `?q=${q}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    out.push(...(j.files || []).filter((f) => (f.parents || []).some((p) => inRoot(root, tree, p))));
    page = j.nextPageToken || '';
    if (!page) return out.map((f) => ({ id: f.id, name: f.name }));
  }
  throw new Error('Too many files in Drive to check the name is free: nothing renamed');
}

const otherNames = (files, id) => files.filter((f) => f.id !== id).map((f) => f.name);

async function getFile(env, id) {
  return driveJson(env, `/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`);
}

// The file and where it is, or a refusal. Only plain files with exactly one folder under root.
export function locate(root, tree, file) {
  if (!file || file.trashed) return fail(404, 'Not found in Drive');
  if (file.mimeType === FOLDER || file.id === root) return fail(400, 'That is a folder, not a photo');
  const parents = file.parents || [];
  if (parents.length !== 1) return fail(400, 'This file is in more than one folder: sort it out in Drive');
  const [parent] = parents;
  if (!inRoot(root, tree, parent)) return fail(403, 'This file is not under Lenches Photos: refused');
  return { ok: true, parent, path: pathOf(root, tree, parent), toDelete: parent !== root && tree.get(parent).toDelete };
}

async function photoRow(env, id) {
  const { headers, rows } = await readTable(env, 'Photos');
  const matches = rows.filter((r) => id && r.drive_id === id);
  return { headers, row: matches.length === 1 ? matches[0] : null, rows };
}

const validId = (id) => /^[A-Za-z0-9_-]{10,100}$/.test(String(id || ''));

// Shared start of every file operation: the Photos row, the Drive file and its place.
async function start(env, id) {
  if (!validId(id)) return fail(400, 'Bad file id');
  const [{ headers, row, rows }, { root, tree }] = await Promise.all([photoRow(env, id), loadTree(env)]);
  if (!row) return fail(404, 'No Photos row for this file');
  let file;
  try {
    file = await getFile(env, id);
  } catch (e) {
    if (e.status === 404) return fail(404, 'Not found in Drive (or not shared with the service account)');
    throw e;
  }
  const where = locate(root, tree, file);
  if (!where.ok) return where;
  return { ok: true, headers, row, rows, root, tree, file, where };
}

const published = (row) => Boolean(String(row.published_at || '').trim());

// GET: the live name and folder, and the folders it can go to.
export async function fileInfo(env, id) {
  const s = await start(env, id);
  if (!s.ok) return s;
  return {
    ok: true,
    file: { id, name: s.file.name, folderId: s.where.parent, folder: s.where.path, toDelete: s.where.toDelete, published: published(s.row) },
    folders: folderChoices(s.root, s.tree),
  };
}

// The name a rename would save as, with the clash check: { ok, name, wanted, numbered }.
async function planName(env, s, id, typed) {
  const n = newFileName(s.file.name, typed);
  if (n.error) return fail(400, n.error);
  const final = numberedName(n.name, otherNames(await filesUnder(env, s.root, s.tree), id));
  if (final === s.file.name) return fail(400, 'That is already its name');
  return { ok: true, name: final, wanted: n.name, numbered: final !== n.name };
}

// GET: "Will be saved as …" before Save. Nothing written.
export async function previewName(env, { id, name }) {
  const s = await start(env, id);
  if (!s.ok) return s;
  return planName(env, s, id, name);
}

const patchName = (env, id, name) => driveJson(env, `/${encodeURIComponent(id)}?fields=id,name`, { method: 'PATCH', body: { name } });

export async function renameFile(env, { id, expected, name }) {
  const s = await start(env, id);
  if (!s.ok) return s;
  if (s.where.toDelete) return fail(409, `This file is in ${TO_DELETE}: move it out in Drive first`);
  if (s.file.name !== String(expected ?? '')) {
    return fail(409, 'Renamed in Drive since you loaded the page', { current: s.file.name });
  }
  // Checked again now, against Drive as it is at write time.
  const plan = await planName(env, s, id, name);
  if (!plan.ok) return plan;
  let final = plan.name;
  await patchName(env, id, final);
  // A rename made in the same moment may have picked the same name: the file with the
  // higher id gives way and takes the next number.
  for (let n = 0; n < 3; n += 1) {
    const files = await filesUnder(env, s.root, s.tree);
    const same = files.filter((f) => f.id !== id && low(f.name) === low(final));
    if (!same.length || same.every((f) => f.id > id)) break;
    final = numberedName(final, otherNames(files, id));
    await patchName(env, id, final);
  }
  // The Sheet's filename follows on the next photos run; set it now if it still shows the old name.
  if (s.headers.includes('filename') && s.row.filename === s.file.name) {
    await checkedWrite(env, { tab: 'Photos', keyCol: 'drive_id', key: id, field: 'filename', expected: s.file.name, value: final })
      .catch((e) => console.log(`Photos filename for ${id} not updated: ${e.message}`));
  }
  return { ok: true, name: final, wanted: plan.wanted, numbered: final !== plan.wanted };
}

async function changeFolder(env, id, from, to) {
  await driveJson(env, `/${encodeURIComponent(id)}?addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(from)}&fields=id,parents`,
    { method: 'PATCH', body: {} });
}

export async function moveFile(env, { id, expectedParent, to }) {
  const s = await start(env, id);
  if (!s.ok) return s;
  if (s.where.toDelete) return fail(409, `This file is in ${TO_DELETE}: move it out in Drive first`);
  if (s.where.parent !== String(expectedParent ?? '')) {
    return fail(409, 'Moved in Drive since you loaded the page', { current: s.where.parent, currentPath: s.where.path });
  }
  const dest = String(to || '');
  if (!inRoot(s.root, s.tree, dest)) return fail(403, 'That folder is not under Lenches Photos: refused');
  if (dest !== s.root && s.tree.get(dest).toDelete) return fail(400, `Use "Move to ${TO_DELETE}" for that`);
  if (inRejected(s.root, s.tree, dest)) return fail(400, `Rejected photos go to ${TO_DELETE} now: use "Move to ${TO_DELETE}"`);
  if (dest === s.where.parent) return fail(400, 'It is already in that folder');
  await changeFolder(env, id, s.where.parent, dest);
  return { ok: true, folderId: dest, folder: pathOf(s.root, s.tree, dest) };
}

// "To delete" directly under root: { id }, or a refusal when there is none (Jon makes it
// in Drive, so he owns it) or more than one.
function toDeleteFolder(root, tree) {
  const found = childrenOf(tree, root).filter((f) => f.toDelete);
  if (found.length > 1) return fail(409, `There are ${found.length} "${TO_DELETE}" folders in Lenches Photos: keep one`);
  if (!found.length) return fail(409, `Make a folder called "${TO_DELETE}" directly in Lenches Photos in Google Drive first, then try again`, { needsFolder: true });
  return { ok: true, id: found[0].id };
}

// Into To delete, recording where from (and the Photos status before) on the file.
async function moveToBin(env, id, from, binId, { fromPath, status }) {
  const properties = {
    lenchesFrom: from,
    lenchesFromPath: String(fromPath || '').slice(0, PROP_MAX - 20),
    lenchesMovedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    lenchesStatus: String(status || '').trim().slice(0, 30) || 'new',
  };
  await driveJson(env, `/${encodeURIComponent(id)}?addParents=${encodeURIComponent(binId)}&removeParents=${encodeURIComponent(from)}&fields=id,parents`,
    { method: 'PATCH', body: { properties } });
}

// Move one photo to To delete and mark its Photos row rejected (the run's value for
// "never use"): the panel's Reject, Move to To delete, the duplicates view and the one-off
// tidy of Rejected folders. expected = Photos status loaded, expectedParent = Drive folder loaded.
export async function discardFile(env, { id, expected, expectedParent, confirmPublished }) {
  const s = await start(env, id);
  if (!s.ok) return s;
  const status = String(s.row.status ?? '');
  if (status !== String(expected ?? '')) {
    return fail(409, 'Its Photos status changed since you loaded the page', { current: status });
  }
  if (published(s.row) && confirmPublished !== true) {
    return fail(409, 'This copy is on the website: confirm again to take it down and move it', { needsConfirm: true });
  }
  const bin = toDeleteFolder(s.root, s.tree);
  if (!bin.ok) return bin;
  if (!s.where.toDelete) {
    if (s.where.parent !== String(expectedParent ?? '')) {
      return fail(409, 'Moved in Drive since you loaded the page', { current: s.where.parent, currentPath: s.where.path });
    }
    await moveToBin(env, id, s.where.parent, bin.id, { fromPath: relOf(s.root, s.tree, s.where.parent), status });
  }
  if (low(status) !== REJECTED) {
    const w = await checkedWrite(env, { tab: 'Photos', keyCol: 'drive_id', key: id, field: 'status', expected: status, value: REJECTED });
    if (!w.ok) return { ...w, error: `Moved to ${TO_DELETE}, but the Photos status was not set: ${w.error}` };
  }
  return {
    ok: true,
    folderId: s.where.toDelete ? s.where.parent : bin.id,
    message: `Moved to ${TO_DELETE} and marked rejected.${published(s.row) ? ' The daily photos run takes it off the site.' : ''}`,
  };
}

/* ---------------------------------------------------------------- To delete -- */

// Where a file in To delete came from: the folder recorded at move time if it is still
// under root (and not in To delete), else the folder at the Photos tab's path (one match
// only). { id, path, source: 'recorded' | 'sheet' } or { error }.
export function originOf(rootId, tree, file, row) {
  const p = (file && file.properties) || {};
  const rec = String(p.lenchesFrom || '');
  if (rec && inRoot(rootId, tree, rec) && !(rec !== rootId && tree.get(rec).toDelete)) {
    return { id: rec, path: relOf(rootId, tree, rec), source: 'recorded' };
  }
  const want = row ? String(row.path ?? '').trim() : null;
  if (want === '') return { id: rootId, path: '', source: 'sheet' };
  if (want) {
    const hits = [...tree.values()].filter((f) => !f.toDelete && f.names.map((n) => String(n).trim()).join(' / ') === want);
    if (hits.length === 1) return { id: hits[0].id, path: want, source: 'sheet' };
    return { error: hits.length ? `More than one folder is called ${want}: move it back in Drive` : `Its old folder (${want}) is not in Lenches Photos any more: move it in Drive` };
  }
  return { error: rec ? 'Its old folder is not in Lenches Photos any more: move it in Drive' : 'Where it came from is not known: move it in Drive' };
}

// Every file in To delete (and folders inside it), with where it came from and when it
// moved: [{ id, name, folderId, inside, from: { id, path, source } | { error }, movedAt,
// movedBy: 'panel' | 'run' | '', prevStatus }]. rows: the Photos table (or a promise of it).
export async function binList(env, photos) {
  const { root, tree } = await loadTree(env);
  const bins = [...tree.values()].filter((f) => f.toDelete);
  let rows = [];
  try { rows = (await photos).rows || []; } catch { /* listed without the Sheet's fallback */ }
  const byId = new Map(rows.filter((r) => r.drive_id).map((r) => [r.drive_id, r]));
  const out = [];
  for (const b of bins) {
    let page = '';
    for (let n = 0; n < MAX_PAGES; n += 1) {
      const q = encodeURIComponent(`'${b.id}' in parents and mimeType != '${FOLDER}' and trashed = false`);
      const fields = encodeURIComponent('nextPageToken,files(id,name,parents,properties,createdTime)');
      const j = await driveJson(env, `?q=${q}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      for (const f of j.files || []) {
        const row = byId.get(f.id) || null;
        const p = f.properties || {};
        const ran = row && String(row.notes || '').match(/^(\d{4}-\d{2}-\d{2}) in To delete/);
        out.push({
          id: f.id, name: f.name, folderId: b.id, inside: b.names.slice(1).join(' / '),
          from: originOf(root, tree, f, row),
          movedAt: String(p.lenchesMovedAt || '') || (ran ? ran[1] : ''),
          movedBy: p.lenchesMovedAt ? 'panel' : ran ? 'run' : '',
          prevStatus: String(p.lenchesStatus || ''),
        });
      }
      page = j.nextPageToken || '';
      if (!page) break;
    }
  }
  return out.sort((a, b) => String(b.movedAt).localeCompare(String(a.movedAt)) || a.name.localeCompare(b.name));
}

// Back out of To delete to where it came from; the Photos status goes back to what it was
// if the panel recorded it and the row is still rejected. expectedParent = the To delete
// folder the page loaded.
export async function restoreFile(env, { id, expectedParent }) {
  const s = await start(env, id);
  if (!s.ok) return s;
  if (!s.where.toDelete) return fail(409, `It is not in ${TO_DELETE} any more (now in ${s.where.path})`, { current: s.where.parent, currentPath: s.where.path });
  if (s.where.parent !== String(expectedParent ?? '')) {
    return fail(409, 'Moved in Drive since you loaded the page', { current: s.where.parent, currentPath: s.where.path });
  }
  const to = originOf(s.root, s.tree, s.file, s.row);
  if (to.error) return fail(409, to.error);
  const clear = { lenchesFrom: null, lenchesFromPath: null, lenchesMovedAt: null, lenchesStatus: null };
  await driveJson(env, `/${encodeURIComponent(id)}?addParents=${encodeURIComponent(to.id)}&removeParents=${encodeURIComponent(s.where.parent)}&fields=id,parents`,
    { method: 'PATCH', body: { properties: clear } });
  const prev = String((s.file.properties || {}).lenchesStatus || '');
  const status = String(s.row.status ?? '');
  let note = '';
  if (low(status) === REJECTED && prev && low(prev) !== REJECTED) {
    const w = await checkedWrite(env, { tab: 'Photos', keyCol: 'drive_id', key: id, field: 'status', expected: status, value: prev });
    note = w.ok ? ` Photos status back to ${prev}.` : ` Its Photos status is still rejected (${w.error}).`;
  } else if (low(status) === REJECTED) {
    note = ' It is still marked rejected: Approve it to use it.';
  }
  const where = to.path || 'Lenches Photos';
  return { ok: true, folderId: to.id, folder: pathOf(s.root, s.tree, to.id), status: note.includes('back to') ? prev : status, message: `Restored to ${where}.${note}` };
}

// The one-off tidy: every file still in a Rejected folder, or marked rejected in the
// Photos tab but outside To delete. Nothing moves here; the panel shows the list, and on
// Jon's yes moves each with discardFile. Safe to repeat: files already in To delete are
// never listed. [{ id, name, folderId, path, reason, status, published, hasRow }]
export async function tidyList(env) {
  const [{ rows }, { root, tree }] = await Promise.all([readTable(env, 'Photos'), loadTree(env)]);
  const byId = new Map(rows.filter((r) => r.drive_id).map((r) => [r.drive_id, r]));
  const out = [];
  let page = '';
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const q = encodeURIComponent(`mimeType != '${FOLDER}' and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,parents)');
    const j = await driveJson(env, `?q=${q}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const f of j.files || []) {
      const parents = (f.parents || []).filter((p) => inRoot(root, tree, p));
      if (parents.length !== 1) continue;
      const [parent] = parents;
      if (parent !== root && tree.get(parent).toDelete) continue;
      const row = byId.get(f.id);
      const folderRej = inRejected(root, tree, parent);
      if (!folderRej && !(row && low(row.status) === REJECTED)) continue;
      out.push({
        id: f.id, name: f.name, folderId: parent, path: relOf(root, tree, parent),
        reason: folderRej ? 'In a Rejected folder' : 'Marked rejected',
        status: row ? String(row.status ?? '') : '', published: Boolean(row && published(row)), hasRow: Boolean(row),
      });
    }
    page = j.nextPageToken || '';
    if (!page) return { ok: true, files: out.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name)) };
  }
  throw new Error('Too many files in Drive to list: nothing listed');
}

/* ------------------------------------------------------------- duplicates -- */

const validHash = (h) => /^[0-9a-f]{16}$/.test(String(h || ''));

// As scripts/ingest/images.js hashDistance (64 = not comparable).
export function hashDistance(a, b) {
  if (!validHash(a) || !validHash(b)) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// The copies of row id: every Photos row (any status) whose dHash is within the run's
// duplicate distance of it, the row itself first. The run's duplicate_of names only the
// earlier copy by filename, so the dHash is what groups them.
export function dupGroup(rows, id) {
  const me = rows.find((r) => r.drive_id === id);
  if (!me) return [];
  const others = validHash(me.dhash)
    ? rows.filter((r) => r !== me && r.drive_id && hashDistance(me.dhash, r.dhash) <= DUP_DISTANCE)
    : [];
  return [me, ...others].slice(0, MAX_GROUP);
}

export async function dupMembers(env, id) {
  if (!validId(id)) return fail(400, 'Bad file id');
  const [{ rows }, { root, tree }, list] = await Promise.all([photoRow(env, id), loadTree(env), photoPages(env)]);
  const group = dupGroup(rows, id);
  if (!group.length) return fail(404, 'No Photos row for this file');
  const members = await Promise.all(group.map(async (r) => {
    const base = {
      drive_id: r.drive_id, filename: r.filename || '', status: String(r.status || ''), published: published(r), pages: pagesFor(list, r),
      sheetPath: r.path || '', width: r.width || '', height: r.height || '',
    };
    let file;
    try {
      file = await getFile(env, r.drive_id);
    } catch (e) {
      if (e.status === 404) return { ...base, missing: true };
      throw e;
    }
    const where = locate(root, tree, file);
    if (!where.ok) return { ...base, missing: true, refused: where.error };
    const meta = file.imageMediaMetadata || {};
    return {
      ...base, name: file.name, folderId: where.parent, folder: where.path, toDelete: where.toDelete,
      width: meta.width || base.width, height: meta.height || base.height,
      size: Number(file.size) || 0, created: file.createdTime || '',
    };
  }));
  return { ok: true, members };
}
