// scripts/ingest/subscriptions.js
// Automatic subscribe / unsubscribe by email (part 2, agreed 23 Oct: always automatic).
// Used by replies.js when an email is confidently classed subscribe or unsubscribe. Only
// ever the sender's own From address, never one written in the email, and only when the
// reply goes back to that same address.
//   subscribe    added to Subscribers (status "active" if the tab has that column).
//                Already active: nothing to add. On Do Not Send, or a Subscribers row with
//                another status: refused, so Jon decides (removing a Do Not Send row is his).
//   unsubscribe  added to Do Not Send, as the one-click link does (scripts/newsletter/
//                unsubscribe.js); the newsletter never sends to anyone on it.
// Never logs the address: this repo's Actions logs are public.
'use strict';

const g = require('./google');

const OWN_DOMAIN = 'thelenches.org.uk';
const ADDRESS_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const lc = (v) => String(v ?? '').trim().toLowerCase();

// kind: 'subscribe' | 'unsubscribe'. stamp: 'YYYY-MM-DD HH:MM' (UK).
// opts.source / opts.notes: what a new Subscribers row says (the web sign-up form,
// scripts/signup, passes its own); the default is Holly's email route.
// Returns { done: 'subscribed' | 'already' | 'unsubscribed' | 'already_off' } or { refused: why }.
async function applyListRequest(kind, address, stamp, opts = {}) {
  const email = lc(address);
  if (!ADDRESS_RE.test(email) || email.endsWith(`@${OWN_DOMAIN}`)) return { refused: 'not a usable address' };
  const [subscribers, dns] = await Promise.all([g.readTable('Subscribers'), g.readTable('Do Not Send')]);
  if (subscribers.length && !subscribers.some((r) => 'email' in r)) return { refused: 'Subscribers has no "email" header' };
  const onDns = dns.some((r) => lc(r.email) === email);
  const rows = subscribers.filter((r) => lc(r.email) === email);
  const date = stamp.slice(0, 10);

  if (kind === 'unsubscribe') {
    if (onDns) return { done: 'already_off' };
    await g.appendRows('Do Not Send', [{
      email, reason: 'asked by email', source: 'email to website@', date, added_at: stamp,
      notes: 'added automatically by Holly',
    }]);
    return { done: 'unsubscribed' };
  }

  if (onDns) return { refused: 'they are on Do Not Send (delete that row to add them back)' };
  const active = (r) => !('status' in r) || !String(r.status || '').trim() || lc(r.status) === 'active';
  if (rows.some(active)) return { done: 'already' };
  if (rows.length) return { refused: `their Subscribers row has status "${rows[0].status}"` };
  await g.appendRows('Subscribers', [{
    email, status: 'active', source: opts.source || 'email to website@', date, added_at: stamp,
    notes: opts.notes || 'added automatically by Holly',
  }]);
  return { done: 'subscribed' };
}

module.exports = { applyListRequest };
