// worker/src/admin/suggestions.mjs
// Suggest a tradesperson / somewhere to eat (part 2 of Suggest/Recommend, 3 Nov). Pure rules,
// shared by the Worker (the public form, worker/src/listingsuggest.js; the panel's Suggestions screen,
// admin/index.js) and scripts/listingsuggest (which loads this file with import(), as scripts/outreach
// does outreach.mjs):
//   the Listing suggestions tab's headers, the form's limits, the entry a suggestion would add
//   (draftEntry), Jon's edited entry checked field by field (cleanEntry), names already listed
//   that look the same (similarNames), where a new entry goes in the data file (insertEntry),
//   and the panel's Approve / Edit / Reject -> the decide() payload (planSuggestion).
// The suggester's address and "why" never leave the Sheet and the panel: never in the site,
// a log, an env or a commit.

export const SUGGEST_TAB = 'Listing suggestions';
export const SUGGEST_HEADERS = ['id', 'requested', 'kind', 'name', 'trade', 'contact', 'area', 'why', 'email', 'key',
  'status', 'sent_at', 'confirmed_at', 'decided_at', 'entry', 'reject_reason', 'result'];
export const SUGGEST_ID = /^sg-\d{8}-[a-z0-9]{6}$/;

export const KINDS = {
  trades: { label: 'Local trades', page: '/living-here/trades/', list: 'trades', file: 'trades.json' },
  eat: { label: 'Where to eat', page: '/living-here/eat/', list: 'places', file: 'eat.json' },
};

// Form limits (characters).
export const LIMITS = { name: 80, trade: 60, contact: 200, area: 80, why: 1000 };

// Each kind's fields as they go in the data file, in order. Tags are true or left out.
const FIELDS = {
  trades: ['name', 'trade', 'what', 'covers', 'base', 'contact', 'phone', 'phone2', 'email', 'other', 'website'],
  eat: ['name', 'area', 'where', 'type', 'food', 'phone', 'website', 'note', 'garden', 'children', 'dogs'],
};
const REQUIRED = { trades: ['name', 'trade'], eat: ['name', 'area', 'type'] };
const TAGS = ['garden', 'children', 'dogs'];
const LONG = new Set(['what', 'note', 'food']);

const str = (v) => String(v ?? '').trim();
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const refuse = (status, error) => ({ error, status });
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const DOMAIN_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s<>"]*)?$/i;

