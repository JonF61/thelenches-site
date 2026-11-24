'use strict';
// Which Thursday newsletter issues an item is (or will be) in (24 Nov 2026, Jon, after an
// Already listed thanks told a sender her events were on the website but not whether they
// were in "this week's email", which she had asked about). Mirrors newsletter/select.js:
// an event is in every issue whose two-week window (issue date to +13 days) holds its date;
// a submitted (Pending) notice once, in the next issue; a hand-written notice up to 3 issues
// from the one after it was added. Roads items say nothing. Pure: no Sheet or file reads.
//
// Used by replies.js: the Already listed thanks adds one fixed sentence per listed item
// (templates.md listed_nl_*), and Holly's drafts get each sender item's `newsletter` line,
// so she never has to guess.

const TZ = 'Europe/London';
const WINDOW_DAYS = 14;        // newsletter/select.js WINDOW_DAYS
const NOTICE_ISSUES = 3;       // newsletter/select.js MAX_APPEARANCES (hand-written notices)

const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '').trim()) ? String(v).trim().slice(0, 10) : '');
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const shortDate = (ymd) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long' })
  .format(new Date(`${ymd}T12:00:00Z`));

// The next issue still to go out: today if it's Thursday before noon (UK), else the next Thursday.
function nextIssue(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (t) => parts.find((p) => p.type === t).value;
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  if (weekday(today) === 4 && Number(get('hour')) < 12) return today;
  let d = addDays(today, 1);
  while (weekday(d) !== 4) d = addDays(d, 1);
  return d;
}

// item: { kind: 'event' | 'notice', date, newsletterCount, added, handWritten, roads }
// -> { issues: [YYYY-MM-DD…] still to come, already: true when it has had its turn } or null.
function plan(item, ms = Date.now()) {
  if (!item || item.roads) return null;
  const next = nextIssue(ms);
  if (item.kind === 'event') {
    const date = day(item.date);
    if (!date || date < next) return null; // before the next issue: nothing left to say
    const issues = [];
    for (let t = next; t <= date; t = addDays(t, 7)) if (date <= addDays(t, WINDOW_DAYS - 1)) issues.push(t);
    return { issues, already: false };
  }
  if (item.handWritten) {
    const added = day(item.added);
    if (!added) return null;
    let first = addDays(added, 1);
    while (weekday(first) !== 4) first = addDays(first, 1);
    const issues = [];
    for (let i = 0, t = first; i < NOTICE_ISSUES; i += 1, t = addDays(t, 7)) if (t >= next) issues.push(t);
    return { issues: issues.slice(0, 1), already: issues.length < NOTICE_ISSUES };
  }
  if (Number(item.newsletterCount) > 0) return { issues: [], already: true };
  return { issues: [next], already: false };
}

const joinDates = (ds) => (ds.length < 2 ? ds.join('') : `${ds.slice(0, -1).join(', ')} and ${ds[ds.length - 1]}`);
// "3 and 10 December" when one month, else "26 November and 3 December".
function dateList(ymds) {
  const month = (d) => d.slice(0, 7);
  if (ymds.length > 1 && ymds.every((d) => month(d) === month(ymds[0]))) {
    return `${joinDates(ymds.map((d) => String(Number(d.slice(8)))))} ${shortDate(ymds[0]).replace(/^\d+ /, '')}`;
  }
  return joinDates(ymds.map(shortDate));
}

// The fixed sentence for a reply (templates.md keys; fill is replies.js fill), or '' when there
// is nothing to say or the template isn't there.
function sentence(p, fill, has, ms = Date.now()) {
  if (!p) return '';
  const next = nextIssue(ms);
  const use = (key, vars) => (has(key) ? fill(key, vars) : '');
  if (!p.issues.length) return p.already ? use('listed_nl_past', {}) : '';
  const [first, ...rest] = p.issues;
  if (first === next) {
    return rest.length ? use('listed_nl_this_and', { this_date: shortDate(first), later: dateList(rest) })
      : use('listed_nl_this', { this_date: shortDate(first) });
  }
  return use(p.issues.length > 1 ? 'listed_nl_later_many' : 'listed_nl_later', { dates: dateList(p.issues) });
}

// Plain words for Holly's and Rimmer's input (sender_items[].newsletter).
function words(p, ms = Date.now()) {
  if (!p) return '';
  if (!p.issues.length) return p.already ? 'already been in the newsletter' : '';
  const next = nextIssue(ms);
  const label = (d) => (d === next ? `this Thursday's issue (${shortDate(d)})` : `the ${shortDate(d)} issue`);
  return `in ${joinDates(p.issues.map(label))}`;
}

module.exports = { WINDOW_DAYS, nextIssue, plan, sentence, words, shortDate };
