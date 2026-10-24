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
//     deleted, Jon empties that folder himself. The photos run ignores it.
//   - the panel never creates folders (To delete included): anything the account made would
//     belong to it, not to Jon, and would be at risk if the account were ever deleted.
//     Jon makes folders in Drive; the panel picks them up on Reload.
//   - a published copy needs a second, explicit confirm (confirmPublished) before it moves
// Renaming is safe for published photos too: the run fixes a photo's slug (its web
// address and committed file names) at first publish and keeps it, alt text is its own
// column, and nothing else reads the Drive name.

import { driveJson } from './google.js';
import { readTable, checkedWrite } from './sheet.js';

export const FOLDER = 'application/vnd.google-apps.folder';
export const TO_DELETE = 'To delete';
export const DUP_DISTANCE = 6;      // as scripts/photos/index.js
const MAX_STEM = 80;
const MAX_GROUP = 12;
const FILE_FIELDS = 'id,name,mimeType,parents,size,createdTime,trashed,imageMediaMetadata(width,height)';

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

// Folders a photo can be moved to (never To delete or anything in it), sorted by path.
export function folderChoices(rootId, tree) {
  return [{ id: rootId, path: pathOf(rootId, tree, rootId) },
    ...[...tree.values()].filter((f) => !f.toDelete).map((f) => ({ id: f.id, path: pathOf(rootId, tree, f.id) }))
      .sort((a, b) => a.path.localeCompare(b.path))];
}

// Folders under root for the panel's Photos menu (not To delete): [{ id, names }], by path.
export async function folderList(env) {
  const { tree } = await loadTree(env);
  return [...tree.values()].filter((f) => !f.toDelete)
    .map((f) => ({ id: f.id, names: f.names.map((n) => String(n).trim()) }))
    .sort((a, b) => a.names.join(' / ').localeCompare(b.names.join(' / ')));
}

async function loadTree(env) {
  const root = rootOf(env);
  return { root, tree: folderTree(root, await listFolders(env)) };
}

/* ------------------------------------------------------------------ files -- */

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

export async function renameFile(env, { id, expected, name }) {
  const s = await start(env, id);
  if (!s.ok) return s;
  if (s.where.toDelete) return fail(409, `This file is in ${TO_DELETE}: move it out in Drive first`);
  if (s.file.name !== String(expected ?? '')) {
    return fail(409, 'Renamed in Drive since you loaded the page', { current: s.file.name });
  }
  const n = newFileName(s.file.name, name);
  if (n.error) return fail(400, n.error);
  await driveJson(env, `/${encodeURIComponent(id)}?fields=id,name`, { method: 'PATCH', body: { name: n.name } });
  // The Sheet's filename follows on the next photos run; set it now if it still shows the old name.
  if (s.headers.includes('filename') && s.row.filename === s.file.name) {
    await checkedWrite(env, { tab: 'Photos', keyCol: 'drive_id', key: id, field: 'filename', expected: s.file.name, value: n.name })
      .catch((e) => console.log(`Photos filename for ${id} not updated: ${e.message}`));
  }
  return { ok: true, name: n.name };
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

// Move one copy to To delete and mark its Photos row rejected (the run's value for
// "never use"). expected = Photos status loaded, expectedParent = Drive folder loaded.
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
  if (!s.where.toDelete) {
    if (s.where.parent !== String(expectedParent ?? '')) {
      return fail(409, 'Moved in Drive since you loaded the page', { current: s.where.parent, currentPath: s.where.path });
    }
    const bin = toDeleteFolder(s.root, s.tree);
    if (!bin.ok) return bin;
    await changeFolder(env, id, s.where.parent, bin.id);
  }
  const w = await checkedWrite(env, { tab: 'Photos', keyCol: 'drive_id', key: id, field: 'status', expected: status, value: 'rejected' });
  if (!w.ok) return { ...w, error: `Moved to ${TO_DELETE}, but the Photos status was not set: ${w.error}` };
  return { ok: true, message: `Moved to ${TO_DELETE} and marked rejected.${published(s.row) ? ' The daily photos run takes it off the site.' : ''}` };
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
  const [{ rows }, { root, tree }] = await Promise.all([photoRow(env, id), loadTree(env)]);
  const group = dupGroup(rows, id);
  if (!group.length) return fail(404, 'No Photos row for this file');
  const members = await Promise.all(group.map(async (r) => {
    const base = {
      drive_id: r.drive_id, filename: r.filename || '', status: String(r.status || ''), published: published(r),
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
