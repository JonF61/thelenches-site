// scripts/outreach/linkask.js
// Inbound links, Draft request (26 Nov 2026, Jon; wording approved 26 Nov): Holly's fixed-wording
// email asking a Link partners row's website to link to us (templates.md link_request, with
// link_request_listed when we list them), or one chaser (link_chase) on the same thread 21 days
// after it was sent. No Claude. The draft is a Replies row of type "outreach", policy code
// link_request_<id> / link_chase_<id>, awaiting Jon's Approve; it never sends itself, even in
// holiday mode (outreach is never automatic). The rules are worker/src/admin/links.mjs
// planLinkAsk, shared with the panel. Logs print the partner id and kind only.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const g = require('../ingest/google');
const replies = require('../ingest/replies');
const feedback = require('../ingest/feedback');
const { siteConfig } = require('../../lib/site.js');

const TZ = 'Europe/London';
const londonDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
function londonDateTime(ms) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return `${londonDate(ms)} ${time}`;
}
const str = (v) => String(v ?? '').trim();

let rulesCache = null;
async function rules() {
  if (!rulesCache) rulesCache = await import(pathToFileURL(path.join(__dirname, '..', '..', 'worker', 'src', 'admin', 'links.mjs')).href);
  return rulesCache;
}

function subjectFor(cfg = siteConfig()) {
  return `A link to ${cfg.domain || 'thelenches.org.uk'}?`;
}

// A site's own version of a template (<key>_<site>, e.g. link_request_harvington; 26 Nov), chosen
// from cfg so the draft always matches the site it is for, else the shared (Lenches) one.
function siteFill(key, cfg, vars) {
  const own = cfg && cfg.site ? `${key}_${cfg.site}` : '';
  try { if (own) return replies.fill(own, vars); } catch { /* no site version: the shared one */ }
  return replies.fill(key, vars);
}

// { subject, body } for one partner (kind: request | chase). optout: a first email to them.
function linkEmail(row, kind, { optout = true, cfg = siteConfig() } = {}) {
  const subject = subjectFor(cfg);
  if (kind === 'chase') {
    return { subject: `Re: ${subject}`, body: [replies.greeting(''), siteFill('link_chase', cfg), replies.fill('signature')].join('\n\n') };
  }
  const listed = str(row.listed_page) && str(row.listed_url)
    ? replies.fill('link_request_listed', { organisation: str(row.name), page: str(row.listed_page), page_url: str(row.listed_url) })
    : '';
  const text = siteFill('link_request', cfg, { listed_line: listed }).replace(/\n{3,}/g, '\n\n');
  const parts = [replies.greeting(''), text, replies.fill('signature')];
  if (optout) parts.push(replies.fill('outreach_optout'));
  return { subject, body: parts.join('\n\n') };
}

// Draft request / Draft chaser (scripts/approve, action "linkask"). Returns the new Replies row,
// or null if nothing was drafted (logged).
async function draftLinkAsk(id) {
  const R = await rules();
  const { settings } = await g.readSettings();
  const mode = replies.repliesMode(settings);
  if (mode === 'off') {
    console.log('Link request: replies_mode is off; nothing drafted.');
    return null;
  }
  const [partners, rows] = await Promise.all([g.readTable(R.LINK_TAB), g.readTable('Replies')]);
  const matches = partners.filter((r) => str(r.id) === id);
  const now = Date.now();
  const plan = R.planLinkAsk(matches.length === 1 ? matches[0] : null, rows, londonDate(now));
  if (plan.error) {
    console.log(`Link partner ${id}: ${plan.error.replace(/^Not drafted: /, '')}; nothing drafted.`);
    return null;
  }
  const row = matches[0];
  const to = str(row.email);
  const { subject, body } = linkEmail(row, plan.kind, { optout: !replies.emailedBefore(rows, to) });
  const fresh = {
    reply_id: `link-${id}-${plan.kind}-${londonDateTime(now).replace(/\D/g, '')}`,
    message_id: '',
    thread_id: '',
    to,
    type: 'outreach',
    class: 'outreach',
    class_confidence: '',
    hold_reason: '',
    policy_codes: `link_${plan.kind}_${id}`,
    subject,
    body,
    status: mode === 'shadow' ? 'shadow' : 'awaiting',
    created_at: londonDateTime(now),
    notes: plan.kind === 'chase'
      ? `Link request chaser for ${str(row.name)}, as you asked in the panel; it goes on the same thread as the request`
      : `Link request to ${str(row.name)}, as you asked in the panel (SEO, Inbound links)`,
  };
  await g.appendRows('Replies', [fresh]);
  await feedback.record(fresh, { mode });
  console.log(`Link partner ${id}: drafted ${fresh.reply_id} (${plan.kind}, ${fresh.status}).`);
  return fresh;
}

module.exports = { draftLinkAsk, linkEmail, subjectFor };
