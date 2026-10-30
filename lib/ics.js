// lib/ics.js
// "Add to calendar" files for the Events page (30 Oct 2026). src/calendar.11ty.js writes one
// /calendar/<event id>.ics per upcoming event at build; events.njk links to it under each event.
// Events have no time field, so startTime() reads the first clear time from the body text
// ("from 7.30pm", "10am to noon", "2 to 4pm", "6.30 for 7pm"); with none, or for a multi-day
// event, the entry is all-day. A start with no end time gets one hour. Times are floating
// (local, no time zone), which every calendar app shows as UK time for UK readers.

const NUM = String.raw`(\d{1,2})(?:[.:](\d{2}))?`;
const MER = String.raw`(am|pm|noon|midday)`;
// Separator: a dash, "to", "and" (only in "between X and Y"), or "for" ("7.30 for 8pm": start X, no end).
const RANGE = new RegExp(String.raw`(between\s+)?\b${NUM}\s*(am|pm)?\s*(-|–|—|to|and|for(?: an?)?)\s*(?:${NUM})?\s*${MER}`, 'i');
const SINGLE = new RegExp(String.raw`\b${NUM}\s*(am|pm)\b|\b(noon|midday)\b`, 'i');

function toMinutes(h, m, mer) {
  mer = (mer || '').toLowerCase();
  if (mer === 'noon' || mer === 'midday') return 12 * 60 + (m || 0);
  h = Number(h) % 12;
  if (mer === 'pm') h += 12;
  return h * 60 + Number(m || 0);
}

// { start, end } in minutes after midnight, end may be null; null if no clear time.
function startTime(text) {
  const t = String(text || '');
  const r = RANGE.exec(t);
  if (r) {
    const [, between, h1, m1, mer1, sep, h2, m2, mer2] = r;
    const endMer = mer2.toLowerCase();
    const end = h2 ? toMinutes(h2, m2, endMer) : toMinutes(12, 0, endMer);
    // "2 to 4pm" takes pm from the end; "10 to 2pm" (start later on the clock) takes am.
    let start = toMinutes(h1, m1, mer1 || (endMer === 'noon' || endMer === 'midday' ? 'am' : endMer));
    if (!mer1 && start > end) start -= 12 * 60;
    const word = sep.toLowerCase();
    const joined = word !== 'and' || between; // "and" only joins a range after "between"
    if (joined && start >= 0 && start < 24 * 60 && end > start) return { start, end: word.startsWith('for') ? null : end };
  }
  const s = SINGLE.exec(t);
  if (!s) return null;
  if (s[4]) return { start: 12 * 60, end: null };
  return { start: toMinutes(s[1], s[2], s[3]), end: null };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (iso) => iso.replace(/-/g, '');
const hhmm = (min) => pad(Math.floor(min / 60)) + pad(min % 60) + '00';
function nextDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Fold lines at 75 octets (RFC 5545), not splitting a UTF-8 character.
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// The venue is the part of the title after " — " (titles are "What — Where").
const locationOf = (title) => (String(title).split(' — ')[1] || '').trim();

function eventIcs(e, { id, url, stamp = new Date() }) {
  const time = e.endDate && e.endDate !== e.date ? null : startTime(e.body);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Lenches Website//Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${id}@thelenches.org.uk`,
    `DTSTAMP:${stamp.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
  ];
  if (time) {
    const end = time.end != null ? time.end : Math.min(time.start + 60, 24 * 60 - 1);
    lines.push(`DTSTART:${ymd(e.date)}T${hhmm(time.start)}`, `DTEND:${ymd(e.date)}T${hhmm(end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(e.endDate || e.date))}`);
  }
  lines.push(`SUMMARY:${esc(e.title)}`);
  const loc = locationOf(e.title);
  if (loc) lines.push(`LOCATION:${esc(loc)}`);
  lines.push(`DESCRIPTION:${esc(String(e.body || '') + (e.link && e.link.url ? `\n\n${e.link.text || 'More'}: ${e.link.url}` : '') + `\n\nThe Lenches Website: ${url}`)}`);
  lines.push(`URL:${url}`, 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { startTime, eventIcs, locationOf };
