// worker/src/admin/nlstats.js
// The panel's Newsletter stats (28 Oct 2026): for each issue sent live, how many it went to
// (Sends rows status sent, else the Issues row's recipients), hard bounces found in the week
// after (Do Not Send rows the daily diagnostic adds), and the anonymous opens and clicks the
// Worker counted (track.js; Workers Analytics Engine, read with the SQL API using the
// CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID secrets). Totals only: nothing here is per person.
// The counts keep about 3 months (Analytics Engine's limit).

import { DATASET } from '../track.js';

const ISSUE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Europe/London';
const MAX_ISSUES = 12;
const TOP_LINKS = 15;
const str = (v) => String(v ?? '').trim();
const ymd = (v) => (str(v).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Issues sent live, newest first: [{ date, sent, bounced }].
export function sentIssues(issues, sends, dns) {
  const sentBy = new Map();
  for (const r of sends || []) {
    if (str(r.status).toLowerCase() !== 'sent') continue;
    const k = str(r.issue_id);
    if (ISSUE.test(k)) sentBy.set(k, (sentBy.get(k) || 0) + 1);
  }
  const bounceDates = (dns || []).filter((r) => /bounce/i.test(`${str(r.reason)} ${str(r.notes)}`))
    .map((r) => ymd(r.added_at) || ymd(r.date)).filter(Boolean);
  const out = [];
  for (const r of issues || []) {
    const date = ymd(r.issue_date) || ymd(r.issue_id);
    if (str(r.status).toLowerCase() !== 'sent' || !ISSUE.test(date) || out.some((x) => x.date === date)) continue;
    const end = addDays(date, 7);
    out.push({
      date,
      sent: sentBy.get(date) || Number(r.recipients) || 0,
      bounced: bounceDates.filter((d) => d >= date && d < end).length,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ISSUES);
}

async function sql(env, query) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: query,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Analytics Engine: HTTP ${r.status} ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  return (j && j.data) || [];
}

const ukParts = (ms) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

// Hourly open rows ({ h: "YYYY-MM-DD HH:MM:SS" UTC, n }) -> { days: [{ day, n }], hours: [{ hour, n }] }
// in UK time: opens per day, and the busiest hours of the day (top 3).
export function openTimes(rows) {
  const days = new Map();
  const hours = new Map();
  for (const r of rows || []) {
    const ms = Date.parse(`${str(r.h).replace(' ', 'T')}Z`);
    const n = Number(r.n) || 0;
    if (Number.isNaN(ms) || !n) continue;
    const { day, hour } = ukParts(ms);
    days.set(day, (days.get(day) || 0) + n);
    hours.set(hour, (hours.get(hour) || 0) + n);
  }
  return {
    days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, n })),
    hours: [...hours].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([hour, n]) => ({ hour, n })),
  };
}

// { on, error?, issues: [{ date, sent, bounced, opens, clicks }], detail: { date, days, hours, links } | null }
export async function nlStats(env, { issues, sends, dns }, pick = '', withDetail = true) {
  const list = sentIssues(issues, sends, dns).map((x) => ({ ...x, opens: null, clicks: null }));
  const on = Boolean(env.CF_ANALYTICS_TOKEN && /^[0-9a-f]{32}$/i.test(str(env.CF_ACCOUNT_ID)));
  const out = { on, issues: list, detail: null };
  if (!on) return out;
  try {
    const totals = await sql(env, `SELECT blob1 AS kind, blob2 AS issue, SUM(_sample_interval) AS n FROM ${DATASET} `
      + "WHERE timestamp > NOW() - INTERVAL '92' DAY GROUP BY kind, issue");
    for (const x of list) {
      const n = (kind) => totals.filter((t) => t.kind === kind && t.issue === x.date).reduce((s, t) => s + (Number(t.n) || 0), 0);
      x.opens = n('open');
      x.clicks = n('click');
    }
    const date = ISSUE.test(pick) && list.some((x) => x.date === pick) ? pick : (list[0] && list[0].date);
    if (withDetail && date) {
      const [hourly, links] = await Promise.all([
        sql(env, `SELECT toStartOfHour(timestamp) AS h, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob1 = 'open' AND blob2 = '${date}' GROUP BY h ORDER BY h`),
        sql(env, `SELECT blob3 AS url, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob1 = 'click' AND blob2 = '${date}' GROUP BY url ORDER BY n DESC LIMIT ${TOP_LINKS}`),
      ]);
      out.detail = { date, ...openTimes(hourly), links: links.map((l) => ({ url: str(l.url), n: Number(l.n) || 0 })) };
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
