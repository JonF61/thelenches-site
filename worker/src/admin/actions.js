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
// tab has a people_ok column. Returns { p } for decide(), or { error, status }.
export function planPending({ action, id }, row, { hasPeopleOk = false, sources = [] } = {}) {
  if (!PENDING_ACTIONS.includes(action)) return refuse(400, `Unknown action "${action}"`);
  if (!row) return refuse(404, `No Pending item ${id}`);
  if (row.status !== 'pending') return refuse(409, `This item is already "${row.status}"`);
  if (APPROVING.has(action) && truthy(row.people_in_image)) {
    if (!hasPeopleOk) return refuse(409, 'The image shows people: add a people_ok column at the end of Pending first');
    if (!truthy(row.people_ok)) return refuse(409, 'The image shows people: tick "people OK" before approving');
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
