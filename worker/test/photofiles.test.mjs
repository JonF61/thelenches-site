// worker/test/photofiles.test.mjs
// Offline tests for Photos file management (admin/photofiles.js): the Lenches Photos
// root check, stale checks, name cleaning, duplicate groups, the published-copy guard,
// the To delete move, and that nothing ever bins or deletes a file. Google is a fake
// Drive + Sheet behind global fetch; nothing leaves the machine.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanName, newFileName, folderTree, folderChoices, locate, dupGroup, hashDistance,
  fileInfo, renameFile, moveFile, discardFile, dupMembers, FOLDER,
  nameParts, numberedName, previewName,
} from '../src/admin/photofiles.js';
import { pagesFor } from '../src/admin/photopages.js';
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
  SITE_URL: 'https://thelenches.org.uk/',
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

// site: the public photo-pages.json the build writes (a Response status number = that error).
function fakeWorld({ files = driveFiles(), photos = photosTable(), site, onPatch } = {}) {
  const calls = { drive: [], writes: [], tokens: [], site: [] };
  const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.hostname === TEAM) return Response.json({ keys: [accessJwk] });
    if (url.hostname === 'thelenches.org.uk') {
      calls.site.push({ method, path: url.pathname });
      if (site === undefined || typeof site === 'number') return new Response('nope', { status: site || 404 });
      return Response.json(site);
    }
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
        // Every file, for the rename clash check (paged by pageSize when a test sets it).
        if (/mimeType != 'application\/vnd\.google-apps\.folder'/.test(q)) {
          const all = Object.values(files).filter((f) => f.mimeType !== FOLDER && !f.trashed);
          const size = Number(url.searchParams.get('pageSize'));
          const from = Number(url.searchParams.get('pageToken') || 0);
          const next = from + size < all.length ? String(from + size) : undefined;
          return Response.json({ files: all.slice(from, from + size).map(({ id, name, parents }) => ({ id, name, parents })), nextPageToken: next });
        }
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
        if (onPatch) onPatch(f, files);
        return Response.json(f);
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  return { calls, files, photos };
}

