// worker/src/admin/actions.js
// Panel buttons -> the same decision payload a signed email link carries (core.js
// validPayload / decide), so approval.yml and scripts/approve see exactly what they see
// today, with the same per-item concurrency group (client_payload.id).
//   Pending  approve, approve_own, approve_rewrite, reject, trust
//   Replies  approve (= send), reject (= skip, optional reason), edit (text required),
//            redraft (instruction required), close
//   Photos   approve / reject: no workflow exists for these, so they are a Photos status
//            cell write (stale-checked), as typing "approved" in the Sheet is today; the
//            daily photos run publishes.
// Extra panel rule: an item whose image shows people needs people_ok "yes" before any
// approve (Pending people_in_image; Photos people identifiable/children/unknown).

import { validPayload, cleanReason, cleanBody } from '../core.js';

export const PENDING_ACTIONS = ['approve', 'approve_own', 'approve_rewrite', 'reject', 'trust'];
export const REPLY_ACTIONS = { approve: 'send', reject: 'skip', edit: 'edit', redraft: 'redraft', close: 'close' };
export const PHOTO_ACTIONS = { approve: 'approved', reject: 'rejected' };
const APPROVING = new Set(['approve', 'approve_own', 'approve_rewrite', 'trust']);
const PHOTO_CONSENT = new Set(['identifiable', 'children', 'unknown']);
const NOT_TRUSTABLE = /@(.+\.)?(facebook\.com|facebookmail\.com)$/i;
const OWN_DOMAIN = 'thelenches.org.uk';

export const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());
const norm = (s) => String(s || '').trim().toLowerCase();

