// scripts/newsletter/select.js
// Chooses what goes into a weekly issue. Pure: no I/O and no clock. Everything is
// computed from the issue date and the inputs, so the same inputs give the same issue.
//
// Rules (plan: "Newsletter send", agreed 2 Oct 2026):
//   Events      every event dated issue date to +13 days (approved/auto Pending + whatson),
//               each at most 3 issues; a flyer image at most 2 issues, then text only.
//   News        Pending: new since the last issue, once. whatson news: once.
//   Notices     Pending: new since the last issue, once. whatson notices: up to 3 issues.
//   Roads       one.network Pending rows starting in the 14-day window (up to 3 issues),
//               or new since the last issue (once).
//   Bins        each area's next collection on or after the issue date, within 7 days.
//   Elsewhere   RSS signposts new since the last issue, links only, once.
//   Holiday     items flagged people_in_image or political_commercial are left out.
// "Shown" counts come from Issues rows with status sent or shadow dated before this
// issue, and for Pending rows also from newsletter_count / flyer_count (whichever is higher).
'use strict';

const crypto = require('crypto');

const WINDOW_DAYS = 14;
const MAX_APPEARANCES = 3;
const MAX_IMAGE = 2;
const BINS_DAYS = 7;
const COUNTED = new Set(['sent', 'shadow']);
const LIVE = new Set(['approved', 'auto']);
const WYCHAVON_LOOKUP = 'https://selfservice.wychavon.gov.uk/wdcroundlookup/';

const str = (v) => String(v ?? '').trim();
const truthy = (v) => /^(true|yes|y|1)$/i.test(str(v));
const num = (v) => Number(str(v)) || 0;
const normTitle = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const safeUrl = (u) => (/^(https?:\/\/|mailto:)/i.test(str(u)) ? str(u) : '');
// Code-point comparison: unlike localeCompare it can't vary between machines.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