// Same as lib/listings.js listingId without the "taken" list: for spotting names already listed.
export function slug(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const listOf = (kind, data) => (data && data[kind] && Array.isArray(data[kind][KINDS[kind].list]) ? data[kind][KINDS[kind].list] : []);

// "www.Example.co.uk/menu/" -> "example.co.uk/menu"
function linkText(url) {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

// The one "phone or website" box -> the entry's own fields.
export function contactFields(text) {
  const t = oneLine(text, LIMITS.contact);
  if (!t) return {};
  const digits = t.replace(/\D/g, '');
  if (/^[+(\d][\d\s()+-]*$/.test(t) && digits.length >= 10 && digits.length <= 13) return { phone: t };
  if (EMAIL_RE.test(t)) return { email: t.toLowerCase() };
  if (DOMAIN_RE.test(t)) {
    const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    return { website: { text: linkText(url), url } };
  }
  return { other: t };
}

// Where to eat's area from the suggester's "area or village".
export function areaFor(text, areas = []) {
  const t = str(text).toLowerCase();
  const exact = areas.find((a) => a.toLowerCase() === t);
  if (exact) return exact;
  for (const a of areas) {
    const words = a.toLowerCase().split(/\s+and\s+|\s+/).filter((w) => w.length > 3 && !['nearby', 'villages'].includes(w));
    if (words.some((w) => t.includes(w))) return a;
  }
  return areas.find((a) => /nearby/i.test(a)) || areas[0] || '';
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The entry a suggestion row would add as it stands (no id: the script gives it one).
export function draftEntry(kind, row, data) {
  const name = oneLine(row.name, LIMITS.name);
  const area = oneLine(row.area, LIMITS.area);
  const contact = contactFields(row.contact);
  if (kind === 'trades') {
    const typed = oneLine(row.trade, LIMITS.trade);
    const known = [...new Set(listOf('trades', data).map((t) => t.trade))].find((t) => t.toLowerCase() === typed.toLowerCase());
    return order('trades', { name, trade: known || capital(typed), base: area, ...contact });
  }
  const areas = (data && data.eat && data.eat.areas) || [];
  return order('eat', { name, area: areaFor(area, areas), where: area, type: capital(oneLine(row.trade, LIMITS.trade)), ...contact });
}

function order(kind, e) {
  const out = {};
  for (const k of FIELDS[kind]) {
    if (TAGS.includes(k)) { if (e[k] === true) out[k] = true; continue; }
    if (k === 'website') { if (e.website && e.website.url) out.website = { text: e.website.text, url: e.website.url }; continue; }
    if (e[k] !== undefined && e[k] !== '') out[k] = e[k];
  }
  return out;
}

// Jon's Edit form (or the draft) checked. Returns { entry } or { error }.
export function cleanEntry(kind, fields, data) {
  if (!Object.prototype.hasOwnProperty.call(FIELDS, kind)) return { error: 'Unknown page' };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { error: 'Nothing to save' };
  const e = {};
  for (const k of FIELDS[kind]) {
    if (TAGS.includes(k)) { if (fields[k] === true) e[k] = true; continue; }
    if (k === 'website') {
      const w = fields.website && typeof fields.website === 'object' ? fields.website : {};
      let url = oneLine(w.url, 300);
      if (!url) continue;
      if (!/^https?:\/\//i.test(url) && DOMAIN_RE.test(url)) url = `https://${url}`;
      if (!URL_RE.test(url)) return { error: 'The website address should start https://' };
      e.website = { text: oneLine(w.text, 80) || linkText(url), url };
      continue;
    }
    const v = oneLine(fields[k], LONG.has(k) ? 300 : 120);
    if (!v) continue;
    if (k === 'email' && !EMAIL_RE.test(v)) return { error: 'That email address doesn\'t look right' };
    e[k] = k === 'email' ? v.toLowerCase() : v;
  }
  for (const k of REQUIRED[kind]) if (!e[k]) return { error: `Fill in ${k}` };
  if (kind === 'eat') {
    const areas = (data && data.eat && data.eat.areas) || [];
    if (!areas.includes(e.area)) return { error: `Area must be one of: ${areas.join(', ')}` };
  }
  if (kind === 'trades' && !(e.phone || e.email || e.website || e.other)) return { error: 'Give a phone, email, website or other way to contact them' };
  return { entry: order(kind, e) };
}

// Names already on that page that look like this one (same or overlapping slug).
export function similarNames(kind, name, data) {
  const s = slug(name);
  if (!s) return [];
  const words = (x) => x.split('-').filter((w) => w.length > 3);
  const mine = words(s);
  return listOf(kind, data).filter((x) => {
    const t = slug(x.name);
    if (t === s || (t.length >= 4 && s.includes(t)) || (s.length >= 4 && t.includes(s))) return true;
    const theirs = words(t);
    return mine.length > 0 && mine.filter((w) => theirs.includes(w)).length >= Math.min(2, mine.length);
  }).map((x) => x.name);
}

// The data file with the entry added: Local trades after the last of its trade (else at the
// end); Where to eat in name order within its area (else after the last of that area).
export function insertEntry(kind, data, entry) {
  const list = listOf(kind, data).slice();
  const key = kind === 'trades' ? 'trade' : 'area';
  const same = list.map((x, i) => [x, i]).filter(([x]) => x[key] === entry[key]);
  let at = list.length;
  if (same.length) {
    at = same[same.length - 1][1] + 1;
    if (kind === 'eat') {
      const after = same.find(([x]) => String(x.name).localeCompare(entry.name, 'en-GB', { sensitivity: 'base' }) > 0);
      if (after) at = after[1];
    }
  }
  list.splice(at, 0, entry);
  return { ...data[kind], [KINDS[kind].list]: list };
}

// Where a row sits: waiting (confirmed, for Jon), or '' (anything else: not shown).
export const isWaiting = (row) => str(row.status).toLowerCase() === 'confirmed' && SUGGEST_ID.test(str(row.id));

// The panel's rows: waiting ones only, without the address or its key.
export function panelRows(table, data) {
  if (!table || table.error) return table;
  return {
    rows: table.rows.filter(isWaiting).map((r) => ({
      _row: r._row, id: r.id, kind: r.kind, name: r.name, trade: r.trade, contact: r.contact, area: r.area, why: r.why,
      requested: r.requested, confirmed_at: r.confirmed_at,
      _label: KINDS[r.kind] ? KINDS[r.kind].label : str(r.kind),
      _draft: KINDS[r.kind] ? draftEntry(r.kind, r, data) : null,
      _similar: KINDS[r.kind] ? similarNames(r.kind, r.name, data) : [],
    })),
  };
}

// Approve / Edit (Save and approve) / Reject -> { p, reason, body } for decide(), or { error, status }.
// fields: Jon's edited entry (Edit only), sent on as JSON in the body; scripts/listingsuggest checks it again.
export function planSuggestion({ action, id, fields, reason }, row, data) {
  if (!['approve', 'edit', 'reject'].includes(action)) return refuse(400, `Unknown action "${action}"`);
  if (!SUGGEST_ID.test(String(id || ''))) return refuse(400, 'Invalid suggestion id');
  if (!row) return refuse(404, `No suggestion ${id}`);
  if (!isWaiting(row)) return refuse(409, `This suggestion is already "${str(row.status)}"`);
  if (!KINDS[row.kind]) return refuse(400, 'Unknown page');
  if (action === 'reject') return { p: { a: 'sug_no', i: id }, reason: oneLine(reason, 300), body: '' };
  if (action === 'approve') {
    const c = cleanEntry(row.kind, draftEntry(row.kind, row, data), data);
    if (c.error) return refuse(400, `${c.error}: use Edit`);
    return { p: { a: 'sug_ok', i: id }, reason: '', body: '' };
  }
  const c = cleanEntry(row.kind, fields, data);
  if (c.error) return refuse(400, c.error);
  const body = JSON.stringify(c.entry);
  if (body.length > 3000) return refuse(400, 'Too long');
  return { p: { a: 'sug_ok', i: id, b: body }, reason: '', body };
}
