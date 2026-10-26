// scripts/test-suggest.js
// Offline test of suggested images (scripts/suggest) and their use on approval
// (scripts/publish chosenImage) and in the newsletter (credit line). Every web fetch,
// Pexels, Google and the Claude check are mocked; nothing leaves the machine.
// Covers: no-image detection, the match order (own, organiser, library; at most 3, own at
// most 2), og:image/twitter:image/logo parsing, the robots/size/type/timeout guards, no
// personal names in library queries, people flagged and children dropped, and that the run
// writes to the Image suggestions tab only (saving to Lenches Photos happens only on Choose,
// tested in worker/test/suggest.test.mjs).
// Run: node scripts/test-suggest.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const web = require('./suggest/web');
const { libraryQuery, searchLibrary, librarySource, VOCAB } = require('./suggest/library');
const { ownMatches } = require('./suggest/own');
const { organiserUrls, extractLinks, senderHome } = require('./suggest/organiser');
const suggest = require('./suggest/index');
const g = require('./ingest/google');

const ROOT = path.join(__dirname, '..');
const photos = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', '_data', 'photos.json'), 'utf8'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------- web mock -- */

let routes = {};
const fetched = [];
global.fetch = async (input, init = {}) => {
  const url = String(input);
  fetched.push({ url, init });
  assert.ok(init.signal || /api\.pexels\.com/.test(url), `every fetch has a timeout: ${url}`);
  const r = routes[url];
  if (!r) return new Response('not found', { status: 404 });
  return typeof r === 'function' ? r(init) : r.clone();
};
const resp = (body, type, extra = {}) => new Response(body, { status: 200, headers: { 'content-type': type, ...extra } });
const html = (s) => resp(s, 'text/html; charset=utf-8');

let JPEG; let PNG; let GIF; let SMALL;
async function images() {
  const img = (w, h, c) => sharp({ create: { width: w, height: h, channels: 3, background: c } });
  JPEG = await img(800, 500, '#7a9').jpeg().toBuffer();
  PNG = await img(600, 400, '#a97').png().toBuffer();
  GIF = await img(600, 400, '#79a').gif().toBuffer();
  SMALL = await img(200, 100, '#999').jpeg().toBuffer();
}

/* ---------------------------------------------------------------- tests -- */

test('No-image detection: only pending, upcoming, non-feed events with no image or choice', () => {
  const today = '2026-10-24';
  const base = { status: 'pending', category: 'event', event_date: '2026-11-01', id: 'm1-1', message_id: 'm1' };
  const yes = (r) => assert.strictEqual(suggest.needsImage({ ...base, ...r }, today), true, JSON.stringify(r));
  const no = (r) => assert.strictEqual(suggest.needsImage({ ...base, ...r }, today), false, JSON.stringify(r));
  yes({});
  yes({ event_date: '2026-10-24' });
  yes({ event_date: '01/11/2026' });
  no({ image_part_id: '2' });
  no({ image_url: '/images/items/m1-1.webp' });
  no({ image_url: 'none' });
  no({ image_url: 'failed: x' });
  no({ image_choice: 'none' });
  no({ image_choice: 'm1-1#1' });
  no({ status: 'approved' });
  no({ category: 'notice' });
  no({ event_date: '' });
  no({ event_date: '2026-10-23' });
  no({ id: 'rss-abc', message_id: 'rss:feed' });
});

