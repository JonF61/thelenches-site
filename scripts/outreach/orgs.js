// scripts/outreach/orgs.js
// Organisation outreach (27 Oct 2026): Holly's yearly "please check your entry" email to an
// organisation the site lists, and the chaser 21 days later if they haven't replied. Jon taps
// Draft check or Draft chaser in the admin panel (Contacts > Organisations) -> decide() action
// "orgcheck", id = the organisation's slug in contacts.json `outreach` -> approval.yml ->
// scripts/approve -> draftOrgCheck. The rules (worker/src/admin/orgoutreach.mjs planOrgCheck)
// are checked again here, so a replayed or late tap does nothing.
// The email is a fixed template (templates.md org_check / org_chase, approved by Jon 27 Oct),
// not Claude: it quotes their entry exactly as the site shows it. The draft is a Replies row
// of type "outreach", status "awaiting" ("shadow" in shadow mode), policy_codes
// org_check_<id> or org_chase_<id>: it only goes on Jon's Approve or Edit, never by itself or
// in holiday mode, and the chaser goes on the check's thread (replies.js chaseThread).
// Organisations that emailed us in the last 3 months (from any of their addresses: addressesFor) are "in regular contact" and get no check.
// Logs print the slug only, never an address.
'use strict';

const { SITE_REL, SITE, ROOT, siteConfig } = require('../../lib/site.js');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const g = require('../ingest/google');
const replies = require('../ingest/replies');
const feedback = require('../ingest/feedback');

const TZ = 'Europe/London';
const DATA = path.join(__dirname, '..', '..', SITE_REL, '_data');
const londonDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
function londonDateTime(ms) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return `${londonDate(ms)} ${time}`;
}

let rulesCache;
async function rules() {
  if (!rulesCache) {
    rulesCache = await import(pathToFileURL(path.join(__dirname, '..', '..', 'worker', 'src', 'admin', 'orgoutreach.mjs')).href);
  }
  return rulesCache;
}

