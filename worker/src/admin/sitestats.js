// worker/src/admin/sitestats.js
// Site visitors by day and month (the panel's Site visitors screen). Cloudflare keeps Web
// Analytics detail for a limited time, so every night (00:10 UK, NIGHTLY_CRON in index.js)
// logVisitors() saves each finished UK day's page views, visits and top pages to the
// Visitors tab (date, views, visits, pages, saved_at; made here). Missing days since START
// are filled oldest first, at most MAX_FILL a night, so a missed night catches up.
// pages = "path count | path count …" (top PAGES of that day). Counts only: no addresses or IPs.
// visitorHistory() reads the tab and adds today so far, live from Cloudflare.

import { API, HOST } from './visitors.js';
import { readTable } from './sheet.js';
import { addTab, appendValues } from './google.js';

export const VISITORS_TAB = 'Visitors';
export const HEADERS = ['date', 'views', 'visits', 'pages', 'saved_at'];
export const START = '2026-10-28'; // the first day of counts (site.json cfAnalyticsToken)
const PAGES = 20;
const MAX_FILL = 10;

const pad = (n) => String(n).padStart(2, '0');

// YYYY-MM-DD in UK time.
export function ukDate(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// UTC instant of UK midnight at the start of iso (GMT or BST).
export function ukMidnight(iso) {
  const guess = Date.parse(`${iso}T00:00:00Z`);
  for (const off of [0, -3600000]) if (ukDate(guess + off) === iso && ukDate(guess + off - 1) !== iso) return guess + off;
  return guess;
}

// One UK day's (or part day's) totals and top pages.
export function dayQuery(account, from, to) {
  const f = `{ datetime_geq: "${from}", datetime_lt: "${to}", requestHost: "${HOST}" }`;
  return `{
  viewer {
    accounts(filter: { accountTag: "${account}" }) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${f}) { count sum { visits } }
      pages: rumPageloadEventsAdaptiveGroups(limit: ${PAGES}, filter: ${f}, orderBy: [count_DESC]) { count dimensions { requestPath } }
    }
  }
}`;
}

export function parseDay(j) {
  if (j && Array.isArray(j.errors) && j.errors.length) throw new Error(String(j.errors[0].message || 'GraphQL error'));
  const acc = j && j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  if (!acc) throw new Error('no data for this account (check CF_ACCOUNT_ID)');
  const t = (acc.total || [])[0] || {};
  return {
    views: Number(t.count) || 0,
    visits: Number(t.sum && t.sum.visits) || 0,
    pages: (acc.pages || []).map((p) => ({ path: String((p.dimensions && p.dimensions.requestPath) || '/'), views: Number(p.count) || 0 })),
  };
}

function secrets(env) {
  const token = String(env.CF_ANALYTICS_TOKEN || '').trim();
  const account = String(env.CF_ACCOUNT_ID || '').trim();
  if (!token || !account) return null;
  if (!/^[0-9a-f]{32}$/i.test(account)) throw new Error('CF_ACCOUNT_ID is not a 32-character account ID');
  return { token, account };
}

// Totals for UK day iso, up to `untilMs` (default: the whole day).
export async function fetchDay(env, iso, untilMs) {
  const s = secrets(env);
  if (!s) return null;
  const from = new Date(ukMidnight(iso)).toISOString();
  const to = new Date(untilMs || ukMidnight(addDays(iso, 1))).toISOString();
  const r = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: dayQuery(s.account, from, to) }),
  });
  if (!r.ok) throw new Error(`Cloudflare analytics: HTTP ${r.status}`);
  return parseDay(await r.json());
}

export const pagesCell = (pages) => pages.map((p) => `${p.path} ${p.views}`).join(' | ');
export function parsePages(cell) {
  return String(cell || '').split(' | ').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.lastIndexOf(' ');
    return { path: x.slice(0, i), views: Number(x.slice(i + 1)) || 0 };
  }).filter((p) => p.path);
}

async function readVisitors(env) {
  try {
    return await readTable(env, VISITORS_TAB);
  } catch (e) {
    if (e.status === 400 && /Unable to parse range/i.test(e.message)) return { headers: [], rows: [], missing: true };
    throw e;
  }
}

// Days from START to yesterday (UK) with no row yet, oldest first, at most MAX_FILL.
export function missingDays(rows, today) {
  const have = new Set(rows.map((r) => String(r.date || '').trim()));
  const out = [];
  for (let d = START; d < today && out.length < MAX_FILL; d = addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

// Nightly: saves each missing finished day. Returns { saved, failed } (counts and dates only).
export async function logVisitors(env, ms = Date.now()) {
  if (!secrets(env)) return { off: true };
  const tab = await readVisitors(env);
  if (tab.missing) await addTab(env, VISITORS_TAB);
  if (tab.missing || !tab.headers.includes('date')) await appendValues(env, VISITORS_TAB, [HEADERS]);
  const rows = [];
  const failed = [];
  for (const d of missingDays(tab.rows, ukDate(ms))) {
    try {
      const v = await fetchDay(env, d);
      rows.push([d, v.views, v.visits, pagesCell(v.pages), new Date(ms).toISOString()]);
    } catch (e) {
      failed.push(`${d}: ${e.message}`);
    }
  }
  if (rows.length) await appendValues(env, VISITORS_TAB, rows);
  return { saved: rows.map((r) => r[0]), failed };
}

// Merges page lists, adding views per path; top n.
function topPages(lists, n) {
  const m = new Map();
  for (const l of lists) for (const p of l) m.set(p.path, (m.get(p.path) || 0) + p.views);
  return [...m].map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views || a.path.localeCompare(b.path)).slice(0, n);
}

// Saved rows (+ today so far) -> { days: newest first, months: newest first }.
export function history(rows, today = null) {
  const byDate = new Map();
  for (const r of rows) {
    const date = String(r.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDate.set(date, { date, views: Number(r.views) || 0, visits: Number(r.visits) || 0, pages: parsePages(r.pages) });
  }
  if (today) byDate.set(today.date, { ...today, today: true });
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const months = new Map();
  for (const d of days) {
    const k = d.date.slice(0, 7);
    if (!months.has(k)) months.set(k, { month: k, views: 0, visits: 0, days: 0, busiest: null, lists: [] });
    const m = months.get(k);
    m.views += d.views;
    m.visits += d.visits;
    m.days += 1;
    if (!m.busiest || d.views > m.busiest.views) m.busiest = { date: d.date, views: d.views };
    m.lists.push(d.pages);
  }
  return {
    days,
    months: [...months.values()].map(({ lists, ...m }) => ({ ...m, pages: topPages(lists, 10) })),
  };
}

// The screen's data: { off } | { days, months, todayError? }.
export async function visitorHistory(env, ms = Date.now()) {
  if (!secrets(env)) return { off: true };
  const tab = await readVisitors(env);
  const date = ukDate(ms);
  let today = null;
  let todayError = '';
  try {
    today = { date, ...(await fetchDay(env, date, ms)) };
  } catch (e) {
    todayError = e.message;
  }
  return { ...history(tab.rows, today), todayError };
}