test('Own photos: venue/village matches, event-specific photos only for their event, no people first', () => {
  const hall = ownMatches({ title: 'Quiz night — Rous Lench Village Hall', summary: 'At the village hall.', village: 'Rous Lench' }, photos);
  assert.ok(hall.length >= 1 && hall.length <= 2);
  assert.ok(hall.every((m) => m.photo.village === 'Rous Lench'));
  assert.ok(/hall/i.test(hall[0].photo.alt), 'the village hall photo comes first');
  // A photo made for one event (target event:gloquiz) is offered for that event only.
  const glo = ownMatches({ title: 'Glo-Quiz — The Lenches Club', summary: '' }, photos);
  assert.ok(glo.some((m) => (m.photo.targets || []).includes('event:gloquiz')));
  const other = ownMatches({ title: 'Bonfire night — Church Lench', summary: '', village: 'Church Lench' }, photos);
  assert.ok(!other.some((m) => (m.photo.targets || []).includes('event:gloquiz')), 'not offered for another event');
  assert.strictEqual(ownMatches({ title: 'Talk in Alcester', summary: '' }, photos).length, 0);
  // People: of two equal matches, "none" before "identifiable".
  const two = [
    { slug: 'a-people', src: '/images/photos/a-people.webp', village: 'Rous Lench', alt: 'x', targets: [] },
    { slug: 'b-empty', src: '/images/photos/b-empty.webp', village: 'Rous Lench', alt: 'x', targets: [] },
  ];
  const ranked = ownMatches({ title: 'Fete', village: 'Rous Lench' }, two, new Map([['a-people', 'identifiable'], ['b-empty', 'none']]));
  assert.deepStrictEqual(ranked.map((m) => m.photo.slug), ['b-empty', 'a-people']);
});

test('Parsing: og:image, then twitter:image, then a logo; relative addresses made absolute', () => {
  const p = web.pageImages(`<html><head><title>Hall</title><meta property="og:site_name" content="Rous Lench Village Hall">
    <meta property="og:image" content="/img/quiz.jpg"><meta name="twitter:image" content="https://cdn.example.org/tw.jpg"></head>
    <body><img class="site-logo" src="/logo.png"></body></html>`, 'https://hall.example.org/events/quiz');
  assert.strictEqual(p.og, 'https://hall.example.org/img/quiz.jpg');
  assert.strictEqual(p.twitter, 'https://cdn.example.org/tw.jpg');
  assert.strictEqual(p.logo, 'https://hall.example.org/logo.png');
  assert.strictEqual(p.siteName, 'Rous Lench Village Hall');
  const ld = web.pageImages('<script type="application/ld+json">{"@type":"Organization","logo":{"url":"https://x.org/l.png"}}</script>', 'https://x.org/');
  assert.strictEqual(ld.logo, 'https://x.org/l.png');
  const touch = web.pageImages('<link rel="apple-touch-icon" href="/apple.png">', 'https://y.org/a');
  assert.strictEqual(touch.logo, 'https://y.org/apple.png');
  const none = web.pageImages('<meta property="og:image" content="/x.svg"><p>hi</p>', 'https://z.org/');
  assert.strictEqual(none.og, '', 'SVG is never taken');
});

