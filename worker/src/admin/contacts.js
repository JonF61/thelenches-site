// worker/src/admin/contacts.js
// The panel's Contacts screen (Contacts tab, filled daily by scripts/contacts). A list to
// search and filter, and a page per contact with its profile fields, notes and status
// editable. Each save is one stale-checked cell write (sheet.js checkedWrite), found by
// the email cell; nothing here sends mail or touches the approval path.
//   Profile fields (name, organisation, village, role, profile): saving one also sets
//   profile_source to "manual", in the same write, so the daily run stops rewriting them.
//   notes: Jon's own; code never writes it.
//   status: "auto" (blank, the run sets contributor / lead / dormant), "ignore" (the next
//   run clears the row to email and status) or a value of Jon's own that the run keeps.
//   contributor, lead and dormant can't be set by hand: the run would change them back.
// Ignore rows never leave the server (nothing of them is shown; scripts/contacts clears them).

export const CONTACTS_TAB = 'Contacts';
export const PROFILE_FIELDS = ['name', 'organisation', 'village', 'role', 'profile'];
export const AUTO_STATUSES = ['contributor', 'lead', 'dormant'];
// Cells the panel shows (all of the tab's own columns but updated_at).
const FIELDS = ['email', ...PROFILE_FIELDS, 'contributions', 'contribution_count', 'first_contact', 'last_contact',
  'message_count', 'status', 'notes', 'profile_source'];

const str = (v) => String(v ?? '').trim();
const refuse = (status, error) => ({ error, status });
const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const multiLine = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();

const LIMITS = { name: 120, organisation: 120, village: 60, role: 120, profile: 2000, notes: 5000 };
const MULTI = new Set(['profile', 'notes']);
const MAX_STATUS = 40;

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
    const s = oneLine(value);
    const low = s.toLowerCase();
    if (low === '' || low === 'auto') {
      // Already automatic: nothing to write (the run keeps it up to date).
      return { field: 'status', value: AUTO_STATUSES.includes(str(row.status).toLowerCase()) ? null : '', also: null };
    }
    if (AUTO_STATUSES.includes(low)) return refuse(400, `"${low}" is set by the daily run: choose Automatic`);
    if (low === 'ignore') return { field: 'status', value: 'ignore', also: null };
    if (s.length > MAX_STATUS) return refuse(400, `Status: up to ${MAX_STATUS} characters`);
    return { field: 'status', value: s, also: null };
  }
  if (!(f in LIMITS)) return refuse(400, `${f} can't be edited here`);
  const v = MULTI.has(f) ? multiLine(value) : oneLine(value);
  if (v.length > LIMITS[f]) return refuse(400, `${f}: up to ${LIMITS[f]} characters`);
  const also = PROFILE_FIELDS.includes(f) ? { profile_source: 'manual' } : null;
  return { field: f, value: v, also };
}