// As scripts/ingest/google.js addressOf.
export function addressOf(value) {
  const v = String(value || '');
  const angle = v.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle ? angle[1] : (v.match(/[^\s<>,;"']+@[^\s<>,;"']+/) || [''])[0];
  return bare.trim().toLowerCase();
}

// As scripts/ingest/trusted.js sourceKeyFor, key only: the address or feed URL that
// "Trust this source" adds, or '' when the item has none (no button). sources: Settings A:C.
export function trustKeyFor(row, sources) {
  const mid = String(row.message_id || '');
  if (!mid) return '';
  if (mid.startsWith('rss:')) {
    const feed = (sources || []).find((s) => s.source === row.source && /^https?:\/\//i.test(s.match));
    return feed ? norm(feed.match) : '';
  }
  const addr = norm(addressOf(row.from));
  if (!addr || NOT_TRUSTABLE.test(addr) || addr.endsWith(`@${OWN_DOMAIN}`)) return '';
  return addr;
}

const refuse = (status, error) => ({ error, status });

// Pending decision. row: the Pending row (null if not found); hasPeopleOk: whether the
// tab has a people_ok column; choicePeople: the people value of the suggested image chosen
// for it (image_choice), if any. Returns { p } for decide(), or { error, status }.
export function planPending({ action, id }, row, { hasPeopleOk = false, sources = [], choicePeople = '' } = {}) {
  if (!PENDING_ACTIONS.includes(action)) return refuse(400, `Unknown action "${action}"`);
  if (!row) return refuse(404, `No Pending item ${id}`);
  if (row.status !== 'pending') return refuse(409, `This item is already "${row.status}"`);
  if (APPROVING.has(action) && truthy(row.people_in_image)) {
    if (!hasPeopleOk) return refuse(409, 'The image shows people: add a people_ok column at the end of Pending first');
    if (!truthy(row.people_ok)) return refuse(409, 'The image shows people: tick "people OK" before approving');
  }
  // A chosen suggestion that may show people: People OK must still be ticked at approval.
  if (APPROVING.has(action) && PEOPLE_FLAG.has(norm(choicePeople)) && !truthy(row.people_ok)) {
    return refuse(409, 'The chosen image may show people: tick "People OK" before approving');
  }
  const p = { a: action, i: String(id) };
  if (action === 'trust') {
    p.k = trustKeyFor(row, sources);
    if (!p.k) return refuse(409, 'This item has no source that can be trusted');
  }
  if (!validPayload(p)) return refuse(400, 'Invalid item id');
  return { p };
}

// Reply decision. Returns { p, reason, body } for decide(), or { error, status }.
// Cleaning and minimum lengths are the same as the email pages (index.js POST /a).
export function planReply({ action, id, reason = '', body = '' }) {
  const a = REPLY_ACTIONS[action];
  if (!a) return refuse(400, `Unknown action "${action}"`);
  const p = { a, i: String(id) };
  if (a === 'edit') p.b = cleanBody(body);
  if (!validPayload(p)) return refuse(400, 'Invalid reply id');
  const r = ['skip', 'redraft', 'edit'].includes(a) ? cleanReason(reason, a === 'redraft' ? 500 : 300) : '';
  if (a === 'redraft' && r.length < 3) return refuse(400, 'Say what Holly should change');
  if (a === 'edit' && p.b.length < 10) return refuse(400, 'The reply text is empty');
  return { p, reason: r, body: a === 'edit' ? p.b : '' };
}

// Photos approve/reject: a status write. row: the Photos row; expected: the status the
// page loaded. Returns { field, value, expected } for editCell-style writing, or { error, status }.
export function planPhoto({ action, expected }, row) {
  const value = PHOTO_ACTIONS[action];
  if (!value) return refuse(400, `Unknown action "${action}"`);
  if (!row) return refuse(404, 'No such Photos row');
  if (value === 'approved' && PHOTO_CONSENT.has(norm(row.people)) && !truthy(row.people_ok)) {
    return refuse(409, 'This photo may show people: tick "people OK" before approving');
  }
  return { field: 'status', value, expected: String(expected ?? '') };
}

// Suggested images (scripts/suggest, "Image suggestions" tab): Choose / "None of these" on a
// Queue card. The choice is a stale-checked write of Pending image_choice; approval is the
// usual decide() path, and publish uses the chosen image. Only for a pending item that has
// no image of its own. An image flagged for people needs people_ok "yes" first; one showing
// children never gets here (the run drops them). Choosing an organiser's or library image also
// queues it for Lenches Photos (an "Image fetch" row, saved to Drive by image-fetch.gs, as
// organisers' images are now), once per suggestion.
export const SUGGEST_TAB = 'Image suggestions';
export const SUGGEST_SOURCES = { own: 'Own photo', organiser: "Organiser's site", library: 'Library' };
const SUGGEST_ID = /^[A-Za-z0-9_-]{1,100}#[1-9]$/;
// Only an unchecked image: adults in organiser's or library images are promotional (27 Oct).
const PEOPLE_FLAG = new Set(['unknown']);
const one = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const hasOwnImage = (row) => Boolean(String(row.image_part_id || '').trim() || String(row.image_url || '').trim());

function hostOf(href) {
  try { return new URL(href).hostname; } catch { return ''; }
}

// The Image fetch row for a chosen external image (columns by header; extra keys ignored).
export function imageFetchRow(row, s) {
  const via = s.source === 'library' ? `suggestion (${/pixabay\.com$/.test(hostOf(s.page)) ? 'Pixabay' : 'Pexels'})` : `suggestion (organiser's site, ${hostOf(s.page)})`;
  return {
    url: one(s.url, 1000),
    village: one(s.village, 60) || 'General',
    subject: one(s.subject, 60) || 'Events',
    filename: one(s.filename, 120),
    credit: one(s.credit, 120),
    source_page: one(s.page, 1000),
    status: '',
    notes: one(`Chosen in the admin panel for Pending ${row.id}${s.licence ? `; licence ${s.licence}` : ''}`, 300),
    event: one(s.event, 250),
    suggested_target: one(s.target, 250),
    found_via: via,
    check: one(s.check, 300),
  };
}

// Returns { value, save } (save: the Image fetch row to add, or null), or { error, status }.
export function planSuggest({ id, sid }, row, suggestion, { hasChoice = false, hasPeopleOk = false } = {}) {
  if (!row) return refuse(404, `No Pending item ${id}`);
  if (row.status !== 'pending') return refuse(409, `This item is already "${row.status}"`);
  if (!hasChoice) return refuse(409, 'Add an image_choice column at the end of Pending first');
  if (hasOwnImage(row)) return refuse(409, 'This item already has an image');
  if (sid === 'none') return { value: 'none', save: null };
  if (!SUGGEST_ID.test(String(sid || ''))) return refuse(400, 'Invalid suggestion');
  if (!suggestion || String(suggestion.item) !== String(row.id)) return refuse(404, 'That suggestion has gone: reload the page');
  const source = String(suggestion.source || '');
  if (!SUGGEST_SOURCES[source]) return refuse(409, 'That suggestion has no image');
  const people = norm(suggestion.people);
  if (people === 'children') return refuse(409, 'This image shows children and cannot be used');
  if (PEOPLE_FLAG.has(people)) {
    if (!hasPeopleOk) return refuse(409, 'This image may show people: add a people_ok column at the end of Pending first');
    if (!truthy(row.people_ok)) return refuse(409, 'This image may show people: tick "People OK" first');
  }
  const save = source !== 'own' && norm(suggestion.status) !== 'saved' ? imageFetchRow(row, suggestion) : null;
  return { value: String(sid), save };
}

// Newsletter draft screen: Rebuild (nlquiet: rebuild, nothing sent) or Test send (nltest:
// the preview of that build to Jon only). The issue date is the draft's, today to 7 days on.
// Returns { p } for decide(), or { error, status }.
export function planNewsletter({ action, issueDate }, today) {
  const a = { rebuild: 'nlquiet', test: 'nltest' }[String(action || '')];
  if (!a) return { error: `Unknown newsletter action "${action}"`, status: 400 };
  const i = String(issueDate || '');
  const p = { a, i };
  if (!validPayload(p)) return { error: 'Bad issue date', status: 400 };
  const last = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  if (i < today || i > last) return { error: `The ${i} issue is not the next one: Refresh the draft first`, status: 409 };
  return { p };
}