test('Guards: robots.txt, 5 MB limit (even without Content-Length), JPEG/PNG/WebP only, 10 s timeout', async () => {
  web.resetRobots();
  assert.strictEqual(web.TIMEOUT_MS, 10000);
  assert.strictEqual(web.MAX_BYTES, 5 * 1024 * 1024);
  routes = {
    'https://shy.example.org/robots.txt': resp('User-agent: *\nDisallow: /', 'text/plain'),
    'https://shy.example.org/page': html('<meta property="og:image" content="/a.jpg">'),
    'https://ok.example.org/robots.txt': resp('User-agent: *\nDisallow: /private/', 'text/plain'),
    'https://ok.example.org/a.jpg': resp(JPEG, 'image/jpeg'),
    'https://ok.example.org/b.png': resp(PNG, 'image/png'),
    'https://ok.example.org/c.gif': resp(GIF, 'image/gif'),
    'https://ok.example.org/lie.jpg': resp(GIF, 'image/jpeg'),
    'https://ok.example.org/page.jpg': resp('<html></html>', 'text/html'),
    'https://ok.example.org/private/x.jpg': resp(JPEG, 'image/jpeg'),
    'https://ok.example.org/big.jpg': () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 6; i += 1) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); },
    }), { headers: { 'content-type': 'image/jpeg' } }),
    'https://ok.example.org/declared.jpg': resp(JPEG, 'image/jpeg', { 'content-length': String(6 * 1024 * 1024) }),
  };
  await assert.rejects(web.fetchPage('https://shy.example.org/page'), /robots/);
  assert.strictEqual((await web.fetchImage('https://ok.example.org/a.jpg')).ext, 'jpg');
  assert.strictEqual((await web.fetchImage('https://ok.example.org/b.png')).ext, 'png');
  await assert.rejects(web.fetchImage('https://ok.example.org/c.gif'), /JPEG, PNG or WebP/);
  await assert.rejects(web.fetchImage('https://ok.example.org/lie.jpg'), /JPEG, PNG or WebP/);
  await assert.rejects(web.fetchImage('https://ok.example.org/page.jpg'), /JPEG, PNG or WebP/);
  await assert.rejects(web.fetchImage('https://ok.example.org/private/x.jpg'), /robots/);
  await assert.rejects(web.fetchImage('https://ok.example.org/big.jpg'), /larger than 5 MB/);
  await assert.rejects(web.fetchImage('https://ok.example.org/declared.jpg'), /larger than 5 MB/);
  await assert.rejects(web.fetchImage('https://www.facebook.com/a.jpg'), /not fetched/);
  await assert.rejects(web.fetchImage('https://thelenches.org.uk/a.jpg'), /not fetched/);
  // Library images skip robots (Pexels gives the address through its API) but keep the other guards.
  routes['https://shy.example.org/lib.jpg'] = resp(JPEG, 'image/jpeg');
  assert.strictEqual((await web.fetchImage('https://shy.example.org/lib.jpg', { robots: false })).ext, 'jpg');
  // A timed-out fetch is an error like any other (the signal aborts it).
  const before = global.fetch;
  global.fetch = (u, init) => new Promise((resolve, reject) => {
    assert.ok(init.signal instanceof AbortSignal);
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    setTimeout(() => reject(new Error('timed out (test)')), 50);
  });
  await assert.rejects(web.fetchImage('https://slow.example.org/a.jpg', { robots: false }), /timed out|aborted/);
  global.fetch = before;
});

test('Organiser addresses: item link, email links, sender domain (never webmail, social or our own)', () => {
  assert.deepStrictEqual(extractLinks('See https://hall.example.org/quiz. Or https://facebook.com/x and https://hall.example.org/quiz, flyer https://a.org/f.pdf https://list.example.org/unsubscribe?id=1'),
    ['https://hall.example.org/quiz']);
  assert.strictEqual(senderHome('Hall <sec@hall.example.org>'), 'https://hall.example.org/');
  for (const w of ['a@gmail.com', 'a@hotmail.co.uk', 'a@btinternet.com', 'a@thelenches.org.uk', 'a@icloud.com']) assert.strictEqual(senderHome(w), '');
  assert.deepStrictEqual(organiserUrls({
    link_url: 'https://club.example.org/events', links: 'https://club.example.org/events https://bit.ly/x https://other.example.org/', from: 'x@club.example.org',
  }), ['https://club.example.org/events', 'https://other.example.org/', 'https://club.example.org/']);
  assert.deepStrictEqual(organiserUrls({ link_url: 'mailto:a@b.c', links: '', from: 'a@gmail.com' }), []);
});

test('Library queries: event type and kind of place only, never a personal name', () => {
  assert.strictEqual(libraryQuery({ title: 'Quiz night — Rous Lench Village Hall', summary: '' }), 'quiz night village hall');
  assert.strictEqual(libraryQuery({ title: 'Bonfire and fireworks', summary: '' }), 'fireworks night');
  assert.strictEqual(libraryQuery({ title: 'Meeting of the committee', summary: '' }), '', 'unknown type: no search');
  const names = ['Mike Tindall', 'Angela Barnes', 'Phil Taylor', 'John Smith', 'Jane Doe', 'Nadine', 'The Cavern Beatles'];
  const titles = [
    'An Evening With Mike Tindall', 'Evesham Comedy Club with Angela Barnes', 'An Evening with Phil Taylor: darts legend',
    'Talk by John Smith on local history', 'Jane Doe sings jazz at the Fleece Inn', 'Coffee morning hosted by Nadine',
    'The Cavern Beatles live concert at the church', 'Craft fair with Jane Doe', 'Dog show judged by John Smith',
  ];
  for (const t of titles) {
    const q = libraryQuery({ title: t, summary: `Organised by ${names.join(', ')}. Call John on 01386 000000.` });
    for (const w of q.split(' ').filter(Boolean)) assert.ok(VOCAB.has(w), `"${w}" in "${q}" is from the fixed list`);
    for (const n of names) for (const part of n.toLowerCase().split(' ')) {
      if (part.length > 3 && part !== 'cavern' && part !== 'beatles') assert.ok(!q.includes(part), `"${q}" contains no name (${n})`);
    }
    assert.ok(!/beatles|cavern|tindall|barnes|taylor|smith|doe|nadine/.test(q), q);
  }
});

