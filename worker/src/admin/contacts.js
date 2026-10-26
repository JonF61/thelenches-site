// worker/src/admin/contacts.js
// The panel's Contacts screen (Contacts tab, filled daily by scripts/contacts). A list to
// search and filter, and a page per contact with its profile fields, notes and status
// editable. Each save is one stale-checked cell write (sheet.js checkedWrite), found by
// the email cell; nothing here sends mail or touches the approval path.
//   Profile fields (name, organisation, village, role, profile): saving one also sets
//   profile_source to "manual", in the same write, so the daily run stops rewriting them.
//   notes: Jon's own; code never writes it.
//   status: one of STATUSES (Claude picks one for a new contact; code never changes it once
//   set), "ignore" (the next run clears the row to email and status, blocked for good), a
//   value of Jon's own, or blank (Not set).
// Delete: removes the row from the Sheet and logs { email, deleted_at } in Deleted contacts, so
// the run never re-adds them from mail sent before then (only new mail as a contributor can).
// Their newsletter subscription (Subscribers tab) is not touched.
// next_nudge (column P, outreach): a date = snoozed until then, "never" = never nudged, blank
// = due when an outreach list says so (outreach.mjs). Set by Snooze / Never nudge / Clear.
// other_emails (column Q, typed by Jon in the Sheet): the same person's other addresses, shown
// on the contact page; Delete logs each of them too.
// Ignore rows never leave the server (nothing of them is shown; scripts/contacts clears them).

export const CONTACTS_TAB = 'Contacts';
export const PROFILE_FIELDS = ['name', 'organisation', 'village', 'role', 'profile'];
// Same list as scripts/contacts/contacts.js STATUSES.
export const STATUSES = ['contributor', 'lead', 'collaborator', 'official', 'organiser', 'business', 'media', 'other'];
export const DELETED_TAB = 'Deleted contacts';
export const DELETED_HEADERS = ['email', 'deleted_at'];
// Cells the panel shows (all of the tab's own columns but updated_at).
const FIELDS = ['email', ...PROFILE_FIELDS, 'contributions', 'contribution_count', 'first_contact', 'last_contact',
  'message_count', 'status', 'notes', 'profile_source', 'next_nudge', 'other_emails'];

const str = (v) => String(v ?? '').trim();
const refuse = (status, error) => ({ error, status });
const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const multiLine = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();

const LIMITS = { name: 120, organisation: 120, village: 60, role: 120, profile: 2000, notes: 5000 };
const MULTI = new Set(['profile', 'notes']);
const MAX_STATUS = 40;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// Every address a row stands for (email, then other_emails), lower-cased.
export function addressesOf(row) {
  const all = [row.email, ...(String(row.other_emails ?? '').match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || [])];
  return [...new Set(all.map((a) => str(a).toLowerCase()).filter((a) => a.includes('@')))];
}

export const isIgnore = (row) => str(row.status).toLowerCase() === 'ignore';

// Every contact but ignore rows, newest last contact first (then by name).
export function contactRows(table) {
  if (!table || table.error) return table;
  const rows = table.rows
    .filter((r) => str(r.email) && !isIgnore(r))
    .map((r) => Object.fromEntries([['_row', r._row], ...FIELDS.map((k) => [k, r[k] ?? ''])]))
    .sort((a, b) => str(b.last_contact).localeCompare(str(a.last_contact)) || str(a.name || a.email).localeCompare(str(b.name || b.email)));
  return { headers: table.headers, rows };
}

// One edit from the contact page -> { field, value, also } for checkedWrite, or { error, status }.
// row: the Contacts row (null if not found or not exactly one).
export function planContact({ field, value }, row) {
  if (!row) return refuse(404, 'No such contact: reload the page');
  if (isIgnore(row)) return refuse(409, 'This contact is marked ignore');
  const f = String(field || '');
  if (f === 'status') {
    const v = oneLine(value);
    const low = v.toLowerCase();
    if (v.length > MAX_STATUS) return refuse(400, `Status: up to ${MAX_STATUS} characters`);
    return { field: 'status', value: STATUSES.includes(low) || low === 'ignore' ? low : v, also: null };
  }
  if (f === 'next_nudge') {
    const v = oneLine(value).toLowerCase();
    if (v !== '' && v !== 'never' && !isDay(v)) return refuse(400, 'Next nudge: a date (YYYY-MM-DD), never, or blank');
    return { field: f, value: v, also: null };
  }
  if (!(f in LIMITS)) return refuse(400, `${f} can't be edited here`);
  const v = MULTI.has(f) ? multiLine(value) : oneLine(value);
  if (v.length > LIMITS[f]) return refuse(400, `${f}: up to ${LIMITS[f]} characters`);
  const also = PROFILE_FIELDS.includes(f) ? { profile_source: 'manual' } : null;
  return { field: f, value: v, also };
}

// Delete one contact: refused unless it is exactly one row and its status is still the one
// the page loaded (so a row changed in the Sheet meanwhile is never deleted unseen).
export function planDelete({ expected }, row) {
  if (!row) return refuse(404, 'No such contact: reload the page');
  if (isIgnore(row)) return refuse(409, 'This contact is marked ignore');
  if (String(row.status ?? '') !== String(expected ?? '')) {
    return { ...refuse(409, 'Changed in the Sheet since you loaded the page'), current: String(row.status ?? '') };
  }
  return { ok: true };
}
