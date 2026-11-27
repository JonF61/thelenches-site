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
const { siteConfig, siteConfigFor, otherSites, SITE } = require('../../lib/site.js');

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

function subjectFor(cfg = siteConfig(), twin = null) {
  if (twin) return `Links to ${both(cfg, twin).map((c) => c.domain).join(' and ')}?`;
  return `A link to ${cfg.domain || 'thelenches.org.uk'}?`;
}

// The two sites in a fixed order (the Lenches first, as templates.md link_request_both names them).
function both(cfg, twin) {
  const pair = [cfg, twin.cfg];
  return cfg.site === 'harvington' ? pair.reverse() : pair;
}

// A site's own version of a template (<key>_<site>, e.g. link_request_harvington; 26 Nov), chosen
// from cfg so the draft always matches the site it is for, else the shared (Lenches) one.
function siteFill(key, cfg, vars) {
  const own = cfg && cfg.site ? `${key}_${cfg.site}` : '';
  try { if (own) return replies.fill(own, vars); } catch { /* no site version: the shared one */ }
  return replies.fill(key, vars);
}

const listedLine = (r) => (str(r.listed_page) && str(r.listed_url)
  ? replies.fill('link_request_listed', { organisation: str(r.name), page: str(r.listed_page), page_url: str(r.listed_url) })
  : '');

// { subject, body } for one partner (kind: request | chase). optout: a first email to them.
// known (27 Nov, Jon): we have written to them before, so no "I help look after…" introduction
// and no "send us your news" line (link_request_known). twin: { row, cfg } of the same address
// on another site's Link partners, still to ask: one email asks for links to both sites.
function linkEmail(row, kind, { optout = true, cfg = siteConfig(), known = false, twin = null } = {}) {
  const subject = subjectFor(cfg, twin);
  if (kind === 'chase') {
    const words = twin ? replies.fill('link_chase_both') : siteFill('link_chase', cfg);
    return { subject: `Re: ${subject}`, body: [replies.greeting(''), words].join('\n\n') + `\n\n${replies.fill('signature')}` };
  }
  let text;
  if (twin) {
    const [a, b] = cfg.site === 'harvington' ? [twin.row, row] : [row, twin.row];
    const listed = str(a.listed_url) && str(b.listed_url)
      ? replies.fill('link_request_listed_both', { organisation: str(row.name), page_url: str(a.listed_url), page_url2: str(b.listed_url) })
      : listedLine(a) || listedLine(b);
    text = replies.fill('link_request_both', { listed_line: listed });
  } else {
    text = siteFill(known ? 'link_request_known' : 'link_request', cfg, { listed_line: listedLine(row) });
  }
  text = text.replace(/\n{3,}/g, '\n\n');
  const parts = [replies.greeting(''), text, replies.fill('signature')];
  if (optout) parts.push(replies.fill('outreach_optout'));
  return { subject, body: parts.join('\n\n') };
}

const lower = (v) => str(v).toLowerCase();
const onRow = (r, to) => [r.email, ...String(r.other_emails || '').split(',')].some((a) => lower(a) === to);

// Have we written to them, or they to us, before (27 Nov, Jon)? Any sent Replies row or Contacts
// row (not ignore) on any site's Sheet, or any mail to or from them in Gmail that isn't a
// newsletter issue or one of these link requests. A failed Gmail search counts as not known.
async function knownTo(to, { replyRows, contactRows }) {
  const addr = lower(to);
  if (replies.emailedBefore(replyRows, addr)) return true;
  if (contactRows.some((r) => lower(r.status) !== 'ignore' && onRow(r, addr))) return true;
  const q = `{from:${addr} to:${addr} cc:${addr}} -subject:"The Lenches Newsletter" -subject:"The Harvington Newsletter" -subject:"A link to" -subject:"Links to"`;
  try { return (await g.searchMessageIds(q, 1)).length > 0; } catch { return false; }
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
  const others = otherSites();
  const [partners, rows, contacts, ...otherTabs] = await Promise.all([
    g.readTable(R.LINK_TAB), g.readTable('Replies'), g.readTable('Contacts').catch(() => []),
    ...others.map((s) => Promise.all(['Link partners', 'Replies', 'Contacts'].map((t) => g.readOtherTable(s, t).catch(() => [])))),
  ]);
  const otherReplies = otherTabs.map((t) => t[1]);
  const allReplies = R.bothReplies(rows, otherReplies);
  const matches = partners.filter((r) => str(r.id) === id);
  const now = Date.now();
  const today = londonDate(now);
  const plan = R.planLinkAsk(matches.length === 1 ? matches[0] : null, allReplies, today, SITE);
  if (plan.error) {
    console.log(`Link partner ${id}: ${plan.error.replace(/^Not drafted: /, '')}; nothing drafted.`);
    return null;
  }
  const row = matches[0];
  const to = str(row.email);
  // The same address on another site's Link partners, still to ask (a request there could go
  // now): ask for both in this one email. A chaser covers both when its request did.
  let twin = null;
  const sentReq = allReplies.filter((r) => String(r.policy_codes || '').split(/[\s,;|]+/).includes(`link_request_${id}`)
    && (str(r.status) === 'sent' || str(r.sent_at))).pop();
  others.forEach((s, i) => {
    if (twin) return;
    const theirs = R.bothReplies(otherReplies[i], [rows]);
    const cand = otherTabs[i][0].filter((r) => lower(r.email) === lower(to) && str(r.id));
    for (const r of cand) {
      const covered = sentReq && String(sentReq.policy_codes || '').split(/[\s,;|]+/).includes(`link_request_${str(r.id)}@${s}`);
      const p = R.planLinkAsk(r, theirs, today, s);
      if ((plan.kind === 'request' && p.kind === 'request') || (plan.kind === 'chase' && covered)) { twin = { site: s, row: r, cfg: siteConfigFor(s) }; break; }
    }
  });
  const known = plan.kind === 'request' && await knownTo(to, {
    replyRows: allReplies, contactRows: [...contacts, ...otherTabs.flatMap((t) => t[2])],
  });
  const { subject, body } = linkEmail(row, plan.kind, { optout: !replies.emailedBefore(rows, to), known, twin });
  const codes = [`link_${plan.kind}_${id}`];
  if (twin) codes.push(`link_${plan.kind}_${str(twin.row.id)}@${twin.site}`);
  const fresh = {
    reply_id: `link-${id}-${plan.kind}-${londonDateTime(now).replace(/\D/g, '')}`,
    message_id: '',
    thread_id: '',
    to,
    type: 'outreach',
    class: 'outreach',
    class_confidence: '',
    hold_reason: '',
    policy_codes: codes.join(' '),
    subject,
    body,
    status: mode === 'shadow' ? 'shadow' : 'awaiting',
    created_at: londonDateTime(now),
    notes: (plan.kind === 'chase'
      ? `Link request chaser for ${str(row.name)}, as you asked in the panel; it goes on the same thread as the request`
      : `Link request to ${str(row.name)}, as you asked in the panel (SEO, Inbound links)`)
      + (twin ? `; asks for links to both websites (also their ${twin.cfg.name || twin.site} Link partners row)` : '')
      + (known ? '; shorter wording, as we have written to them before' : ''),
  };
  await g.appendRows('Replies', [fresh]);
  await feedback.record(fresh, { mode });
  console.log(`Link partner ${id}: drafted ${fresh.reply_id} (${plan.kind}, ${fresh.status}${twin ? ', both sites' : ''}${known ? ', known' : ''}).`);
  return fresh;
}

module.exports = { draftLinkAsk, linkEmail, subjectFor, knownTo };
