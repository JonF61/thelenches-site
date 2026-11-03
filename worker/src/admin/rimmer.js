// Rimmer's findings (3 Nov; scripts/rimmer, rimmer.yml): a second Claude, Rimmer (he), reads the
// next newsletter (Wednesday evening, or the draft screen's Check), the listings pages (weekly)
// and the whole site (monthly) and writes problems to the Rimmer tab. The panel lists the open
// ones on Summary, the Newsletter draft screen and Health, each with:
//   Fix…            Jon's optional instruction saved in fix_note, fix_status -> asked, then
//                   decide() rfix: Holly proposes one change (scripts/rimmer/fix.js)
//   Apply           a proposed fix: fix_status -> applying, then decide() rfix_ok writes it
//   Discard         a proposal Jon doesn't want: fix_status -> discarded
//   Send to Kryten  status -> kryten (with Jon's note): Kryten picks these up each session
//   Dismiss         status -> dismissed; dismissed findings are passed back to the next run
// Each is one stale-checked write; Check now sends repository_dispatch "rimmer".

export const RIMMER_TAB = 'Rimmer';
export const CHECK_SCOPES = ['newsletter', 'listings', 'site'];
const SCOPE_ORDER = { newsletter: 0, listings: 1, site: 2 };
const FIX_FIELDS = ['fix_status', 'fix_note', 'fix_label', 'fix_field', 'fix_old', 'fix_new', 'fix_reason'];

const s = (v) => String(v ?? '').trim();
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function finding(r) {
  const f = {
    id: s(r.id), created_at: s(r.created_at), scope: s(r.scope), target: s(r.target), page: s(r.page), where: s(r.where),
    severity: s(r.severity) === 'problem' ? 'problem' : 'check', problem: s(r.problem), quote: s(r.quote), suggestion: s(r.suggestion),
  };
  for (const k of FIX_FIELDS) f[k] = String(r[k] ?? '');
  return f;
}

// { open, kryten, last }: open findings (newsletter first, problems before checks), those sent to
// Kryten (newest first, up to 20) and each scope's latest run.
export function rimmerRows(table) {
  const rows = (table && table.rows) || [];
  const last = {};
  for (const r of rows) {
    const sc = s(r.scope);
    if (CHECK_SCOPES.includes(sc) && s(r.created_at) > (last[sc] || '')) last[sc] = s(r.created_at);
  }
  const open = rows.filter((r) => s(r.status) === 'open' && s(r.id)).map(finding)
    .sort((a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9)
      || (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1)
      || a.id.localeCompare(b.id));
  const kryten = rows.filter((r) => s(r.status) === 'kryten' && s(r.id)).map(finding)
    .sort((a, b) => b.id.localeCompare(a.id)).slice(0, 20);
  return { open, kryten, last };
}

const notFound = { error: 'No such finding: reload the page', status: 404 };
const closed = (row) => ({ error: `This finding is already ${s(row.status) || 'closed'}`, status: 409 });

// Dismiss: only an open finding, and only if it is still open in the Sheet.
export function planDismiss(row) {
  if (!row) return notFound;
  if (s(row.status) !== 'open') return closed(row);
  return { field: 'status', expected: 'open', value: 'dismissed' };
}

// Send to Kryten: an open finding with no fix on the way; Jon's note (optional) goes with it.
export function planKryten(row, note) {
  if (!row) return notFound;
  if (s(row.status) !== 'open') return closed(row);
  if (['asked', 'applying'].includes(s(row.fix_status))) return { error: 'Holly is still working on this one: wait a minute', status: 409 };
  return { field: 'status', expected: 'open', value: 'kryten', also: { fix_note: clean(note, 600) } };
}

// Fix… / Apply / Discard on one open finding. expected = the fix_status the panel showed.
//   propose: fix_status '', cannot, failed, discarded or proposed -> asked (+ Jon's note); then decide() rfix
//   apply:   proposed -> applying; then decide() rfix_ok
//   discard: proposed, cannot or failed -> discarded
export function planFix(row, { op, note, expected }) {
  if (!row) return notFound;
  if (s(row.status) !== 'open') return closed(row);
  const now = s(row.fix_status);
  if (now !== s(expected)) return { error: 'Changed since you loaded the page: reload', status: 409, current: now };
  if (op === 'propose') {
    if (['asked', 'applying'].includes(now)) return { error: 'Holly is already working on this one', status: 409 };
    return { field: 'fix_status', expected: now, value: 'asked', also: { fix_note: clean(note, 600) }, action: 'rfix' };
  }
  if (op === 'apply') {
    if (now !== 'proposed') return { error: 'There is no proposed fix to apply', status: 409 };
    return { field: 'fix_status', expected: now, value: 'applying', action: 'rfix_ok' };
  }
  if (op === 'discard') {
    if (!['proposed', 'cannot', 'failed'].includes(now)) return { error: 'Nothing to discard', status: 409 };
    return { field: 'fix_status', expected: now, value: 'discarded' };
  }
  return { error: `Unknown operation "${op}"`, status: 400 };
}
