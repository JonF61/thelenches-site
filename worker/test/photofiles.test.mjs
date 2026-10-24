// worker/test/photofiles.test.mjs
// Offline tests for Photos file management (admin/photofiles.js): the Lenches Photos
// root check, stale checks, name cleaning, duplicate groups, the published-copy guard,
// the To delete move, and that nothing ever bins or deletes a file. Google is a fake
// Drive + Sheet behind global fetch; nothing leaves the machine.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanName, newFileName, newFolderName, folderTree, folderChoices, locate, dupGroup, hashDistance,
  fileInfo, renameFile, moveFile, newFolder, discardFile, dupMembers, FOLDER,
} from '../src/admin/photofiles.js';
import { resetTokenCache, driveJson, SCOPES } from '../src/admin/google.js';
import { resetCertCache } from '../src/admin/access.js';
import { bytesToB64url, jsonToB64url } from '../src/admin/b64.js';
import { makeCsrf } from '../src/admin/csrf.js';
import worker from '../src/index.js';

const enc = new TextEncoder();
const TEAM = 'lenches.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const ORIGIN = 'https://approvals.lenches.workers.dev';
const ADMIN = 'admin@example.org';
const ROOT = 'rootFolder0001';

const rsa = () => crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const accessKey = await rsa();
const saKey = await rsa();
const accessJwk = { ...(await crypto.subtle.exportKey('jwk', accessKey.publicKey)), kid: 'k1' };
const saPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;

async function accessJwt() {
  const t = Math.floor(Date.now() / 1000);
  const body = `${jsonToB64url({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${jsonToB64url({ aud: [AUD], iss: `https://${TEAM}`, email: ADMIN, exp: t + 600, iat: t })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', accessKey.privateKey, enc.encode(body));
  return `${body}.${bytesToB64url(sig)}`;
}

const env = () => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ADMIN_EMAILS: ADMIN,
  APPROVAL_SIGNING_KEY: 'test-signing-key',
  DISPATCH_TOKEN: 'gh-token',
  REPO: 'owner/repo',
  SHEET_ID: 'sheet123',
  PHOTOS_FOLDER_ID: ROOT,
  GMAIL_USER: 'inbox@example.org',
  GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: saPem }),
});

/* ------------------------------------------------------------ fixtures -- */

const folder = (id, name, parent) => ({ id, name, mimeType: FOLDER, parents: [parent] });
const photo = (id, name, parent, extra = {}) => ({
  id, name, mimeType: 'image/jpeg', parents: [parent], size: '2400000', createdTime: '2026-09-01T10:00:00Z',
  imageMediaMetadata: { width: 4000, height: 3000 }, ...extra,
});

// Lenches Photos / Rous Lench / Churches, General, plus a folder and a photo outside it.
const driveFiles = () => ({
  [ROOT]: { id: ROOT, name: 'Lenches Photos', mimeType: FOLDER, parents: ['jonsMyDrive'] },
  folderRousLench: folder('folderRousLench', 'Rous Lench', ROOT),
  folderChurches1: folder('folderChurches1', 'Churches', 'folderRousLench'),
  folderGeneral01: folder('folderGeneral01', 'General', ROOT),
  folderOutside01: folder('folderOutside01', 'Private', 'jonsMyDrive'),
  photoChurchA001: photo('photoChurchA001', 'IMG_3113.jpg', 'folderChurches1'),
  photoChurchB002: photo('photoChurchB002', 'IMG_3113 (1).jpg', 'folderGeneral01', { size: '1200000' }),
  photoChurchC003: photo('photoChurchC003', 'church copy.JPG', 'folderGeneral01'),
  photoOther00004: photo('photoOther00004', 'hall.png', 'folderGeneral01'),
  photoOutside005: photo('photoOutside005', 'private.jpg', 'folderOutside01'),
});

