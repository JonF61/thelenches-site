// scripts/ingest/trusted.js
// Trusted sources: items from these would publish automatically (status "auto") unless they
// need a human decision anyway (trustBlocked). Stage 1 of graduated autonomy (Jon, 2 Nov
// 2026): PANEL_FIRST holds every item for Jon's tap in the panel outside holiday mode, so a
// trusted source's item only gets the note "trusted source" (Item feedback counts it) until
// Jon approves autonomy for it. The "Trusted" tab is created here if it
// is missing; removing a row there removes the trust.
//   source_key       lower-cased sender address (Gmail) or the feed URL as in Settings
//   type             email | feed
//   label            sender display name or Settings source name, for reading only
//   added_at         YYYY-MM-DD HH:MM UK
//   added_from_item  Pending id whose "Trust this source" button added it
// Rows are added by the daily approvals email's "Trust this source" button
// (Worker action "trust" -> scripts/approve) or typed by hand.
'use strict';

const g = require('./google');

const TAB = 'Trusted';
const HEADERS = ['source_key', 'type', 'label', 'added_at', 'added_from_item'];
const LOW_CONFIDENCE = 0.5;
// Stage 1 (Jon, 2 Nov 2026): outside holiday mode nothing publishes without Jon's tap in the
// panel: no trusted-source or "auto" feed publishing. Only Jon turns this off, type by type.
const PANEL_FIRST = true;
// Except roadworks alerts (one.network links, as lib/roads.js isRoad): Jon doesn't need to
// approve those (2 Nov), so they keep their source's old behaviour.
const ROADWORKS = /one\.network/i;
const panelFirst = (item) => PANEL_FIRST && !ROADWORKS.test(String((item && item.link_url) || ''));
const OWN_DOMAIN = 'thelenches.org.uk';
// Facebook notification mail is never a source in its own right.
const NOT_TRUSTABLE = /@(.+\.)?(facebook\.com|facebookmail\.com)$/i;

const norm = (s) => String(s || '').trim().toLowerCase();
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());
const isFeedUrl = (s) => /^https?:\/\//i.test(String(s || ''));

// Set of trusted source keys. Creates the tab if missing.
async function loadTrusted() {
  await g.ensureTab(TAB, HEADERS);
  const rows = await g.readTable(TAB);
  return new Set(rows.map((r) => norm(r.source_key)).filter(Boolean));
}

// { key, type, label } for a Pending row from Gmail or an RSS feed, or null (no button):
// feed items whose Settings row has gone, Facebook mail and our own addresses.
function sourceKeyFor(row, sources) {
  const mid = String(row.message_id || '');
  if (!mid) return null;
  if (mid.startsWith('rss:')) {
    const feed = (sources || []).find((s) => s.source === row.source && isFeedUrl(s.match));
    return feed ? { key: norm(feed.match), type: 'feed', label: feed.source } : null;
  }
  const addr = norm(g.addressOf(row.from));
  if (!addr || NOT_TRUSTABLE.test(addr) || addr.endsWith(`@${OWN_DOMAIN}`)) return null;
  const name = String(row.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  return { key: addr, type: 'email', label: name && norm(name) !== addr ? name : row.source || '' };
}

// Reason a trusted source's item still needs a human decision, or ''.
// emailFlags: { anonymous, outOfScope } from the extraction of the whole email.
function trustBlocked(item, emailFlags = {}) {
  if (truthy(item.people_in_image)) return 'people_in_image';
  if (truthy(item.political_commercial)) return 'political_commercial';
  if (truthy(item.official)) return 'official';
  if (emailFlags.anonymous) return 'anonymous';
  if (emailFlags.outOfScope) return 'out_of_scope';
  if (truthy(item.classified)) return 'classified';
  if (!(Number(item.confidence) >= LOW_CONFIDENCE)) return 'low_confidence';
  return '';
}

// Status after trust: "auto" (with byTrust) when a pending item from a trusted source
// has no blocker; otherwise the status as decided before. With PANEL_FIRST it stays
// pending and trustedSource marks it (note "trusted source").
function applyTrust(status, item, key, trusted, emailFlags) {
  const isTrusted = Boolean(key && trusted && trusted.has(norm(key)));
  if (status !== 'pending' || !isTrusted) return { status, byTrust: false, trustedSource: isTrusted };
  if (trustBlocked(item, emailFlags)) return { status, byTrust: false, trustedSource: true };
  if (panelFirst(item)) return { status, byTrust: false, trustedSource: true };
  return { status: 'auto', byTrust: true, trustedSource: true };
}

// Adds a Trusted row unless the key is already there. Returns true if added.
async function addTrusted({ key, type, label }, itemId, stamp) {
  const trusted = await loadTrusted();
  if (trusted.has(norm(key))) return false;
  await g.appendRows(TAB, [{
    source_key: norm(key), type, label, added_at: stamp, added_from_item: itemId,
  }]);
  return true;
}

module.exports = {
  TAB, HEADERS, PANEL_FIRST, panelFirst, loadTrusted, sourceKeyFor, trustBlocked, applyTrust, addTrusted,
};
