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
// Organisations that emailed us in the last 3 months are "in regular contact" and get no check.
// Logs print the slug only, never an address.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const g = require('../ingest/google');
const replies = require('../ingest/replies');
const feedback = require('../ingest/feedback');

const TZ = 'Europe/London';
const DATA = path.join(__dirname, '..', '..', 'src', '_data');
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

const readData = (name) => JSON.parse(fs.readFileSync(path.join(DATA, `${name}.json`), 'utf8'));
function siteData() {
  return Object.fromEntries(['contacts', 'council', 'schools', 'health', 'transport'].map((n) => [n, readData(n)]));
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
function orgEmail(org, kind, R) {
  const vars = { organisation: org.name, page: org.pageName, page_url: org.pageUrl, entry: [org.name, ...org.shown].join('\n') };
  const parts = [replies.greeting(org.greet), replies.fill(kind === 'chase' ? 'org_chase' : 'org_check', vars)];
  if (kind !== 'chase') parts.push(replies.fill('outreach_optout'));
  parts.push(replies.fill('signature'));
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
  const org = R.orgEntries(siteData()).find((o) => o.id === id) || null;
  const [rows, contacts, orgTab] = await Promise.all([g.readTable('Replies'), g.readTable('Contacts'), orgRows(R)]);
  const today = londonDate(Date.now());
  const ctx = { replies: rows, contacts, orgRow: orgTab.find((r) => String(r.id || '').trim() === id) || null, today };
  // In regular contact (emailed us in the last 3 months): no check, as on the panel.
  if (org && R.orgState(org, ctx).state === 'due' && (await g.searchMessageIds(R.recentQuery(org.email), 1)).length) {
    ctx.recent = new Set([org.email]);
  }
  const plan = R.planOrgCheck(org, ctx);
  if (plan.error) {
    console.log(`Organisation ${id}: ${plan.error.replace(/^Not drafted: /, '')}; nothing drafted.`);
    return null;
  }
  const { subject, body } = orgEmail(org, plan.kind, R);
  const now = Date.now();
  const fresh = {
    reply_id: `org-${id}-${plan.kind}-${londonDateTime(now).replace(/\D/g, '')}`,
    message_id: '',
    thread_id: '',
    to: org.email,
    type: R.ORG_TYPE,
    class: 'outreach',
    class_confidence: '',
    hold_reason: '',
    policy_codes: `org_${plan.kind}_${id}`,
    subject,
    body,
    status: mode === 'shadow' ? 'shadow' : 'awaiting',
    created_at: londonDateTime(now),
    notes: plan.kind === 'chase'
      ? `Organisation check chaser for ${org.name} (${org.pageName} page), as you asked in the panel; it goes on the same thread as the check`
      : `Organisation check for ${org.name} (${org.pageName} page), as you asked in the panel`,
  };
  await g.appendRows('Replies', [fresh]);
  await feedback.record(fresh, { mode });
  console.log(`Organisation ${id}: drafted ${fresh.reply_id} (${plan.kind}, ${fresh.status}).`);
  return fresh;
}

module.exports = { draftOrgCheck, orgEmail, siteData };