const PHOTO_HEADERS = ['drive_id', 'path', 'filename', 'status', 'dhash', 'duplicate_of', 'published_at', 'slug'];
const photosTable = () => [
  PHOTO_HEADERS.slice(),
  ['photoChurchA001', 'Rous Lench / Churches', 'IMG_3113.jpg', 'approved', 'ffff0000ffff0000', '', '2026-09-02T05:41:00Z', 'rous-lench-img-3113'],
  ['photoChurchB002', 'General', 'IMG_3113 (1).jpg', 'new', 'ffff0000ffff0003', 'IMG_3113.jpg (Rous Lench / Churches)', '', ''],
  ['photoChurchC003', 'General', 'church copy.JPG', 'new', 'ffff0000ffff001f', 'IMG_3113.jpg (Rous Lench / Churches)', '', ''],
  ['photoOther00004', 'General', 'hall.png', 'new', '0000ffff0000ffff', '', '', ''],
  ['photoOutside005', 'Private', 'private.jpg', 'new', '', '', '', ''],
];

function fakeWorld({ files = driveFiles(), photos = photosTable() } = {}) {
  const calls = { drive: [], writes: [], tokens: [] };
  const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  let made = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.hostname === TEAM) return Response.json({ keys: [accessJwk] });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      calls.tokens.push({ scope: claims.scope, sub: claims.sub || '' });
      return Response.json({ access_token: `tok:${claims.scope}`, expires_in: 3600 });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      if (url.pathname.endsWith('/values:batchUpdate')) {
        for (const d of JSON.parse(init.body).data) {
          calls.writes.push(d);
          const [, , col, row] = d.range.match(/^'(.+)'!([A-Z]+)(\d+)$/);
          photos[row - 1][colIndex(col)] = d.values[0][0];
        }
        return Response.json({});
      }
      return Response.json({ values: photos });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.drive.push({ method, path: url.pathname, search: url.search, body, auth: init.headers.authorization });
      const id = decodeURIComponent(url.pathname.split('/')[4] || '');
      if (method === 'GET' && !id) {
        const q = url.searchParams.get('q');
        assert.match(q, /mimeType = 'application\/vnd\.google-apps\.folder'/);
        return Response.json({ files: Object.values(files).filter((f) => f.mimeType === FOLDER && f.id !== ROOT && !f.trashed) });
      }
      if (method === 'GET') return files[id] ? Response.json(files[id]) : new Response('not found', { status: 404 });
      if (method === 'PATCH') {
        const f = files[id];
        if (!f) return new Response('not found', { status: 404 });
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        if (add) f.parents = [...f.parents.filter((p) => p !== remove), add];
        if (body && body.name) f.name = body.name;
        return Response.json(f);
      }
      if (method === 'POST') {
        made += 1;
        const f = { id: `newFolder000${made}`, name: body.name, mimeType: body.mimeType, parents: body.parents };
        files[f.id] = f;
        return Response.json(f);
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  return { calls, files, photos };
}

// Nothing may ever bin or delete: only GET, PATCH and POST; no write to a trash endpoint
// or with "trashed" in its body (the folder listing's "trashed = false" query is a read).
function assertNeverBins(calls) {
  for (const c of calls.drive) {
    assert.ok(['GET', 'PATCH', 'POST'].includes(c.method), c.method);
    if (c.method === 'GET') continue;
    assert.doesNotMatch(c.path + c.search, /trash/i);
    assert.ok(!c.body || !Object.keys(c.body).some((k) => /trash/i.test(k)), JSON.stringify(c.body));
  }
}

test.beforeEach(() => {
  resetTokenCache();
  resetCertCache();
});

/* --------------------------------------------------------------- names -- */

