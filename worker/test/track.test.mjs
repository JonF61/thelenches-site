// worker/test/track.test.mjs
// Offline tests for the anonymous newsletter counts: links signed by
// scripts/newsletter/track.js and checked by the Worker's /c (worker/src/track.js), the /o
// image, and the panel's Newsletter stats sums (admin/nlstats.js). No network.
// Run: node --test worker/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleClick, handleOpen, verifyClick } from '../src/track.js';
import { sentIssues, openTimes, nlStats } from '../src/admin/nlstats.js';

const require = createRequire(import.meta.url);
process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(32);
process.env.WORKER_URL = 'https://approvals.example.workers.dev';
const { trackIssue } = require('../../scripts/newsletter/track.js');

const points = [];
const env = { APPROVAL_SIGNING_KEY: 'k'.repeat(32), NL_STATS: { writeDataPoint: (p) => points.push(p) } };

const issue = {
  html: '<html><body><a href="https://thelenches.org.uk/events/">Events</a> <a href="https://example.org/a?x=1&amp;y=2">Book</a>'
    + ' <a href="mailto:website@thelenches.org.uk">mail</a> <a href="%%UNSUBSCRIBE_URL%%">unsubscribe</a>'
    + ' <a href="https://approvals.example.workers.dev/u?t=abc">own</a></body></html>',
  text: 'Events: https://thelenches.org.uk/events/',
};

test('send-time links: counted via /c, the open image added, nothing else touched', async () => {
  const t = trackIssue(issue, '2026-10-29');
  assert.equal(t.trackedLinks, 2);
  assert.equal(t.text, issue.text);
  assert.match(t.html, /href="mailto:website@thelenches\.org\.uk"/);
  assert.match(t.html, /href="%%UNSUBSCRIBE_URL%%"/);
  assert.match(t.html, /href="https:\/\/approvals\.example\.workers\.dev\/u\?t=abc"/);
  assert.match(t.html, /<img src="https:\/\/approvals\.example\.workers\.dev\/o\?i=2026-10-29" width="1" height="1" alt=""[^>]*><\/body>/);
  const hrefs = [...t.html.matchAll(/href="(https:\/\/approvals\.example\.workers\.dev\/c\?t=[^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 2);
  // The Worker accepts them: counts, then sends the reader on (the &amp; unescaped).
  const r = await handleClick(new Request(hrefs[1]), env);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.org/a?x=1&y=2');
  assert.deepEqual(points.pop(), { blobs: ['click', '2026-10-29', 'https://example.org/a?x=1&y=2'], doubles: [1], indexes: ['2026-10-29'] });
  assert.throws(() => trackIssue(issue, 'bad'), /Bad issue date/);
});

test('/c refuses tampered or foreign tokens and counts nothing', async () => {
  const t = trackIssue(issue, '2026-10-29');
  const href = t.html.match(/href="(https:\/\/approvals\.example\.workers\.dev\/c\?t=[^"]+)"/)[1];
  const before = points.length;
  const bad = await handleClick(new Request(href.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), env);
  assert.equal(bad.status, 400);
  assert.equal((await handleClick(new Request(href), { ...env, APPROVAL_SIGNING_KEY: 'other'.repeat(8) })).status, 400);
  assert.equal(await verifyClick('', env.APPROVAL_SIGNING_KEY), null);
  assert.equal(points.length, before);
  // No Analytics Engine binding: the reader still gets through.
  assert.equal((await handleClick(new Request(href), { APPROVAL_SIGNING_KEY: env.APPROVAL_SIGNING_KEY })).status, 302);
});

test('/o: a 1x1 GIF, counted only for a real issue date', async () => {
  const before = points.length;
  const r = handleOpen(new Request('https://w/o?i=2026-10-29'), env);
  assert.equal(r.headers.get('content-type'), 'image/gif');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal((await r.arrayBuffer()).byteLength > 20, true);
  handleOpen(new Request('https://w/o?i=nonsense'), env);
  assert.equal(points.length, before + 1);
  assert.deepEqual(points.pop().blobs, ['open', '2026-10-29', '']);
});

test('stats: sent issues, bounces in the week after, opens by UK day and hour', async () => {
  const issues = [
    { issue_date: '2026-10-22', issue_id: '2026-10-22', status: 'sent', recipients: '420' },
    { issue_date: '2026-10-29', issue_id: '2026-10-29', status: 'tested' },
    { issue_date: '2026-10-15', issue_id: '2026-10-15', status: 'sent', recipients: '410' },
  ];
  const sends = [{ issue_id: '2026-10-22', status: 'sent' }, { issue_id: '2026-10-22', status: 'sent' }, { issue_id: '2026-10-22:canary', status: 'sent' }];
  const dns = [{ reason: 'Hard bounce (daily diagnostic)', added_at: '2026-10-24T02:07:00Z' }, { reason: 'unsubscribe link', date: '2026-10-23' }];
  assert.deepEqual(sentIssues(issues, sends, dns), [{ date: '2026-10-22', sent: 2, bounced: 1 }, { date: '2026-10-15', sent: 410, bounced: 0 }]);
  const t = openTimes([{ h: '2026-10-22 07:00:00', n: '10' }, { h: '2026-10-22 08:00:00', n: 5 }, { h: '2026-10-23 07:00:00', n: 2 }]);
  assert.deepEqual(t.days, [{ day: '2026-10-22', n: 15 }, { day: '2026-10-23', n: 2 }]);
  assert.deepEqual(t.hours[0], { hour: 8, n: 12 }); // 07:00 UTC is 8am BST
  const off = await nlStats({}, { issues, sends, dns });
  assert.equal(off.on, false);
  assert.equal(off.issues[0].opens, null);
});

test('stats: Analytics Engine totals and one issue in detail (SQL mocked)', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push({ url, body: init.body, auth: init.headers.authorization });
    const q = init.body;
    const data = /GROUP BY kind, issue/.test(q) ? [{ kind: 'open', issue: '2026-10-22', n: '231' }, { kind: 'click', issue: '2026-10-22', n: 64 }]
      : /toStartOfHour/.test(q) ? [{ h: '2026-10-22 07:00:00', n: 74 }]
        : [{ url: 'https://thelenches.org.uk/events/', n: '41' }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  try {
    const s = await nlStats({ CF_ANALYTICS_TOKEN: 'tok', CF_ACCOUNT_ID: 'a'.repeat(32) },
      { issues: [{ issue_date: '2026-10-22', status: 'sent', recipients: '425' }], sends: [], dns: [] }, '2026-10-22');
    assert.equal(s.on, true);
    assert.deepEqual(s.issues[0], { date: '2026-10-22', sent: 425, bounced: 0, opens: 231, clicks: 64 });
    assert.deepEqual(s.detail.links, [{ url: 'https://thelenches.org.uk/events/', n: 41 }]);
    assert.deepEqual(s.detail.hours, [{ hour: 8, n: 74 }]);
    assert.match(asked[0].url, /\/accounts\/a{32}\/analytics_engine\/sql$/);
    assert.equal(asked[0].auth, 'Bearer tok');
    assert.ok(asked.slice(1).every((a) => a.body.includes("blob2 = '2026-10-22'")));
  } finally {
    globalThis.fetch = real;
  }
});
