// worker/test/seo.test.mjs: the SEO screen's Search Console figures (admin/seo.js, 26 Nov 2026),
// against a mocked Google: property choice, the read-only scope, figures by page path, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchConsole, pickProperty, resetConsoleCache } from '../src/admin/seo.js';
import { resetTokenCache, SCOPES, checkScope } from '../src/admin/google.js';

const key = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const env = { GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: pem }), SITE_URL: 'https://thelenches.org.uk/' };

test('pickProperty: a Domain property first, else the URL-prefix one, else none', () => {
  assert.equal(pickProperty([{ siteUrl: 'https://thelenches.org.uk/' }, { siteUrl: 'sc-domain:thelenches.org.uk' }], 'https://thelenches.org.uk/'), 'sc-domain:thelenches.org.uk');
  assert.equal(pickProperty([{ siteUrl: 'https://www.thelenches.org.uk/' }], 'https://thelenches.org.uk/'), 'https://www.thelenches.org.uk/');
  assert.equal(pickProperty([{ siteUrl: 'sc-domain:harvingtonvillage.org.uk' }], 'https://thelenches.org.uk/'), '');
});

test('the Search Console scope is read-only and never impersonates', () => {
  assert.equal(SCOPES.searchConsole, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.doesNotThrow(() => checkScope(SCOPES.searchConsole));
  assert.throws(() => checkScope(SCOPES.searchConsole, 'someone@example.org'));
  assert.throws(() => checkScope('https://www.googleapis.com/auth/webmasters'));
});

test('searchConsole: totals, top searches and figures by page path', async () => {
  resetTokenCache(); resetConsoleCache();
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    seen.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(String(init.body.get('assertion')).split('.')[1], 'base64url'));
      assert.equal(claims.scope, SCOPES.searchConsole);
      assert.equal(claims.sub, undefined);
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    }
    if (url.endsWith('/sites')) return new Response(JSON.stringify({ siteEntry: [{ siteUrl: 'sc-domain:thelenches.org.uk' }] }));
    const body = JSON.parse(init.body);
    assert.equal(body.startDate, '2026-10-27');
    assert.equal(body.endDate, '2026-11-23');
    if (!body.dimensions) return new Response(JSON.stringify({ rows: [{ clicks: 40, impressions: 900, position: 12.34 }] }));
    if (body.dimensions[0] === 'query') return new Response(JSON.stringify({ rows: [{ keys: ['lenches bin collection'], clicks: 5, impressions: 60, position: 3.21 }] }));
    return new Response(JSON.stringify({ rows: [{ keys: ['https://thelenches.org.uk/bins/'], clicks: 9, impressions: 120, position: 4.5 }, { keys: ['https://thelenches.org.uk/'], clicks: 3, impressions: 50, position: 7 }] }));
  };
  const d = await searchConsole(env, { now: new Date('2026-11-26T10:00:00Z') });
  assert.equal(d.property, 'sc-domain:thelenches.org.uk');
  assert.deepEqual(d.totals, { clicks: 40, impressions: 900, position: 12.3 });
  assert.deepEqual(d.queries, [{ key: 'lenches bin collection', clicks: 5, impressions: 60, position: 3.2 }]);
  assert.equal(d.pages['/bins/'].clicks, 9);
  assert.equal(d.pages['/'].impressions, 50);
  assert.ok(seen.some((u) => u.includes(encodeURIComponent('sc-domain:thelenches.org.uk'))));
  // Cached for an hour: no more calls.
  const n = seen.length;
  await searchConsole(env, { now: new Date('2026-11-26T10:00:00Z') });
  assert.equal(seen.length, n);
});

test('searchConsole: not a user of the property yet, and an error', async () => {
  resetTokenCache(); resetConsoleCache();
  globalThis.fetch = async (input) => String(input).includes('oauth2') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
    : new Response(JSON.stringify({ siteEntry: [] }));
  assert.equal((await searchConsole(env)).off, true);
  resetConsoleCache();
  globalThis.fetch = async (input) => String(input).includes('oauth2') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
    : new Response('no', { status: 403 });
  assert.match((await searchConsole(env)).error, /HTTP 403/);
});
