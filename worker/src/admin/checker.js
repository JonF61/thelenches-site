// The Checker's findings (3 Nov; scripts/checker, checker.yml): a second Claude reads the next
// newsletter (Wednesday evening, or the draft bar's Check), the listings pages (weekly) and the
// whole site (monthly) and writes problems to the Checker tab. The panel lists the open ones on
// Summary and the Newsletter draft bar; Dismiss is one stale-checked write of the row's status
// (open -> dismissed), and dismissed findings are passed back to the next run so they are not
// raised again. Check now (newsletter, listings or site) sends repository_dispatch "checker".
// The panel never edits the content itself.

export const CHECKER_TAB = 'Checker';
export const CHECK_SCOPES = ['newsletter', 'listings', 'site'];
const SCOPE_ORDER = { newsletter: 0, listings: 1, site: 2 };

const s = (v) => String(v ?? '').trim();

// { open: [...], last: { scope: created_at of its latest run } }, newest run first within a scope.
export function checkerRows(table) {
  const rows = (table && table.rows) || [];
  const last = {};
  for (const r of rows) {
    const sc = s(r.scope);
    if (CHECK_SCOPES.includes(sc) && s(r.created_at) > (last[sc] || '')) last[sc] = s(r.created_at);
  }
  const open = rows.filter((r) => s(r.status) === 'open' && s(r.id))
    .map((r) => ({
      id: s(r.id), created_at: s(r.created_at), scope: s(r.scope), target: s(r.target), page: s(r.page), where: s(r.where),
      severity: s(r.severity) === 'problem' ? 'problem' : 'check', problem: s(r.problem), quote: s(r.quote), suggestion: s(r.suggestion),
    }))
    .sort((a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9)
      || (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1)
      || a.id.localeCompare(b.id));
  return { open, last };
}

// Dismiss: only an open finding, and only if it is still open in the Sheet.
export function planDismiss(row) {
  if (!row) return { error: 'No such finding: reload the page', status: 404 };
  if (s(row.status) !== 'open') return { error: `This finding is already ${s(row.status) || 'closed'}`, status: 409 };
  return { field: 'status', expected: 'open', value: 'dismissed' };
}