test('Library search: Pexels key in the header, credit and licence as Pexels asks', async () => {
  routes = {
    'https://api.pexels.com/v1/search?query=quiz+night&per_page=4&orientation=landscape&locale=en-GB': (init) => {
      assert.strictEqual(init.headers.Authorization, 'k123');
      return resp(JSON.stringify({ photos: [{ id: 1, url: 'https://www.pexels.com/photo/quiz-1/', photographer: 'Jane Doe', alt: 'Quiz cards', src: { large: 'https://images.pexels.com/1.jpeg' } }] }), 'application/json');
    },
  };
  const got = await searchLibrary('quiz night', { key: 'k123' });
  assert.deepStrictEqual(got[0], {
    url: 'https://images.pexels.com/1.jpeg', page: 'https://www.pexels.com/photo/quiz-1/', credit: 'Photo by Jane Doe on Pexels', short: 'Jane Doe / Pexels',
    creditUrl: 'https://www.pexels.com/photo/quiz-1/', licence: 'https://www.pexels.com/license/', alt: 'Quiz cards', text: 'Quiz cards',
  });
  assert.deepStrictEqual(await searchLibrary('quiz night', { key: '' }), [], 'no key, no search');
});

test('Library choice: Pexels if its key is set, else Pixabay, else none', () => {
  assert.deepStrictEqual(librarySource({ PEXELS_API_KEY: 'p', PIXABAY_API_KEY: 'x' }), { provider: 'pexels', name: 'Pexels', key: 'p' });
  assert.deepStrictEqual(librarySource({ PEXELS_API_KEY: ' ', PIXABAY_API_KEY: 'x' }), { provider: 'pixabay', name: 'Pixabay', key: 'x' });
  assert.strictEqual(librarySource({}), null);
});

test('Library search: Pixabay key in the query, photos only, credit and licence as Pixabay asks', async () => {
  routes = {
    'https://pixabay.com/api/?key=x9&q=quiz+night&image_type=photo&orientation=horizontal&safesearch=true&lang=en&per_page=4': resp(JSON.stringify({ hits: [
      { pageURL: 'https://pixabay.com/photos/quiz-1/', user: 'Jo <b>Lee', tags: 'quiz, cards', largeImageURL: 'https://pixabay.com/get/1.jpg' },
      { pageURL: 'https://pixabay.com/photos/2/', user: 'X', tags: '', largeImageURL: 'http://insecure.example/2.jpg' },
    ] }), 'application/json'),
  };
  const got = await searchLibrary('quiz night', { provider: 'pixabay', key: 'x9' });
  assert.strictEqual(got.length, 1, 'https images only');
  assert.deepStrictEqual(got[0], {
    url: 'https://pixabay.com/get/1.jpg', page: 'https://pixabay.com/photos/quiz-1/', credit: 'Image by Jo bLee from Pixabay', short: 'Jo bLee / Pixabay',
    creditUrl: 'https://pixabay.com/photos/quiz-1/', licence: 'https://pixabay.com/service/license-summary/', alt: '', text: 'quiz, cards',
  });
  assert.ok(fetched[fetched.length - 1].init.signal, 'Pixabay fetch has a timeout');
  assert.deepStrictEqual(await searchLibrary('quiz night', { provider: 'pixabay', key: '' }), [], 'no key, no search');
});