test('Names: unsafe characters stripped, extension kept, length limited', () => {
  assert.equal(cleanName('  a/b\\c:d*e?f"g<h>i|j\u0007k  ', 80), 'a b c d e f g h i j k');
  assert.equal(cleanName('..hidden..', 80), 'hidden');
  assert.deepEqual(newFileName('IMG_3113.jpg', 'St Peter church'), { name: 'St Peter church.jpg' });
  assert.deepEqual(newFileName('IMG_3113.jpg', 'St Peter church.JPG'), { name: 'St Peter church.jpg' }, 'typed extension not doubled');
  assert.deepEqual(newFileName('IMG_3113.jpg', 'evil.png'), { name: 'evil.png.jpg' }, 'extension cannot be changed');
  assert.deepEqual(newFileName('IMG_3113.jpg', '../../etc/passwd'), { name: 'etc passwd.jpg' });
  assert.equal(newFileName('a.jpg', 'x'.repeat(300)).name, `${'x'.repeat(80)}.jpg`);
  assert.ok(newFileName('a.jpg', ' / ').error);
  assert.ok(newFileName('a.jpg', 'a').error, 'unchanged');
  assert.deepEqual(newFolderName(' Churches: old / new '), { name: 'Churches old new' });
  assert.ok(newFolderName('to DELETE').error, 'reserved name');
  assert.equal(newFolderName('y'.repeat(100)).name.length, 60);
});

/* ---------------------------------------------------------------- root -- */

test('Root: only folders whose chain reaches Lenches Photos count', () => {
  const tree = folderTree(ROOT, Object.values(driveFiles()).filter((f) => f.mimeType === FOLDER));
  assert.deepEqual([...tree.keys()].sort(), ['folderChurches1', 'folderGeneral01', 'folderRousLench']);
  assert.deepEqual(folderChoices(ROOT, tree).map((f) => f.path), [
    'Lenches Photos', 'Lenches Photos / General', 'Lenches Photos / Rous Lench', 'Lenches Photos / Rous Lench / Churches',
  ]);
  assert.equal(locate(ROOT, tree, driveFiles().photoOutside005).status, 403);
  assert.equal(locate(ROOT, tree, driveFiles().folderGeneral01).status, 400, 'folders are refused');
  assert.equal(locate(ROOT, tree, { ...driveFiles().photoChurchA001, parents: ['folderGeneral01', 'folderOutside01'] }).status, 400);
  // A loop in parents must not hang or count as inside.
  assert.equal(folderTree(ROOT, [folder('a', 'A', 'b'), folder('b', 'B', 'a')]).size, 0);
});

test('Root: a file outside Lenches Photos is refused for every operation, nothing written', async () => {
  const { calls } = fakeWorld();
  const id = 'photoOutside005';
  for (const r of [
    await fileInfo(env(), id),
    await renameFile(env(), { id, expected: 'private.jpg', name: 'x' }),
    await moveFile(env(), { id, expectedParent: 'folderOutside01', to: 'folderGeneral01' }),
    await discardFile(env(), { id, expected: 'new', expectedParent: 'folderOutside01' }),
  ]) assert.equal(r.status, 403, JSON.stringify(r));
  let r = await moveFile(env(), { id: 'photoOther00004', expectedParent: 'folderGeneral01', to: 'folderOutside01' });
  assert.equal(r.status, 403, 'destination outside the root');
  r = await newFolder(env(), { parent: 'folderOutside01', name: 'Sneaky' });
  assert.equal(r.status, 403);
  r = await newFolder(env(), { parent: 'jonsMyDrive', name: 'Sneaky' });
  assert.equal(r.status, 403);
  assert.equal(calls.drive.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(calls.writes.length, 0);
});

test('Root: PHOTOS_FOLDER_ID must be set', async () => {
  fakeWorld();
  const e = { ...env(), PHOTOS_FOLDER_ID: '' };
  await assert.rejects(fileInfo(e, 'photoOther00004'), /PHOTOS_FOLDER_ID/);
});

/* -------------------------------------------------------------- rename -- */

test('Rename: stale-checked against the Drive name, extension kept, Sheet filename follows', async () => {
  const { calls, files, photos } = fakeWorld();
  let r = await renameFile(env(), { id: 'photoOther00004', expected: 'hall-old.png', name: 'Village hall' });
  assert.equal(r.status, 409);
  assert.equal(r.current, 'hall.png');
  assert.equal(files.photoOther00004.name, 'hall.png');
  r = await renameFile(env(), { id: 'photoOther00004', expected: 'hall.png', name: 'Village hall: front' });
  assert.deepEqual(r, { ok: true, name: 'Village hall front.png' });
  assert.equal(files.photoOther00004.name, 'Village hall front.png');
  assert.equal(photos[4][2], 'Village hall front.png');
  const patch = calls.drive.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { name: 'Village hall front.png' });
  assert.equal(patch.auth, `Bearer tok:${SCOPES.driveWrite}`);
  assertNeverBins(calls);
});

