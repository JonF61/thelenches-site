// worker/src/admin/messages.js
// A contact's message history (1 Nov 2026): the panel's contact page lists every email between
// us and that person, newest first, each with its date, who wrote it (them, Holly or you) and
// just the words: quoted earlier emails, signatures and Holly's sign-off and opt-out line are
// cut, so nothing pads it out. Read live from Gmail (GMAIL_USER's mailbox, which holds
// website@'s mail too): messages from or to any of the row's addresses (email + other_emails),
// newest MAX_MESSAGES. Left out: the newsletter (its subject) and automatic mail
// (Auto-Submitted: auto-generated, e.g. sign-up confirmations). "Holly" = a message whose
// Gmail id is a sent Replies row (sent_gmail_id), or one from us that ends with her sign-off;
// anything else from us is "you". Nothing is stored or logged.
import { splitSignature } from './google.js';

export const MAX_MESSAGES = 25;
const NEWSLETTER_SUBJECT = 'The Lenches Newsletter';
const str = (v) => String(v ?? '').trim();

// The Gmail search for these addresses.
export function historyQuery(addresses) {
  const parts = addresses.flatMap((a) => [`from:${a}`, `to:${a}`]);
  return `{${parts.join(' ')}} -subject:"${NEWSLETTER_SUBJECT}"`;
}

// The bare address in a From/To header.
export const addressIn = (h) => {
  const m = String(h || '').match(/<([^>]+)>/);
  return str(m ? m[1] : h).toLowerCase();
};

// Holly's sign-off, opt-out line and anything after: cut.
const HOLLY_END = /\n+(?:If you'd rather we didn't get in touch[^\n]*\n+)?Best wishes,\s*\n\s*Holly\b[\s\S]*$/;
const OPTOUT = /\n+If you'd rather we didn't get in touch[^\n]*$/;

// One Gmail message (format=full, already turned into { from, to, subject, date, text, more,
// auto, internalDate, id }) -> a history entry, or null if it is left out.
export function entryFor(m, { addresses, hollyIds }) {
  if (/auto-generated/i.test(m.auto || '')) return null;
  if (String(m.subject || '').includes(NEWSLETTER_SUBJECT)) return null;
  const from = addressIn(m.from);
  const theirs = addresses.includes(from);
  const raw = String(m.text || '');
  const holly = !theirs && (hollyIds.has(m.id) || HOLLY_END.test(raw));
  let text = raw;
  if (!theirs) text = text.replace(HOLLY_END, '').replace(OPTOUT, '');
  text = splitSignature(text).text.replace(/\n{3,}/g, '\n\n').trim();
  return {
    id: m.id,
    at: Number(m.internalDate) ? new Date(Number(m.internalDate)).toISOString() : '',
    who: theirs ? 'them' : holly ? 'holly' : 'you',
    subject: str(m.subject),
    text,
  };
}

// Newest first, without duplicates.
export function history(messages, ctx) {
  const seen = new Set();
  return messages.map((m) => entryFor(m, ctx)).filter((e) => e && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => b.at.localeCompare(a.at));
}