const okCheck = (over = {}) => async () => ({ kind: 'photo', people: 'none', performer: false, stock: 'unlikely', relevant: true, organiser: 'Rous Lench Village Hall', reason: 'Fine.', ...over });
function orgRoutes() {
  web.resetRobots();
  routes = {
    'https://hall.example.org/robots.txt': resp('', 'text/plain'),
    'https://hall.example.org/quiz': html('<title>Quiz</title><meta property="og:site_name" content="Rous Lench Village Hall"><meta property="og:image" content="https://hall.example.org/quiz.jpg">'),
    'https://hall.example.org/quiz.jpg': resp(JPEG, 'image/jpeg'),
    'https://api.pexels.com/v1/search?query=quiz+night+village+hall&per_page=4&orientation=landscape&locale=en-GB': resp(JSON.stringify({ photos: [
      { url: 'https://www.pexels.com/photo/1/', photographer: 'Ann Lee', alt: 'Quiz sheets', src: { large: 'https://images.pexels.com/1.jpeg' } },
      { url: 'https://www.pexels.com/photo/2/', photographer: 'Bo Ray', alt: 'Hall', src: { large: 'https://images.pexels.com/2.jpeg' } },
      { url: 'https://www.pexels.com/photo/3/', photographer: 'Cy Doe', alt: 'Pens', src: { large: 'https://images.pexels.com/3.jpeg' } },
    ] }), 'application/json'),
    'https://images.pexels.com/1.jpeg': resp(JPEG, 'image/jpeg'),
    'https://images.pexels.com/2.jpeg': resp(PNG, 'image/png'),
    'https://images.pexels.com/3.jpeg': resp(JPEG, 'image/jpeg'),
  };
}
const quizRow = (over = {}) => ({
  id: 'm9-1', status: 'pending', category: 'event', event_date: '2026-11-14', title: 'Quiz night — Rous Lench Village Hall',
  summary: 'Teams of six at the village hall.', village: 'Rous Lench', link_url: 'https://hall.example.org/quiz', links: '',
  from: 'Hall <sec@hall.example.org>', ...over,
});
const ctxFor = (check, over = {}) => ({ today: '2026-10-24', photos, people: new Map(), library: { provider: 'pexels', name: 'Pexels', key: 'k' }, check, ...over });

test('Match order: own photos (at most 2), then organiser, capped at 3; library only to fill', async () => {
  orgRoutes();
  fetched.length = 0;
  const rows = await suggest.suggestFor(quizRow(), ctxFor(okCheck()));
  const own = rows.filter((r) => r.source === 'own');
  assert.ok(own.length >= 1 && own.length <= 2);
  assert.deepStrictEqual(rows.map((r) => r.source), [...own.map(() => 'own'), 'organiser', ...(own.length === 1 ? ['library'] : [])]);
  assert.ok(rows.length <= 3);
  assert.deepStrictEqual(rows.map((r) => r.id), rows.map((r, i) => `m9-1#${i + 1}`));
  const org = rows.find((r) => r.source === 'organiser');
  assert.strictEqual(org.url, 'https://hall.example.org/quiz.jpg');
  assert.strictEqual(org.credit, 'Rous Lench Village Hall');
  assert.strictEqual(org.caption, 'Image: Rous Lench Village Hall');
  assert.strictEqual(org.page, 'https://hall.example.org/quiz');
  assert.ok(/^data:image\/jpeg;base64,/.test(org.thumb) && org.thumb.length < 45000, 'thumbnail fits a Sheet cell');
  assert.strictEqual(org.village, 'Rous Lench');
  assert.strictEqual(org.event, '2026-11-14|Quiz night — Rous Lench Village Hall');
  if (own.length === 2) assert.ok(!fetched.some((f) => /pexels/.test(f.url)), 'library not searched when full');

  // No own photo: organiser first, then the library fills to 3.
  orgRoutes();
  const away = await suggest.suggestFor(quizRow({ village: 'Alcester', title: 'Quiz night — Alcester Village Hall', summary: 'At the village hall.' }), ctxFor(okCheck()));
  assert.deepStrictEqual(away.map((r) => r.source), ['organiser', 'library', 'library']);
  assert.strictEqual(away[1].caption, 'Photo by Ann Lee on Pexels');
  assert.strictEqual(away[1].credit_url, 'https://www.pexels.com/photo/1/');
  assert.strictEqual(away[1].licence, 'https://www.pexels.com/license/');
  assert.strictEqual(away[1].credit, 'Ann Lee / Pexels');

  // No key: no library.
  orgRoutes();
  const nokey = await suggest.suggestFor(quizRow({ village: 'Alcester', title: 'Quiz night — Alcester Village Hall' }), ctxFor(okCheck(), { library: null }));
  assert.deepStrictEqual(nokey.map((r) => r.source), ['organiser']);
});