// Accepts 2026-10-15, 2026-10-15 09:30 or 15/10/2026 (in case the Sheet reformats).
function ymd(value) {
  const v = str(value);
  let m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// whatson items have no ids: key on list + date + title (an edited title is a new item).
function whatsonKey(list, item) {
  return `w:${sha1(`${list}|${ymd(item.date)}|${str(item.title)}`).slice(0, 12)}`;
}

function linkOf(text, url) {
  const u = safeUrl(url);
  return u ? { text: str(text) || 'More details', url: u } : null;
}

function binsFor(bins, issueDate) {
  const lookup = WYCHAVON_LOOKUP;
  const collections = ((bins && bins.collections) || [])
    .map((c) => ({ date: ymd(c.date), bins: (c.bins || []).map(str).filter(Boolean), note: str(c.note) }))
    .filter((c) => c.date && c.bins.length)
    .sort((a, b) => cmp(a.date, b.date));
  const groups = [];
  for (const area of (bins && bins.areas) || []) {
    const offset = num(area.offset);
    const c = collections.find((x) => addDays(x.date, offset) >= issueDate);
    // Calendar run out (validTo passed): point to Wychavon instead of guessing.
    if (!c) return { groups: [], lookup, expired: true };
    const date = addDays(c.date, offset);
    const id = `${date}|${c.bins.join(',')}`;
    let grp = groups.find((x) => x.id === id);
    if (!grp) {
      grp = { id, date, bins: c.bins, names: [], note: c.note };
      groups.push(grp);
    }
    grp.names.push(str(area.name));
  }
  const limit = addDays(issueDate, BINS_DAYS - 1);
  return {
    groups: groups.filter((x) => x.date <= limit).map(({ id, ...rest }) => rest),
    lookup,
    expired: false,
  };
}

function select({ issueDate, pending, whatson, bins, issues, settings, sources, jpegFor }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate || '')) throw new Error(`Bad issue date "${issueDate}"`);
  const holiday = truthy(settings && settings.holiday_mode);
  const windowEnd = addDays(issueDate, WINDOW_DAYS - 1);
  const inWindow = (d) => d && d >= issueDate && d <= windowEnd;

  // Earlier published issues only, so rebuilding this issue never counts itself.
  const past = (issues || []).filter((r) => COUNTED.has(str(r.status).toLowerCase())
    && ymd(r.issue_date) && ymd(r.issue_date) < issueDate);
  const shown = new Map();
  const imaged = new Map();
  const tally = (map, cell) => {
    for (const k of new Set(str(cell).split(/\s+/).filter(Boolean))) map.set(k, (map.get(k) || 0) + 1);
  };
  for (const r of past) {
    tally(shown, r.item_keys);
    tally(imaged, r.image_keys);
  }
  const lastIssue = past.map((r) => ymd(r.issue_date)).sort(cmp).pop() || addDays(issueDate, -7);

  const roadSources = new Set((sources || [])
    .filter((s) => /one\.network/i.test(s.match))
    .map((s) => str(s.source).toLowerCase()));
  const isRoad = (row) => roadSources.has(str(row.source).toLowerCase()) || /one\.network/i.test(str(row.from));
  const isRss = (row) => /^rss-/i.test(str(row.id)) || /^rss:/i.test(str(row.message_id));

  const events = [];
  const news = [];
  const notices = [];
  const roads = [];
  const elsewhere = [];

  function imageFor(row, key) {
    const url = str(row.image_url);
    if (!/^\/images\/items\/[A-Za-z0-9_-]{1,100}\.webp$/.test(url)) return null;
    if (Math.max(num(row.flyer_count), imaged.get(key) || 0) >= MAX_IMAGE) return null;
    const src = jpegFor ? jpegFor(url) : '';
    return src ? { src, alt: str(row.alt_text) } : null;
  }

  // ---- Pending: approved/auto rows; later rows win, as on the site.
  const byKey = new Map();
  for (const r of pending || []) {
    if (!LIVE.has(str(r.status).toLowerCase()) || !str(r.title)) continue;
    if (holiday && (truthy(r.people_in_image) || truthy(r.political_commercial))) continue;
    byKey.set(`${normTitle(r.title)}|${ymd(r.event_date)}`, r);
  }
  const pendingEvents = new Set();

  for (const row of byKey.values()) {
    const key = `p:${str(row.id)}`;
    const date = ymd(row.event_date);
    const start = ymd(row.decided_at) || ymd(row.received) || issueDate;
    const cat = str(row.category).toLowerCase();
    const count = Math.max(num(row.newsletter_count), shown.get(key) || 0);
    const isNew = count === 0 && start >= lastIssue && start <= issueDate;
    const meta = [str(row.village), str(row.event_time), str(row.cost)].filter(Boolean).join(' · ');
    const base = {
      key, title: str(row.title), body: str(row.summary), meta,
      link: linkOf(row.link_text, row.link_url), date, sortStart: start,
    };

    if (isRss(row)) {
      if (isNew && base.link) elsewhere.push({ key, title: base.title, link: base.link, source: str(row.from) });
      continue;
    }
    if (isRoad(row)) {
      if ((inWindow(date) && count < MAX_APPEARANCES) || isNew) roads.push(base);
      continue;
    }
    if (cat === 'event' && date) {
      if (inWindow(date) && count < MAX_APPEARANCES) {
        events.push({ ...base, image: imageFor(row, key) });
        pendingEvents.add(`${normTitle(row.title)}|${date}`);
      }
      continue;
    }
    if (isNew) (cat === 'notice' ? notices : news).push({ ...base, image: imageFor(row, key) });
  }

  // ---- whatson.json (hand-edited, no images).
  const w = whatson || {};
  for (const ev of w.events || []) {
    const date = ymd(ev.date);
    if (!inWindow(date) || !str(ev.title)) continue;
    if (pendingEvents.has(`${normTitle(ev.title)}|${date}`)) continue;
    const key = whatsonKey('events', ev);
    if ((shown.get(key) || 0) >= MAX_APPEARANCES) continue;
    events.push({ key, title: str(ev.title), body: str(ev.body), meta: '', link: linkOf(ev.link && ev.link.text, ev.link && ev.link.url), date, sortStart: '', image: null });
  }
  for (const it of w.news || []) {
    if (!str(it.title)) continue;
    const key = whatsonKey('news', it);
    if (shown.get(key)) continue;
    news.push({ key, title: str(it.title), body: str(it.body), meta: '', link: linkOf(it.link && it.link.text, it.link && it.link.url), date: '', sortStart: '', image: null });
  }
  for (const it of w.notices || []) {
    if (!str(it.title)) continue;
    const key = whatsonKey('notices', it);
    if ((shown.get(key) || 0) >= MAX_APPEARANCES) continue;
    notices.push({ key, title: str(it.title), body: str(it.body), meta: '', link: linkOf(it.link && it.link.text, it.link && it.link.url), date: '', sortStart: '', image: null });
  }

  // ---- Deterministic order.
  events.sort((a, b) => cmp(a.date, b.date) || cmp(a.title, b.title) || cmp(a.key, b.key));
  // Newest Pending items first, then whatson items in title order.
  const newestFirst = (a, b) => cmp(b.sortStart, a.sortStart) || cmp(a.title, b.title) || cmp(a.key, b.key);
  news.sort(newestFirst);
  notices.sort(newestFirst);
  roads.sort((a, b) => cmp(a.date || '9999', b.date || '9999') || cmp(a.title, b.title) || cmp(a.key, b.key));
  elsewhere.sort((a, b) => cmp(a.source, b.source) || cmp(a.title, b.title) || cmp(a.key, b.key));

  const all = [...events, ...news, ...notices, ...roads, ...elsewhere];
  const keys = all.map((x) => x.key);
  const imageKeys = all.filter((x) => x.image).map((x) => x.key);
  const strip = (x) => {
    const { sortStart, ...rest } = x;
    return rest;
  };

  return {
    issueDate,
    holiday,
    lastIssue,
    events: events.map(strip),
    regulars: str(w.eventsFootnote),
    news: news.map(strip),
    notices: notices.map(strip),
    roads: roads.map(strip),
    bins: binsFor(bins, issueDate),
    elsewhere,
    keys,
    imageKeys,
    empty: keys.length === 0,
  };
}

module.exports = { select, whatsonKey, ymd, addDays };