test('Rename: a published photo keeps its slug (the web address)', async () => {
  const { photos } = fakeWorld();
  const r = await renameFile(env(), { id: 'photoChurchA001', expected: 'IMG_3113.jpg', name: 'St Peter Rous Lench' });
  assert.equal(r.ok, true);
  assert.equal(photos[1][PHOTO_HEADERS.indexOf('slug')], 'rous-lench-img-3113');
  assert.equal(photos[1][PHOTO_HEADERS.indexOf('published_at')], '2026-09-02T05:41:00Z');
});

test('Rename: no Photos row, or a bad id, is refused', async () => {
  const { files, calls } = fakeWorld();
  files.photoNoRow00006 = photo('photoNoRow00006', 'x.jpg', 'folderGeneral01');
  assert.equal((await renameFile(env(), { id: 'photoNoRow00006', expected: 'x.jpg', name: 'y' })).status, 404);
  assert.equal((await renameFile(env(), { id: '../x', expected: 'x.jpg', name: 'y' })).status, 400);
  assert.equal(calls.drive.filter((c) => c.method !== 'GET').length, 0);
});

/* ---------------------------------------------------------------- move -- */

test('Move: stale-checked against the folder the page loaded; replaces the parent', async () => {
  const { calls, files } = fakeWorld();
  let r = await moveFile(env(), { id: 'photoOther00004', expectedParent: 'folderChurches1', to: 'folderRousLench' });
  assert.equal(r.status, 409);
  assert.equal(r.current, 'folderGeneral01');
  assert.equal(r.currentPath, 'Lenches Photos / General');
  r = await moveFile(env(), { id: 'photoOther00004', expectedParent: 'folderGeneral01', to: 'folderGeneral01' });
  assert.equal(r.status, 400, 'same folder');
  r = await moveFile(env(), { id: 'photoOther00004', expectedParent: 'folderGeneral01', to: 'folderRousLench' });
  assert.deepEqual(r, { ok: true, folderId: 'folderRousLench', folder: 'Lenches Photos / Rous Lench' });
  assert.deepEqual(files.photoOther00004.parents, ['folderRousLench']);
  const patch = calls.drive.find((c) => c.method === 'PATCH');
  assert.match(patch.search, /addParents=folderRousLench/);
  assert.match(patch.search, /removeParents=folderGeneral01/);
  assertNeverBins(calls);
});

test('Folders: new folder only under Lenches Photos, name cleaned, no duplicate at the same level', async () => {
  const { calls, files } = fakeWorld();
  let r = await newFolder(env(), { parent: 'folderRousLench', name: 'churches' });
  assert.equal(r.status, 409, 'same name, any case, at the same level');
  r = await newFolder(env(), { parent: 'folderRousLench', name: 'To Delete' });
  assert.equal(r.status, 400);
  r = await newFolder(env(), { parent: 'folderRousLench', name: ' Village/hall ' });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'Lenches Photos / Rous Lench / Village hall');
  assert.deepEqual(files[r.id].parents, ['folderRousLench']);
  r = await newFolder(env(), { parent: ROOT, name: 'Atch Lench' });
  assert.equal(r.ok, true);
  const info = await fileInfo(env(), 'photoOther00004');
  assert.ok(info.folders.some((f) => f.path === 'Lenches Photos / Atch Lench'));
  assertNeverBins(calls);
});

/* ---------------------------------------------------------- duplicates -- */