test('People and children: identifiable flagged, children dropped, logos only as the organiser fallback', async () => {
  assert.deepStrictEqual(suggest.judge({ people: 'children', kind: 'photo', relevant: true }, 'og:image'), { drop: 'shows children' });
  assert.deepStrictEqual(suggest.judge({ people: 'identifiable', kind: 'photo', relevant: true }, 'og:image'), { people: 'identifiable' });
  assert.deepStrictEqual(suggest.judge({ people: 'none', kind: 'logo', relevant: true }, 'og:image'), { drop: 'a logo' });
  assert.deepStrictEqual(suggest.judge({ people: 'none', kind: 'logo', relevant: true }, 'logo'), { people: 'none' });
  assert.deepStrictEqual(suggest.judge({ people: 'none', kind: 'screenshot', relevant: true }, 'og:image'), { drop: 'a screenshot' });

  orgRoutes();
  const byUrl = { 'https://hall.example.org/quiz.jpg': 'identifiable', 'https://images.pexels.com/1.jpeg': 'children', 'https://images.pexels.com/2.jpeg': 'none', 'https://images.pexels.com/3.jpeg': 'children' };
  const check = async (buf, info) => (await okCheck({ people: byUrl[info.imageUrl] })());
  const rows = await suggest.suggestFor(quizRow({ village: 'Alcester', title: 'Quiz night — Alcester Village Hall' }), ctxFor(check));
  assert.deepStrictEqual(rows.map((r) => [r.source, r.people, r.url]), [
    ['organiser', 'identifiable', 'https://hall.example.org/quiz.jpg'],
    ['library', 'none', 'https://images.pexels.com/2.jpeg'],
  ]);

  // Everything dropped: one "none" row so the event isn't retried.
  orgRoutes();
  const none = await suggest.suggestFor(quizRow({ village: 'Alcester', title: 'Quiz night — Alcester Village Hall' }), ctxFor(okCheck({ people: 'children' })));
  assert.strictEqual(none.length, 1);
  assert.strictEqual(none[0].source, 'none');
  assert.strictEqual(none[0].id, 'm9-1#0');
  assert.ok(/children/.test(none[0].check));
});

test('The run writes to the Image suggestions tab only (never Image fetch, Photos or Pending)', async () => {
  orgRoutes();
  const appended = [];
  const orig = { readHeaders: g.readHeaders, readTable: g.readTable, appendRows: g.appendRows, updateRow: g.updateRow };
  g.readHeaders = async () => suggest.HEADERS.slice();
  g.readTable = async (tab) => {
    if (tab === 'Pending') return [quizRow({ village: 'Alcester', title: 'Quiz night — Alcester Village Hall', event_date: '2099-01-01' }), quizRow({ id: 'm9-2', image_part_id: '2', event_date: '2099-01-01' })];
    if (tab === 'Photos') return [];
    return [];
  };
  g.appendRows = async (tab, rows) => { appended.push([tab, rows]); };
  g.updateRow = async () => { throw new Error('the run must not update rows'); };
  try {
    await suggest.main({ check: okCheck() });
  } finally {
    Object.assign(g, orig);
  }
  assert.deepStrictEqual(appended.map(([t]) => t), ['Image suggestions']);
  assert.deepStrictEqual([...new Set(appended[0][1].map((r) => r.item))], ['m9-1'], 'only the item with no image');
});

