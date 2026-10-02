// scripts/newsletter/actions.js
// Signed buttons for the preview and reminder emails (step 5b part 3).
//   Send     the Worker dispatches newsletter.yml action "send" with the issue date, the
//            content hash, the mode and the recipient count; send.js refuses if any of
//            them no longer matches, so a rebuild makes older Send buttons dead.
//   Rebuild  newsletter.yml action "build" (new test copy and preview).
//   Approve / Reject  the existing item actions (approval.yml).
// Send and Rebuild links expire at the end of the issue day (UK).
'use strict';

const { signToken, signedLink, linksEnabled } = require('../ingest/links');
const { buildRecipients, canaryList } = require('./send');

const MAX_PENDING = 30;
const str = (v) => String(v ?? '').trim();

function expiry(issueDate) {
  // 22:59 UTC is 23:59 UK in summer and 22:59 in winter: always inside the issue day.
  const end = Math.floor(Date.parse(`${issueDate}T22:59:00Z`) / 1000);
  return Math.max(end, Math.floor(Date.now() / 1000) + 2 * 3600);
}

// { send, rebuild, pending, pendingTotal, note }. send is null if the mode is off or there's no hash.
function buttons({ issueDate, hash, settings, subscribers, dns, pending }) {
  const items = pending
    .filter((r) => str(r.status).toLowerCase() === 'pending' && str(r.title) && str(r.id))
    .sort((x, y) => str(x.title).localeCompare(str(y.title)));
  if (!linksEnabled()) {
    return {
      send: null, rebuild: null, pendingTotal: items.length,
      pending: items.slice(0, MAX_PENDING).map((r) => ({ title: str(r.title) })),
      note: 'Buttons unavailable: APPROVAL_SIGNING_KEY or WORKER_URL is missing.',
    };
  }
  const e = expiry(issueDate);
  const mode = str(settings.newsletter_mode).toLowerCase() || 'off';
  const n = mode === 'canary'
    ? canaryList(settings.canary_to, []).length
    : buildRecipients(subscribers, dns, []).list.length;
  const label = {
    live: `Send to ${n} subscribers`,
    canary: `Canary send to ${n}`,
    shadow: `Shadow run (no emails; ${n} would-be recipients)`,
  }[mode];
  const send = label && hash
    ? { label, url: signToken({ a: 'nlsend', i: issueDate, t: label, h: hash.slice(0, 16), n, m: mode, e }) }
    : null;
  const rebuild = {
    label: 'Rebuild with approvals',
    url: signToken({ a: 'nlbuild', i: issueDate, t: `Rebuild the ${issueDate} issue`, e }),
  };
  const shown = items.slice(0, MAX_PENDING).map((r) => ({
    title: str(r.title), approve: signedLink(r, 'approve'), reject: signedLink(r, 'reject'),
  }));
  const notes = [];
  if (mode === 'off') notes.push('newsletter_mode is off: no Send button.');
  if (items.length > shown.length) notes.push(`${items.length - shown.length} more pending item(s) in the Sheet.`);
  return { send, rebuild, pending: shown, pendingTotal: items.length, note: notes.join(' ') };
}

module.exports = { buttons, expiry };