test('Duplicates: the group is every row within the dHash distance, any status', () => {
  const t = photosTable();
  const rows = t.slice(1).map((r) => Object.fromEntries(PHOTO_HEADERS.map((h, i) => [h, r[i]])));
  assert.equal(hashDistance('ffff0000ffff0000', 'ffff0000ffff0003'), 2);
  assert.equal(hashDistance('ffff0000ffff0000', 'unreadable'), 64);
  assert.deepEqual(dupGroup(rows, 'photoChurchB002').map((r) => r.drive_id), ['photoChurchB002', 'photoChurchA001', 'photoChurchC003']);
  assert.deepEqual(dupGroup(rows, 'photoChurchA001').map((r) => r.drive_id), ['photoChurchA001', 'photoChurchB002', 'photoChurchC003']);
  assert.deepEqual(dupGroup(rows, 'photoOutside005').map((r) => r.drive_id), ['photoOutside005'], 'no hash: alone');
  assert.deepEqual(dupGroup(rows, 'nope'), []);
});

test('Duplicates: members carry thumbnail id, name, folder, size, dimensions, created, status, published', async () => {
  const { calls } = fakeWorld();
  const r = await dupMembers(env(), 'photoChurchB002');
  assert.equal(r.ok, true);
  assert.deepEqual(r.members.map((m) => [m.drive_id, m.name, m.folder, m.status, m.published, m.size, m.width, m.height, m.created]), [
    ['photoChurchB002', 'IMG_3113 (1).jpg', 'Lenches Photos / General', 'new', false, 1200000, 4000, 3000, '2026-09-01T10:00:00Z'],
    ['photoChurchA001', 'IMG_3113.jpg', 'Lenches Photos / Rous Lench / Churches', 'approved', true, 2400000, 4000, 3000, '2026-09-01T10:00:00Z'],
    ['photoChurchC003', 'church copy.JPG', 'Lenches Photos / General', 'new', false, 2400000, 4000, 3000, '2026-09-01T10:00:00Z'],
  ]);
  assert.equal(calls.drive.filter((c) => c.method !== 'GET').length, 0, 'listing writes nothing');
});

test('Duplicates: a copy gone from Drive shows as missing', async () => {
  const { files } = fakeWorld();
  delete files.photoChurchC003;
  const r = await dupMembers(env(), 'photoChurchB002');
  assert.equal(r.members.find((m) => m.drive_id === 'photoChurchC003').missing, true);
});

/* ---------------------------------------------------------- To delete -- */

