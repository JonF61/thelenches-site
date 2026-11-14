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
    if (!onDns) {
      await g.appendRows('Do Not Send', [{
        email, reason: 'asked by email', source: 'email to website@', date, added_at: stamp,
        notes: 'added automatically by Holly',
      }]);
    }
    // Already on Do Not Send with no Subscribers row left: nothing new to tell Jon.
    if (!onDns || rows.length) {
      try { await removeFromSubscribers(email, 'email'); } catch (err) {
        console.warn(`Subscribers tidy after an unsubscribe failed: ${err && err.message ? err.message : err}`);
      }
    }
    return { done: onDns ? 'already_off' : 'unsubscribed' };
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

// Who is off the list (31 Oct): address -> why, for everyone on Do Not Send or with a
// Subscribers row whose status isn't active. Their contributions aren't published (ingest
// index.js) and they're never added back automatically (subscribeContacts).
function offListFrom(subscribers, dns) {
  const off = new Map();
  const active = (r) => !('status' in r) || !String(r.status || '').trim() || lc(r.status) === 'active';
  const activeSet = new Set(subscribers.filter(active).map((r) => lc(r.email)));
  for (const r of subscribers) {
    const e = lc(r.email);
    if (e && !active(r) && !activeSet.has(e)) off.set(e, `Subscribers status "${String(r.status).trim()}"`);
  }
  for (const r of dns) {
    const e = lc(r.email);
    if (e) off.set(e, `on Do Not Send${String(r.reason || '').trim() ? ` (${String(r.reason).trim()})` : ''}`);
  }
  return off;
}

async function loadOffList() {
  const [subscribers, dns] = await Promise.all([g.readTable('Subscribers'), g.readTable('Do Not Send')]);
  return offListFrom(subscribers, dns);
}

// Contacts get the newsletter (Jon, 31 Oct): every address given that isn't on Subscribers
// is added as active (source "contact"), in one append; anyone off the list is left off.
// Returns counts only (addresses never reach the public log).
function planContactSubscriptions(addresses, subscribers, dns) {
  const off = offListFrom(subscribers, dns);
  const listed = new Set(subscribers.map((r) => lc(r.email)).filter(Boolean));
  const add = [];
  let already = 0;
  let offList = 0;
  let unusable = 0;
  for (const a of new Set(addresses.map(lc).filter(Boolean))) {
    if (!ADDRESS_RE.test(a) || a.endsWith(`@${OWN_DOMAIN}`)) unusable++;
    else if (off.has(a)) offList++;
    else if (listed.has(a)) already++;
    else add.push(a);
  }
  return { add, already, offList, unusable };
}

async function subscribeContacts(addresses, stamp) {
  const [subscribers, dns] = await Promise.all([g.readTable('Subscribers'), g.readTable('Do Not Send')]);
  if (subscribers.length && !subscribers.some((r) => 'email' in r)) throw new Error('Subscribers has no "email" header');
  const plan = planContactSubscriptions(addresses, subscribers, dns);
  const date = stamp.slice(0, 10);
  if (plan.add.length) {
    await g.appendRows('Subscribers', plan.add.map((email) => ({
      email, status: 'active', source: 'contact', date, added_at: stamp,
      notes: 'added automatically from Contacts',
    })));
  }
  return { added: plan.add.length, already: plan.already, offList: plan.offList, unusable: plan.unusable };
}

// Unsubscribed people leave Subscribers altogether (Jon, 14 Nov): once an address is on
// Do Not Send (which still keeps them off the newsletter and stops anything re-adding
// them), every Subscribers row for it is deleted, and Holly emails Jon to say so.
// how: 'link' (the newsletter's unsubscribe link) | 'email' (asked Holly by email).
const HOW = { link: 'using the unsubscribe link in the newsletter', email: 'by emailing website@' };

function unsubscribedEmail(email, how, removed) {
  const did = removed
    ? `I've added them to Do Not Send and deleted their row from the Subscribers tab${removed > 1 ? ` (${removed} rows)` : ''}.`
    : "I've added them to Do Not Send. They had no row in the Subscribers tab to delete.";
  const text = [
    'Hi Jon,', '',
    `${email} has unsubscribed from the newsletter ${HOW[how] || HOW.link}.`, '',
    `${did} They've had the usual confirmation and won't get the newsletter again.`, '',
    'Best wishes,', 'Holly', 'Lenches website assistant', '',
  ].join('\n');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = text.trim().split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject: `Unsubscribed: ${email}`, text, html };
}

async function removeFromSubscribers(email, how, deps = { g }) {
  const e = lc(email);
  const rows = (await deps.g.readTable('Subscribers')).filter((r) => lc(r.email) === e);
  const removed = rows.length ? await deps.g.deleteRows('Subscribers', rows.map((r) => r._row)) : 0;
  const { settings } = await deps.g.readSettings();
  await deps.g.sendMail({
    to: process.env.ALERT_TO || process.env.GMAIL_USER,
    ...unsubscribedEmail(e, how, removed),
    fromName: deps.g.fromNameFor(settings),
  });
  return removed;
}

// One-off tidy (14 Nov): every Subscribers row whose address is on Do Not Send.
// Returns the rows to delete (pure, for the test).
function planTidy(subscribers, dns) {
  const off = new Set(dns.map((r) => lc(r.email)).filter(Boolean));
  return subscribers.filter((r) => off.has(lc(r.email)));
}

module.exports = {
  applyListRequest, offListFrom, loadOffList, planContactSubscriptions, subscribeContacts,
  removeFromSubscribers, unsubscribedEmail, planTidy,
};