test('Publish: a chosen own photo is copied, an external one downloaded; caption and alt filled', async () => {
  const { chosenImage } = require('./publish/index');
  const ownSlug = photos.find((p) => p.village === 'Rous Lench').slug;
  const id = 'zztest-suggest-1';
  const dest = path.join(ROOT, 'src', 'images', 'items', `${id}.webp`);
  const sugg = new Map([
    [`${id}#1`, { id: `${id}#1`, item: id, source: 'own', url: `/images/photos/${ownSlug}.webp`, caption: '', credit_url: '', alt: 'A hall' }],
    [`${id}#2`, { id: `${id}#2`, item: id, source: 'organiser', url: 'https://hall.example.org/quiz.jpg', caption: 'Image: Rous Lench Village Hall', credit_url: 'https://hall.example.org/quiz', alt: '' }],
    [`${id}#3`, { id: `${id}#3`, item: 'someone-else', source: 'own', url: `/images/photos/${ownSlug}.webp` }],
  ]);
  try {
    const a = await chosenImage({ id, image_choice: `${id}#1`, alt_text: '' }, sugg);
    assert.strictEqual(a.url, `/images/items/${id}.webp`);
    assert.deepStrictEqual(a.fields, { image_url: a.url, alt_text: 'A hall' });
    assert.ok(fs.existsSync(dest));
    orgRoutes();
    const b = await chosenImage({ id, image_choice: `${id}#2`, alt_text: 'Kept' }, sugg);
    assert.deepStrictEqual(b.fields, { image_url: b.url, image_credit: 'Image: Rous Lench Village Hall', image_credit_url: 'https://hall.example.org/quiz' });
    await assert.rejects(chosenImage({ id, image_choice: `${id}#3` }, sugg), /not found/, 'a suggestion for another item is never used');
    await assert.rejects(chosenImage({ id, image_choice: `${id}#9` }, sugg), /not found/);
    await assert.rejects(chosenImage({ id, image_choice: `${id}#1` }, null), /not found/);
  } finally {
    fs.rmSync(dest, { force: true });
  }
});

test('Newsletter: a credited image gets its caption line; others are unchanged', () => {
  const { select } = require('./newsletter/select');
  const { render } = require('./newsletter/render');
  const ev = (id, title, over) => ({
    id, status: 'approved', title, summary: 'Details.', category: 'event', event_date: '2026-11-05', received: '2026-10-25 09:00',
    decided_at: '2026-10-25', image_url: `/images/items/${id}.webp`, alt_text: 'Flyer', ...over,
  });
  const model = select({
    issueDate: '2026-10-29',
    pending: [
      ev('n1-1', 'Quiz night', { image_credit: 'Image: Rous Lench Village Hall', image_credit_url: 'https://hall.example.org/quiz' }),
      ev('n2-1', 'Bonfire', { image_credit: 'Photo by Jane Doe on Pexels', image_credit_url: 'javascript:alert(1)' }),
      ev('n3-1', 'Craft fair', {}),
    ],
    whatson: { events: [], notices: [] }, bins: {}, siteupdates: { entries: [] }, issues: [], settings: {}, sources: [],
    jpegFor: (u) => `https://thelenches.org.uk${u.replace(/\.webp$/, '.jpg')}`,
  });
  const { html, text } = render(model);
  assert.ok(html.includes('<a href="https://hall.example.org/quiz"') && html.includes('Image: Rous Lench Village Hall</a>'));
  assert.ok(html.includes('Photo by Jane Doe on Pexels') && !html.includes('javascript:'), 'only https credit links');
  assert.strictEqual((html.match(/font-size:11px;line-height:1.4/g) || []).length, 2, 'one caption per credited image');
  assert.ok(typeof text === 'string');
  if (process.env.PREVIEW) fs.writeFileSync(process.env.PREVIEW, html);
});

(async () => {
  await images();
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); } catch (err) { failed += 1; console.error(`not ok - ${name}\n${err.stack}`); }
  }
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('All suggestion tests passed.');
})();