test('To delete: made directly under the root if missing, the copy moved, row marked rejected', async () => {
  const { calls, files, photos } = fakeWorld();
  const r = await discardFile(env(), { id: 'photoChurchB002', expected: 'new', expectedParent: 'folderGeneral01' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const bin = Object.values(files).find((f) => f.name === 'To delete');
  assert.ok(bin, 'To delete made');
  assert.deepEqual(bin.parents, [ROOT]);
  assert.deepEqual(files.photoChurchB002.parents, [bin.id]);
  assert.equal(photos[2][PHOTO_HEADERS.indexOf('status')], 'rejected');
  // A second discard reuses the same To delete folder.
  const r2 = await discardFile(env(), { id: 'photoChurchC003', expected: 'new', expectedParent: 'folderGeneral01' });
  assert.equal(r2.ok, true);
  assert.deepEqual(files.photoChurchC003.parents, [bin.id]);
  assert.equal(calls.drive.filter((c) => c.method === 'POST').length, 1);
  // Once there, it can't be renamed or moved from the panel, and isn't a move target.
  assert.equal((await renameFile(env(), { id: 'photoChurchB002', expected: 'IMG_3113 (1).jpg', name: 'x' })).status, 409);
  const info = await fileInfo(env(), 'photoOther00004');
  assert.ok(!info.folders.some((f) => /To delete/.test(f.path)));
  assert.equal((await moveFile(env(), { id: 'photoOther00004', expectedParent: 'folderGeneral01', to: bin.id })).status, 400);
  assertNeverBins(calls);
});

test('To delete: stale status or folder refuses, nothing moved', async () => {
  const { calls, files } = fakeWorld();
  let r = await discardFile(env(), { id: 'photoChurchB002', expected: 'approved', expectedParent: 'folderGeneral01' });
  assert.equal(r.status, 409);
  assert.equal(r.current, 'new');
  r = await discardFile(env(), { id: 'photoChurchB002', expected: 'new', expectedParent: 'folderChurches1' });
  assert.equal(r.status, 409);
  assert.deepEqual(files.photoChurchB002.parents, ['folderGeneral01']);
  assert.equal(calls.drive.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(calls.writes.length, 0);
});

test('Published guard: a published copy needs a second explicit confirm', async () => {
  const { calls, files, photos } = fakeWorld();
  let r = await discardFile(env(), { id: 'photoChurchA001', expected: 'approved', expectedParent: 'folderChurches1' });
  assert.equal(r.status, 409);
  assert.equal(r.needsConfirm, true);
  r = await discardFile(env(), { id: 'photoChurchA001', expected: 'approved', expectedParent: 'folderChurches1', confirmPublished: 'yes' });
  assert.equal(r.status, 409, 'only true counts');
  assert.deepEqual(files.photoChurchA001.parents, ['folderChurches1']);
  assert.equal(calls.drive.filter((c) => c.method !== 'GET').length, 0);
  r = await discardFile(env(), { id: 'photoChurchA001', expected: 'approved', expectedParent: 'folderChurches1', confirmPublished: true });
  assert.equal(r.ok, true);
  assert.match(r.message, /takes it off the site/);
  assert.equal(photos[1][PHOTO_HEADERS.indexOf('status')], 'rejected');
});

test('To delete: two such folders is refused rather than guessed', async () => {
  const { files } = fakeWorld();
  files.bin1 = folder('binFolder0001', 'To delete', ROOT);
  files.bin2 = folder('binFolder0002', 'to delete', ROOT);
  await assert.rejects(discardFile(env(), { id: 'photoChurchB002', expected: 'new', expectedParent: 'folderGeneral01' }), /2 "To delete"/);
  assert.deepEqual(files.photoChurchB002.parents, ['folderGeneral01']);
});

/* ------------------------------------------------- identity and binning -- */

test('Drive: own identity only (never impersonating), and binning or deleting is impossible', async () => {
  const { calls } = fakeWorld();
  await renameFile(env(), { id: 'photoOther00004', expected: 'hall.png', name: 'Hall' });
  await discardFile(env(), { id: 'photoChurchC003', expected: 'new', expectedParent: 'folderGeneral01' });
  const driveTokens = calls.tokens.filter((t) => /drive/.test(t.scope));
  assert.ok(driveTokens.length >= 2);
  assert.ok(driveTokens.every((t) => t.sub === ''), 'no sub claim on any Drive token');
  assert.deepEqual([...new Set(driveTokens.map((t) => t.scope))].sort(), [SCOPES.driveWrite, SCOPES.drive].sort());
  assertNeverBins(calls);
  await assert.rejects(driveJson(env(), '/x', { method: 'DELETE' }), /not allowed/);
  await assert.rejects(driveJson(env(), '/trash', { method: 'POST' }), /not allowed/);
  await assert.rejects(driveJson(env(), '/x', { method: 'PATCH', body: { trashed: true } }), /not allowed/);
  await assert.rejects(driveJson(env(), '/x?emptyTrash', { method: 'PATCH', body: {} }), /not allowed/);
});

test('No source file ever calls delete, trash or emptyTrash on Drive', async () => {
  const fs = await import('node:fs');
  const src = ['photofiles.js', 'google.js', 'index.js']
    .map((f) => fs.readFileSync(new URL(`../src/admin/${f}`, import.meta.url), 'utf8'))
    .join('\n').replace(/^\s*\/\/.*$/gm, ''); // code only, not comments
  assert.doesNotMatch(src, /method:\s*'DELETE'/);
  assert.doesNotMatch(src, /trashed:\s*true|emptyTrash|\/trash['`]/);
});

/* -------------------------------------------------------------- router -- */

test('Router: photo-file endpoints need Access and CSRF, then work', async () => {
  const { calls, files } = fakeWorld();
  const token = await accessJwt();
  let r = await worker.fetch(new Request(`${ORIGIN}/admin/api/photo-group?id=photoChurchB002`), env());
  assert.equal(r.status, 403);
  r = await worker.fetch(new Request(`${ORIGIN}/admin/api/photo-group?id=photoChurchB002`, { headers: { 'cf-access-jwt-assertion': token } }), env());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).members.length, 3);
  const post = async (body, csrf) => worker.fetch(new Request(`${ORIGIN}/admin/api/photo-file`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'cf-access-jwt-assertion': token, origin: ORIGIN, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
  }), env());
  r = await post({ op: 'move', id: 'photoOther00004', expectedParent: 'folderGeneral01', to: 'folderRousLench' });
  assert.equal(r.status, 403, 'no CSRF token');
  const csrf = await makeCsrf(env(), ADMIN);
  r = await post({ op: 'delete', id: 'photoOther00004' }, csrf);
  assert.equal(r.status, 400, 'no delete operation exists');
  r = await post({ op: 'move', id: 'photoOther00004', expectedParent: 'folderGeneral01', to: 'folderRousLench' }, csrf);
  assert.equal(r.status, 200);
  assert.deepEqual(files.photoOther00004.parents, ['folderRousLench']);
  assertNeverBins(calls);
});

/* ------------------------------------------- folder views and text edits -- */

test('State: every Photos row still in Drive (with _waiting) and the Lenches Photos folders', async () => {
  const { photos } = fakeWorld();
  photos.push(['photoGone000007', 'General', 'gone.jpg', 'missing', '', '', '', '']);
  const r = await worker.fetch(new Request(`${ORIGIN}/admin/api/state`, { headers: { 'cf-access-jwt-assertion': await accessJwt() } }), env());
  const s = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(s.photos.rows.map((x) => [x.drive_id, x._waiting]), [
    ['photoChurchA001', false], ['photoChurchB002', true], ['photoChurchC003', true], ['photoOther00004', true], ['photoOutside005', true],
  ], 'missing rows left out; approved ones kept for the folder views');
  assert.deepEqual(s.photoFolders.map((f) => f.names.join(' / ')), ['General', 'Rous Lench', 'Rous Lench / Churches']);
});

test('State: To delete is not offered as a folder view', async () => {
  const { files } = fakeWorld();
  files.binFolder0001 = folder('binFolder0001', 'To delete', ROOT);
  files.binSub0000001 = folder('binSub0000001', 'Old', 'binFolder0001');
  const r = await worker.fetch(new Request(`${ORIGIN}/admin/api/state`, { headers: { 'cf-access-jwt-assertion': await accessJwt() } }), env());
  assert.ok(!(await r.json()).photoFolders.some((f) => f.names.includes('To delete')));
});

test('Edit: Photos description and alt text are editable, stale-checked and length-limited', async () => {
  const { photos, calls } = fakeWorld();
  photos[0].push('alt_text', 'description');
  photos.slice(1).forEach((row) => row.push('Church tower', 'Taken in snow.'));
  const csrf = await makeCsrf(env(), ADMIN);
  const token = await accessJwt();
  const edit = async (body) => worker.fetch(new Request(`${ORIGIN}/admin/api/edit`, {
    method: 'POST', body: JSON.stringify({ tab: 'Photos', key: 'photoOther00004', ...body }),
    headers: { 'cf-access-jwt-assertion': token, origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': csrf },
  }), env());
  let r = await edit({ field: 'alt_text', expected: 'Church tower', value: 'Village hall from the green' });
  assert.equal(r.status, 200);
  assert.equal(photos[4][8], 'Village hall from the green');
  r = await edit({ field: 'description', expected: 'Old text', value: 'New note' });
  assert.equal(r.status, 409, 'stale');
  assert.equal((await r.json()).current, 'Taken in snow.');
  r = await edit({ field: 'description', expected: 'Taken in snow.', value: 'Slightly blurred.' });
  assert.equal(r.status, 200);
  assert.equal(photos[4][9], 'Slightly blurred.');
  r = await edit({ field: 'alt_text', expected: 'Village hall from the green', value: 'x'.repeat(126) });
  assert.equal(r.status, 400, 'alt text over 125 characters');
  r = await edit({ field: 'slug', expected: '', value: 'new-slug' });
  assert.equal(r.status, 400, 'other columns stay read-only');
  assert.equal(calls.writes.length, 2);
});