// Nothing may ever be created, binned or deleted: only GET and PATCH; no write to a trash
// endpoint or with "trashed" in its body (the folder listing's "trashed = false" is a read).
function assertNeverBins(calls) {
  for (const c of calls.drive) {
    assert.ok(['GET', 'PATCH'].includes(c.method), c.method);
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
  assert.deepEqual(r, { ok: true, name: 'Village hall front.png', wanted: 'Village hall front.png', numbered: false });
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

test('Folders: the panel can never create a folder (they would belong to the account, not Jon)', async () => {
  fakeWorld();
  await assert.rejects(driveJson(env(), '?fields=id', { method: 'POST', body: { name: 'X', mimeType: FOLDER, parents: [ROOT] } }), /not allowed/);
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

// Jon's own To delete folder, directly under the root.
const withBin = (files) => { files.binFolder0001 = folder('binFolder0001', 'To delete', ROOT); return files.binFolder0001; };

test('To delete: missing = refused with a request to make it in Drive, nothing moved or created', async () => {
  const { calls, files } = fakeWorld();
  const r = await discardFile(env(), { id: 'photoChurchB002', expected: 'new', expectedParent: 'folderGeneral01' });
  assert.equal(r.status, 409);
  assert.equal(r.needsFolder, true);
  assert.match(r.error, /Make a folder called "To delete"/);
  assert.deepEqual(files.photoChurchB002.parents, ['folderGeneral01']);
  assert.equal(calls.drive.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(calls.writes.length, 0);
});

test('To delete: the copy moved into Jon\'s folder, row marked rejected', async () => {
  const { calls, files, photos } = fakeWorld();
  const bin = withBin(files);
  const r = await discardFile(env(), { id: 'photoChurchB002', expected: 'new', expectedParent: 'folderGeneral01' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(files.photoChurchB002.parents, [bin.id]);
  assert.equal(photos[2][PHOTO_HEADERS.indexOf('status')], 'rejected');
  // A second discard reuses the same To delete folder.
  const r2 = await discardFile(env(), { id: 'photoChurchC003', expected: 'new', expectedParent: 'folderGeneral01' });
  assert.equal(r2.ok, true);
  assert.deepEqual(files.photoChurchC003.parents, [bin.id]);
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
  withBin(files);
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
  const r = await discardFile(env(), { id: 'photoChurchB002', expected: 'new', expectedParent: 'folderGeneral01' });
  assert.equal(r.status, 409);
  assert.match(r.error, /2 "To delete"/);
  assert.deepEqual(files.photoChurchB002.parents, ['folderGeneral01']);
});

/* ------------------------------------------------- identity and binning -- */

test('Drive: own identity only (never impersonating), and binning or deleting is impossible', async () => {
  const { calls, files } = fakeWorld();
  withBin(files);
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
  const files = fs.readFileSync(new URL('../src/admin/photofiles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(files, /method:\s*'POST'/, 'photofiles never creates anything in Drive');
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
  r = await post({ op: 'folder', parent: ROOT, name: 'New' }, csrf);
  assert.equal(r.status, 400, 'no new-folder operation exists');
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
  assert.deepEqual(s.photoFolders.map((f) => f.parent), [ROOT, ROOT, 'folderRousLench']);
});

// New top-level folders Jon makes in Drive: nothing in code names them.
const withNewFolders = (files) => {
  files.folderAmphi0001 = folder('folderAmphi0001', 'Amphitheatre', ROOT);
  files.folderClub00001 = folder('folderClub00001', 'Lenches Club', ROOT);
  files.folderClubQuiz1 = folder('folderClubQuiz1', 'Quiz nights', 'folderClub00001');
  return files;
};

test('New folders: Amphitheatre and Lenches Club made in Drive appear in the state, with their parents', async () => {
  const { files } = fakeWorld();
  withNewFolders(files);
  const r = await worker.fetch(new Request(`${ORIGIN}/admin/api/state`, { headers: { 'cf-access-jwt-assertion': await accessJwt() } }), env());
  const s = await r.json();
  assert.deepEqual(s.photoFolders.map((f) => [f.names.join(' / '), f.parent]), [
    ['Amphitheatre', ROOT], ['General', ROOT], ['Lenches Club', ROOT], ['Lenches Club / Quiz nights', 'folderClub00001'],
    ['Rous Lench', ROOT], ['Rous Lench / Churches', 'folderRousLench'],
  ]);
  assert.equal(s.photosRoot, ROOT);
});

test('New folders: drop into Amphitheatre, a batch where one is stale still moves the others, Undo moves back', async () => {
  const { calls, files } = fakeWorld();
  withNewFolders(files);
  // The panel sends one stale-checked move per photo, in turn (as a multi-select drop does).
  const batch = [
    { id: 'photoChurchA001', expectedParent: 'folderChurches1' },
    { id: 'photoOther00004', expectedParent: 'folderRousLench' }, // stale: it is in General
    { id: 'photoChurchC003', expectedParent: 'folderGeneral01' },
  ];
  const out = [];
  for (const b of batch) out.push(await moveFile(env(), { ...b, to: 'folderAmphi0001' }));
  assert.deepEqual(out.map((r) => r.ok || r.status), [true, 409, true]);
  assert.equal(out[0].folder, 'Lenches Photos / Amphitheatre');
  assert.equal(out[1].currentPath, 'Lenches Photos / General');
  assert.deepEqual(files.photoChurchA001.parents, ['folderAmphi0001']);
  assert.deepEqual(files.photoOther00004.parents, ['folderGeneral01'], 'the stale one is left alone');
  assert.deepEqual(files.photoChurchC003.parents, ['folderAmphi0001']);
  // Undo: the same move back, stale-checked against the folder they were dropped in.
  let r = await moveFile(env(), { id: 'photoChurchA001', expectedParent: 'folderAmphi0001', to: 'folderChurches1' });
  assert.equal(r.ok, true);
  files.photoChurchC003.parents = ['folderClubQuiz1']; // moved on in Drive meanwhile
  r = await moveFile(env(), { id: 'photoChurchC003', expectedParent: 'folderAmphi0001', to: 'folderGeneral01' });
  assert.equal(r.status, 409, 'Undo refuses a photo moved on since');
  assert.equal(r.currentPath, 'Lenches Photos / Lenches Club / Quiz nights');
  assert.deepEqual(files.photoChurchA001.parents, ['folderChurches1']);
  // Into a subfolder of a new folder, and to the top level of Lenches Photos.
  r = await moveFile(env(), { id: 'photoChurchC003', expectedParent: 'folderClubQuiz1', to: 'folderClub00001' });
  assert.equal(r.folder, 'Lenches Photos / Lenches Club');
  assertNeverBins(calls);
  assert.ok(!calls.drive.some((c) => c.method === 'POST'), 'no folder ever created');
});

test('New folders: a move into To delete is refused (it keeps its own Compare copies flow)', async () => {
  const { files } = fakeWorld();
  files.binFolder0001 = folder('binFolder0001', 'To delete', ROOT);
  const r = await moveFile(env(), { id: 'photoOther00004', expectedParent: 'folderGeneral01', to: 'binFolder0001' });
  assert.equal(r.status, 400);
  assert.deepEqual(files.photoOther00004.parents, ['folderGeneral01']);
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

/* ----------------------------------------------------- rename numbering -- */

test('Numbering: core name is the name without extension or trailing -N (1 to 3 digits)', () => {
  assert.deepEqual(nameParts('Bonfire-12.JPG'), { core: 'Bonfire', num: 12, ext: '.JPG', key: 'bonfire\u0000.jpg' });
  assert.deepEqual(nameParts('bonfire.jpg').num, null);
  assert.equal(nameParts('a-2-3.jpg').core, 'a-2', 'only the last -N');
  assert.equal(nameParts('-5.jpg').core, '-5', 'a bare number is a core');
  assert.deepEqual([nameParts('bonfire-999.jpg').core, nameParts('bonfire-999.jpg').num], ['bonfire', 999], 'up to 3 digits is a number');
  assert.deepEqual([nameParts('IMG-3113.jpg').core, nameParts('IMG-3113.jpg').num], ['IMG-3113', null], '4+ digits are part of the core');
});

test('Numbering: no clash, plain clash, existing -2/-5, case, other extensions, no gap filling', () => {
  assert.equal(numberedName('bonfire.jpg', ['hall.jpg', 'bonfires.jpg', 'my bonfire.jpg']), 'bonfire.jpg', 'no clash');
  assert.equal(numberedName('bonfire.jpg', ['bonfire.jpg']), 'bonfire-2.jpg', 'a plain core counts as 1');
  assert.equal(numberedName('bonfire.jpg', ['bonfire.jpg', 'bonfire-2.jpg']), 'bonfire-3.jpg');
  assert.equal(numberedName('bonfire.jpg', ['bonfire-2.jpg', 'bonfire-5.jpg']), 'bonfire-6.jpg', 'highest + 1, gaps not filled');
  assert.equal(numberedName('bonfire.jpg', ['bonfire-5.jpg']), 'bonfire-6.jpg', 'a numbered copy alone is a clash too');
  assert.equal(numberedName('Bonfire.jpg', ['BONFIRE.JPG', 'bonFire-3.Jpg']), 'Bonfire-4.jpg', 'case-insensitive; typed case kept');
  assert.equal(numberedName('bonfire.jpg', ['bonfire.png', 'bonfire.jpeg', 'bonfire']), 'bonfire.jpg', 'other extensions do not clash');
  assert.equal(numberedName('bonfire-2.jpg', ['bonfire.jpg', 'bonfire-2.jpg']), 'bonfire-3.jpg', 'a typed number follows the same rule');
  assert.equal(numberedName('bonfire-2.jpg', ['hall.jpg']), 'bonfire-2.jpg', 'a typed number with no clash is kept');
  assert.equal(numberedName('IMG-5000.jpg', ['IMG-3113.jpg']), 'IMG-5000.jpg', 'camera numbers never clash with each other');
  assert.equal(numberedName('IMG-3113.jpg', ['img-3113.JPG']), 'IMG-3113-2.jpg', 'the same camera name does clash');
});

const bonfireFiles = (extra) => {
  const f = driveFiles();
  f.binFolder0001 = folder('binFolder0001', 'To delete', ROOT);
  Object.assign(f, extra(f));
  return f;
};

test('Rename: a name in use anywhere under Lenches Photos (To delete included) is saved as core-N', async () => {
  const files = bonfireFiles(() => ({
    fileBonfire0001: photo('fileBonfire0001', 'Bonfire.JPG', 'folderChurches1'),
    fileBonfire0002: photo('fileBonfire0002', 'bonfire-4.jpg', 'binFolder0001'),
    fileBonfire0003: photo('fileBonfire0003', 'bonfire-9.jpg', 'folderOutside01'),
    fileBonfire0004: photo('fileBonfire0004', 'bonfire-7.png', 'folderGeneral01'),
  }));
  const w = fakeWorld({ files });
  const r = await renameFile(env(), { id: 'photoChurchB002', expected: 'IMG_3113 (1).jpg', name: 'bonfire' });
  assert.deepEqual(r, { ok: true, name: 'bonfire-5.jpg', wanted: 'bonfire.jpg', numbered: true },
    'To delete counted; outside Lenches Photos and other extensions not');
  assert.equal(files.photoChurchB002.name, 'bonfire-5.jpg');
  assert.equal(w.photos[2][2], 'bonfire-5.jpg', 'Sheet filename follows');
  assert.equal(files.fileBonfire0001.name, 'Bonfire.JPG', 'existing files never renamed');
  assert.equal(files.fileBonfire0002.name, 'bonfire-4.jpg');
  assertNeverBins(w.calls);
});

test('Rename: the file itself does not clash with its own name (a case change)', async () => {
  const files = driveFiles();
  files.photoChurchB002.name = 'bonfire.jpg';
  fakeWorld({ files, photos: photosTable().map((row) => (row[0] === 'photoChurchB002' ? [...row.slice(0, 2), 'bonfire.jpg', ...row.slice(3)] : row)) });
  const r = await renameFile(env(), { id: 'photoChurchB002', expected: 'bonfire.jpg', name: 'Bonfire' });
  assert.equal(r.name, 'Bonfire.jpg');
});

test('Rename: "Will be saved as" preview writes nothing; Save re-checks Drive at write time', async () => {
  const files = bonfireFiles(() => ({ fileBonfire0001: photo('fileBonfire0001', 'bonfire.jpg', 'folderGeneral01') }));
  const { calls } = fakeWorld({ files });
  const p = await previewName(env(), { id: 'photoChurchB002', name: 'bonfire' });
  assert.deepEqual(p, { ok: true, name: 'bonfire-2.jpg', wanted: 'bonfire.jpg', numbered: true });
  assert.ok(!calls.drive.some((c) => c.method !== 'GET') && !calls.writes.length, 'preview writes nothing');
  // Another rename takes bonfire-2 before this one is saved.
  files.fileBonfire0002 = photo('fileBonfire0002', 'bonfire-2.jpg', 'binFolder0001');
  const r = await renameFile(env(), { id: 'photoChurchB002', expected: 'IMG_3113 (1).jpg', name: 'bonfire' });
  assert.equal(r.name, 'bonfire-3.jpg');
  assert.equal(files.photoChurchB002.name, 'bonfire-3.jpg');
  assert.equal((await previewName(env(), { id: 'photoOther00004', name: 'bonfire' })).name, 'bonfire.png', 'preview keeps the file\'s own extension');
});

test('Rename: two renames in the same moment cannot end with the same name', async () => {
  // A rename of a lower-id file lands on the same name just as this one is written.
  const files = bonfireFiles(() => ({
    fileBonfire0001: photo('fileBonfire0001', 'bonfire.jpg', 'folderGeneral01'),
    aaOtherFile0001: photo('aaOtherFile0001', 'x.jpg', 'folderGeneral01'),
  }));
  let raced = false;
  fakeWorld({ files, onPatch: (f, all) => { if (!raced && f.id === 'photoChurchB002') { raced = true; all.aaOtherFile0001.name = f.name; } } });
  const r = await renameFile(env(), { id: 'photoChurchB002', expected: 'IMG_3113 (1).jpg', name: 'bonfire' });
  assert.equal(files.aaOtherFile0001.name, 'bonfire-2.jpg');
  assert.equal(r.name, 'bonfire-3.jpg', 'the higher id gives way');
  assert.equal(files.photoChurchB002.name, 'bonfire-3.jpg');

  // The other way round: this file has the lower id, so it keeps the name.
  const files2 = bonfireFiles(() => ({
    fileBonfire0001: photo('fileBonfire0001', 'bonfire.jpg', 'folderGeneral01'),
    zzOtherFile0001: photo('zzOtherFile0001', 'x.jpg', 'folderGeneral01'),
  }));
  fakeWorld({ files: files2, onPatch: (f, all) => { if (f.id === 'photoChurchB002') all.zzOtherFile0001.name = f.name; } });
  const r2 = await renameFile(env(), { id: 'photoChurchB002', expected: 'IMG_3113 (1).jpg', name: 'bonfire' });
  assert.equal(r2.name, 'bonfire-2.jpg');
});

test('Rename: more files than can be checked is refused, nothing renamed', async () => {
  const files = driveFiles();
  for (let i = 0; i < 20001; i += 1) files[`bulk${String(i).padStart(8, '0')}`] = photo(`bulk${String(i).padStart(8, '0')}`, `b${i}.jpg`, 'folderGeneral01');
  const { calls } = fakeWorld({ files });
  await assert.rejects(renameFile(env(), { id: 'photoChurchB002', expected: 'IMG_3113 (1).jpg', name: 'bonfire' }), /Too many files/);
  assert.ok(!calls.drive.some((c) => c.method === 'PATCH'));
});

test('Router: photo-name preview needs Access and is a GET only', async () => {
  fakeWorld();
  const url = `${ORIGIN}/admin/api/photo-name?id=photoChurchB002&name=${encodeURIComponent('IMG_3113')}`;
  assert.equal((await worker.fetch(new Request(url), env())).status, 403);
  const r = await worker.fetch(new Request(url, { headers: { 'cf-access-jwt-assertion': await accessJwt() } }), env());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, name: 'IMG_3113-2.jpg', wanted: 'IMG_3113.jpg', numbered: true });
});

/* ------------------------------------------------------ on the website -- */

const SITE_LIST = {
  generated: '2026-10-20T06:00:00Z',
  pages: {
    'rous-lench-img-3113': [
      { label: 'Village Halls: Rous Lench Village Hall', url: '/halls/#photo-rous-lench-img-3113' },
      { label: 'Elsewhere', url: 'https://evil.example/' },
    ],
  },
};

test('On the website: links per page, absolute on the live site; other sites dropped', () => {
  const list = { ...SITE_LIST, base: 'https://thelenches.org.uk/' };
  const row = { slug: 'rous-lench-img-3113', published_at: '2026-09-02T05:41:00Z' };
  assert.deepEqual(pagesFor(list, row), [{ label: 'Village Halls: Rous Lench Village Hall', url: 'https://thelenches.org.uk/halls/#photo-rous-lench-img-3113' }]);
  assert.deepEqual(pagesFor(list, { slug: 'not-used', published_at: '2026-09-02T05:41:00Z' }), [], 'published, on no page');
  assert.deepEqual(pagesFor(list, { slug: 'x', published_at: '' }), [], 'not published');
  assert.equal(pagesFor(list, { ...row, published_at: '2026-10-21T05:00:00Z' }), null, 'published after the list was built: unknown');
  assert.equal(pagesFor({ error: 'HTTP 404' }, row), null, 'list unavailable: unknown');
  assert.equal(pagesFor(list, { ...row, slug: '' }), null, 'no slug yet: unknown');
});

test('State: each Photos row carries _pages from the public photo-pages.json', async () => {
  const { calls } = fakeWorld({ site: SITE_LIST });
  const r = await worker.fetch(new Request(`${ORIGIN}/admin/api/state`, { headers: { 'cf-access-jwt-assertion': await accessJwt() } }), env());
  const rows = (await r.json()).photos.rows;
  assert.deepEqual(rows.find((x) => x.drive_id === 'photoChurchA001')._pages,
    [{ label: 'Village Halls: Rous Lench Village Hall', url: 'https://thelenches.org.uk/halls/#photo-rous-lench-img-3113' }]);
  assert.deepEqual(rows.find((x) => x.drive_id === 'photoChurchB002')._pages, []);
  assert.deepEqual(calls.site, [{ method: 'GET', path: '/photo-pages.json' }], 'only reads the public file; nothing sent');
});

test('State: list unavailable = pages unknown (null), the rest of the panel still loads', async () => {
  for (const site of [404, { nonsense: true }]) {
    fakeWorld({ site });
    const r = await worker.fetch(new Request(`${ORIGIN}/admin/api/state`, { headers: { 'cf-access-jwt-assertion': await accessJwt() } }), env());
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.photos.rows.find((x) => x.drive_id === 'photoChurchA001')._pages, null);
    assert.equal(s.photos.rows.length, 5);
  }
});

test('Compare copies: each copy carries its pages (null when unknown)', async () => {
  fakeWorld({ site: SITE_LIST });
  let m = (await dupMembers(env(), 'photoChurchB002')).members;
  assert.equal(m.find((x) => x.drive_id === 'photoChurchA001').pages.length, 1);
  assert.deepEqual(m.find((x) => x.drive_id === 'photoChurchB002').pages, []);
  fakeWorld({ site: 500 });
  m = (await dupMembers(env(), 'photoChurchB002')).members;
  assert.equal(m.find((x) => x.drive_id === 'photoChurchA001').pages, null);
});