// A data file a site doesn't have (Harvington has no health.json or transport.json) reads as {}.
const readData = (name, dir = DATA) => {
  const file = path.join(dir, `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};
function siteData() {
  return Object.fromEntries(['contacts', 'council', 'schools', 'health', 'transport', 'trades', 'eat'].map((n) => [n, readData(n)]));
}

// Every organisation and listing (Local trades, Where to eat) the yearly check covers. Another
// site's listings (18 Nov) link to its own pages and name its domain, leaving out any the Lenches
// already checks (the same place on both sites keeps one id; worker admin/index.js orgsFor too).
async function allEntries(data = siteData(), { site = SITE, cfg = siteConfig() } = {}) {
  const R = await rules();
  if (site === 'lenches') return [...R.orgEntries(data), ...R.listingEntries(data, { retired: R.RETIRED_LISTINGS })];
  const lenchesDir = path.join(ROOT, 'sites', 'lenches', '_data');
  const skip = new Set(R.listingEntries({ trades: readData('trades', lenchesDir), eat: readData('eat', lenchesDir) }).map((e) => e.id));
  return [...R.orgEntries(data), ...R.listingEntries(data, { url: cfg.url, domain: cfg.domain, skip, retired: R.RETIRED_LISTINGS })];
}

// A missing Org outreach tab is the same as an empty one.
async function orgRows(R) {
  try {
    return await g.readTable(R.ORG_TAB);
  } catch (err) {
    if (/Unable to parse range/i.test(String((err && err.message) || err))) return [];
    throw err;
  }
}

// { subject, body } for one organisation (kind: check | chase).
function orgEmail(org, kind, R, optout = true) {
  if (org.listing) {
    // Listings (5 Nov, wording approved by Jon): no opt-out line; the check says how to come off.
    const vars = { name: org.name, page: org.pageName, page_url: org.pageUrl, entry: [org.name, ...org.shown].join('\n') };
    // A site's own wording where templates.md has one (listing_check_harvington, 18 Nov).
    const parts = [replies.greeting(org.greet), replies.fillSite(kind === 'chase' ? 'listing_chase' : org.listing === 'eat' ? 'listing_check_eat' : 'listing_check', vars), replies.fill('signature')];
    const subject = org.subject || R.LISTING_SUBJECT;
    return { subject: kind === 'chase' ? `Re: ${subject}` : subject, body: parts.join('\n\n') };
  }
  const vars = { organisation: org.name, page: org.pageName, page_url: org.pageUrl, entry: [org.name, ...org.shown].join('\n') };
  const parts = [replies.greeting(org.greet), replies.fill(kind === 'chase' ? 'org_chase' : 'org_check', vars)];
  parts.push(replies.fill('signature'));
  // After the signature, in italics, and only on a first email to them (Jon, 24 Nov).
  if (kind !== 'chase' && optout) parts.push(replies.fill('outreach_optout'));
  return { subject: kind === 'chase' ? `Re: ${R.SUBJECT}` : R.SUBJECT, body: parts.join('\n\n') };
}

// Draft check / Draft chaser (scripts/approve, action "orgcheck"). Returns the new Replies row,
// or null if nothing was drafted (logged).
async function draftOrgCheck(id) {
  const R = await rules();
  const { settings } = await g.readSettings();
  const mode = replies.repliesMode(settings);
  if (mode === 'off') {
    console.log('Organisation outreach: replies_mode is off; nothing drafted.');
    return null;
  }
  const entries = await allEntries();
  const org = entries.find((o) => o.id === id) || null;
  const [rows, contacts, orgTab] = await Promise.all([g.readTable('Replies'), g.readTable('Contacts'), orgRows(R)]);
  const today = londonDate(Date.now());
  const ctx = { replies: rows, contacts, orgRow: orgTab.find((r) => String(r.id || '').trim() === id) || null, today,
    domains: R.domainCounts(entries, orgTab) };
  // In regular contact (emailed us in the last 3 months): no check, as on the panel.
  if (org && !org.listing && R.orgState(org, ctx).state === 'due'
    && (await g.searchMessageIds(R.recentQuery(R.addressesFor(org, ctx.orgRow, contacts, ctx.domains)), 1)).length) {
    ctx.recent = new Set([org.id]);
  }
  const plan = R.planOrgCheck(org, ctx);
  if (plan.error) {
    console.log(`Organisation ${id}: ${plan.error.replace(/^Not drafted: /, '')}; nothing drafted.`);
    return null;
  }
  const { subject, body } = orgEmail(org, plan.kind, R, !replies.emailedBefore(rows, R.emailOf(org, ctx.orgRow)));
  const now = Date.now();
  const fresh = {
    reply_id: `org-${id}-${plan.kind}-${londonDateTime(now).replace(/\D/g, '')}`,
    message_id: '',
    thread_id: '',
    to: R.emailOf(org, ctx.orgRow),
    type: R.ORG_TYPE,
    class: 'outreach',
    class_confidence: '',
    hold_reason: '',
    policy_codes: `org_${plan.kind}_${id}`,
    subject,
    body,
    status: mode === 'shadow' ? 'shadow' : 'awaiting',
    created_at: londonDateTime(now),
    notes: org.listing
      ? `Listing ${plan.kind === 'chase' ? 'check chaser' : 'check'} for ${org.name} (${org.pageName} page), as you asked in the panel${plan.kind === 'chase' ? '; it goes on the same thread as the check' : ''}`
      : plan.kind === 'chase'
      ? `Organisation check chaser for ${org.name} (${org.pageName} page), as you asked in the panel; it goes on the same thread as the check`
      : `Organisation check for ${org.name} (${org.pageName} page), as you asked in the panel`,
  };
  await g.appendRows('Replies', [fresh]);
  await feedback.record(fresh, { mode });
  console.log(`Organisation ${id}: drafted ${fresh.reply_id} (${plan.kind}, ${fresh.status}).`);
  return fresh;
}

module.exports = { draftOrgCheck, orgEmail, siteData, allEntries, orgRows, rules };
