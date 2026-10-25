// worker/src/admin/sheet.js
// Sheet reads and plain field edits for the admin panel. Columns are found by header
// name only; rows by their id cell, never by position, so rows or columns moved in the
// Sheet can't make an edit land in the wrong place.
// Stale-write check: every edit carries the value the page loaded ("expected"). If the
// cell holds something else now, nothing is written and the current value comes back,
// so an edit made in the Sheet (or by a run) is never overwritten unseen.

import { getValues, writeCells } from './google.js';

export const TABLE_RANGE = 'A1:BZ';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const oneLine = (max) => (v) => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length <= max ? s : null;
};
const multiLine = (max) => (v) => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  return s.length <= max ? s : null;
};
const dateOrBlank = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || DATE.test(s) ? s : null;
};
const oneOf = (...allowed) => (v) => {
  const s = String(v ?? '').trim();
  return allowed.includes(s) ? s : null;
};
const required = (check) => (v) => {
  const s = check(v);
  return s ? s : null;
};

// Editable fields per tab: field -> cleaner (returns the value to write, or null = refuse).
// Pending: only while the row is still "pending" (decided rows belong to publish).
export const EDITS = {
  Pending: {
    key: 'id',
    onlyStatus: 'pending',
    fields: {
      title: required(oneLine(200)),
      summary: multiLine(3000),
      own_text: multiLine(3000),
      event_date: dateOrBlank,
      end_date: dateOrBlank,
      village: oneLine(60),
      category: oneOf('event', 'notice'),
      people_ok: oneOf('yes', ''),
    },
    guard: (...a) => officialGuard(...a),
  },
  // Diagnostic flag: the panel's "Clear" marks the latest run's problems as dealt with
  // (status CLEARED); the next daily run writes a new row as usual.
  Health: {
    key: 'date',
    fields: {
      status: oneOf('CLEARED'),
    },
  },
  Photos: {
    key: 'drive_id',
    fields: {
      target: oneLine(200),
      people_ok: oneOf('yes', ''),
      // Drafted by the photos run; alt text is kept once filled, the description is
      // redrafted only if the file is edited in Drive. Same limits as the run.
      alt_text: oneLine(125),
      description: oneLine(300),
    },
  },
};

// Settings keys the panel may change (the E:F key/value block, located by key).
export const SETTINGS_EDITS = {
  holiday_mode: oneOf('TRUE', 'FALSE'),
};

export function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const quoteTab = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

// Rows as objects keyed by header, each with _row (1-based Sheet row), as the scripts' readTable.
export function tableFrom(values) {
  const headers = (values[0] || []).map((h) => String(h).trim());
  const rows = values.slice(1).map((r, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, c) => { if (h) obj[h] = r[c] ?? ''; });
    return obj;
  });
  return { headers, rows };
}

export async function readTable(env, tab) {
  return tableFrom(await getValues(env, `${quoteTab(tab)}!${TABLE_RANGE}`));
}

// Settings E:F as [{ key, value, _row }].
export async function readSettingsPairs(env) {
  const values = await getValues(env, `${quoteTab('Settings')}!E1:F100`);
  return values.map((r, i) => ({ key: String(r[0] ?? '').trim(), value: String(r[1] ?? ''), _row: i + 1 }))
    .filter((p) => p._row > 1 && p.key);
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

// One plain field edit. Returns { ok: true, value } or { ok: false, status, error, current? }
// (status 409 with current = the stale-write refusal).
export async function editCell(env, { tab, key, field, expected, value }) {
  if (tab === 'Settings') {
    const clean = SETTINGS_EDITS[field];
    if (!clean) return fail(400, `${field} can't be changed here`);
    const v = clean(value);
    if (v === null) return fail(400, `Not a valid value for ${field}`);
    const pairs = (await readSettingsPairs(env)).filter((p) => p.key === field);
    if (pairs.length !== 1) return fail(404, `Settings has ${pairs.length} "${field}" rows (needs exactly one)`);
    const [pair] = pairs;
    if (pair.value !== String(expected ?? '')) {
      return fail(409, 'Changed in the Sheet since you loaded the page', { current: pair.value });
    }
    await writeCells(env, [{ range: `${quoteTab('Settings')}!F${pair._row}`, values: [[v]] }]);
    return { ok: true, value: v };
  }

  const spec = EDITS[tab];
  if (!spec) return fail(400, `${tab} can't be edited here`);
  const clean = spec.fields[field];
  if (!clean) return fail(400, `${field} can't be edited here`);
  const v = clean(value);
  if (v === null) return fail(400, `Not a valid value for ${field}`);

  return checkedWrite(env, {
    tab, keyCol: spec.key, key, field, expected, value: v, onlyStatus: spec.onlyStatus, guard: spec.guard,
  });
}

// Official statements are published in their own words: on an official Pending row the
// text fields take typo fixes only (a few words changed), checked here as well as in the page.
export const TYPO_FIELDS = new Set(['title', 'summary', 'own_text']);
const words = (s) => String(s || '').split(/\s+/).filter(Boolean);

// Words changed between a and b (deleted plus inserted), by longest common subsequence.
export function wordsChanged(a, b) {
  const x = words(a);
  const y = words(b);
  if (x.length * y.length > 400000) return Math.max(x.length, y.length);
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const common = prev[y.length];
  return (x.length - common) + (y.length - common);
}

// A typo fix: at most 3 words, or 5% of the words, swapped (each swap counts twice).
export const isTypoFix = (a, b) => wordsChanged(a, b) <= 2 * Math.max(3, Math.ceil(words(a).length * 0.05));

function officialGuard(row, field, current, value) {
  if (!TYPO_FIELDS.has(field) || !/^(true|yes|y|1)$/i.test(String(row.official ?? '').trim())) return '';
  return isTypoFix(current, value) ? '' : 'Official statement: only typo fixes are allowed, published in their own words';
}

// Writes one cell of the row whose keyCol cell is key, only if it still holds expected
// (and, with onlyStatus, only while the row's status is that). Value already cleaned.
// guard(row, field, current, value): returns a reason to refuse, or ''.
export async function checkedWrite(env, {
  tab, keyCol, key, field, expected, value, onlyStatus = '', guard = null,
}) {
  const { headers, rows } = await readTable(env, tab);
  const col = headers.indexOf(field);
  if (col < 0) return fail(400, `${tab} has no "${field}" column`);
  const matches = key ? rows.filter((r) => String(r[keyCol] ?? '') === String(key)) : [];
  if (matches.length !== 1) return fail(404, `${matches.length ? 'More than one' : 'No'} ${tab} row with ${keyCol} "${key}"`);
  const [row] = matches;
  if (onlyStatus && row.status !== onlyStatus) {
    return fail(409, `This item is already "${row.status}"`, { current: String(row[field] ?? ''), itemStatus: row.status });
  }
  const current = String(row[field] ?? '');
  if (current !== String(expected ?? '')) {
    return fail(409, 'Changed in the Sheet since you loaded the page', { current });
  }
  const refused = guard ? guard(row, field, current, value) : '';
  if (refused) return fail(400, refused);
  await writeCells(env, [{ range: `${quoteTab(tab)}!${colLetter(col)}${row._row}`, values: [[value]] }]);
  return { ok: true, value };
}
