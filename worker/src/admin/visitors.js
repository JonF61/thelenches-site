// worker/src/admin/visitors.js
// Visitors on the panel's Summary page: Cloudflare Web Analytics (no cookies; the beacon is in
// base.njk while site.json has cfAnalyticsToken) read through Cloudflare's GraphQL API.
// Worker secrets, added by hand in the dashboard: CF_ANALYTICS_TOKEN (a custom API token,
// Account Analytics: Read only) and CF_ACCOUNT_ID. Without both, the section says so.
// Read-only: page views and visits over the last 7 days, and the most viewed pages.

const API = 'https://api.cloudflare.com/client/v4/graphql';
const DAYS = 7;
const TOP = 8;
export const HOST = 'thelenches.org.uk';

// Values go straight into the query (no typed variables to get wrong): the account ID is
// checked as 32 hex characters, the dates are ISO stamps made here and the host is fixed.
export function queryFor(account, filter) {
  const f = `{ datetime_geq: "${filter.datetime_geq}", datetime_leq: "${filter.datetime_leq}", requestHost: "${filter.requestHost}" }`;
  return `{
  viewer {
    accounts(filter: { accountTag: "${account}" }) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${f}) { count sum { visits } }
      pages: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: ${f}, orderBy: [count_DESC]) { count dimensions { requestPath } }
      days: rumPageloadEventsAdaptiveGroups(limit: ${DAYS + 1}, filter: ${f}, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
    }
  }
}`;
}

// The GraphQL answer -> { since, views, visits, pages: [{ path, views }], days: [{ date, views, visits }] }.
export function parseVisitors(j, since) {
  if (j && Array.isArray(j.errors) && j.errors.length) throw new Error(String(j.errors[0].message || 'GraphQL error'));
  const acc = j && j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  if (!acc) throw new Error('no data for this account (check CF_ACCOUNT_ID)');
  const t = (acc.total || [])[0] || {};
  return {
    since,
    views: Number(t.count) || 0,
    visits: Number(t.sum && t.sum.visits) || 0,
    pages: (acc.pages || []).map((p) => ({ path: String((p.dimensions && p.dimensions.requestPath) || '/'), views: Number(p.count) || 0 })),
    days: (acc.days || []).map((d) => ({ date: String((d.dimensions && d.dimensions.date) || ''), views: Number(d.count) || 0, visits: Number(d.sum && d.sum.visits) || 0 })),
  };
}

// { off: true } until both secrets are set; { error } if Cloudflare refuses.
export async function visitors(env, now = Date.now()) {
  const token = String(env.CF_ANALYTICS_TOKEN || '').trim();
  const account = String(env.CF_ACCOUNT_ID || '').trim();
  if (!token || !account) return { off: true };
  if (!/^[0-9a-f]{32}$/i.test(account)) return { error: 'CF_ACCOUNT_ID is not a 32-character account ID' };
  const since = new Date(now - DAYS * 86400000).toISOString();
  const filter = { datetime_geq: since, datetime_leq: new Date(now).toISOString(), requestHost: HOST };
  const r = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: queryFor(account, filter) }),
  });
  if (!r.ok) throw new Error(`Cloudflare analytics: HTTP ${r.status}`);
  return parseVisitors(await r.json(), since);
}
