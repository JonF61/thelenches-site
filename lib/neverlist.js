// lib/neverlist.js: businesses never to be listed again (lib/neverlist.json; Jon, 25 Nov 2026).
// CommonJS so .eleventy.js and scripts can require() it; the Worker (esbuild) and ES modules import it too.
const LIST = require('./neverlist.json');

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const digits = (s) => String(s || '').replace(/\D+/g, '').replace(/^44/, '0').slice(-11);

// The never-list entry an item matches ({ name, phone, phone2, contact, other }), or null.
function blocked(item, list = LIST) {
  if (!item) return null;
  const name = norm(item.name);
  const phones = [item.phone, item.phone2, item.contact, item.other].map(digits).filter((d) => d.length >= 10);
  for (const e of (list && list.entries) || []) {
    if ((e.match || []).some((m) => norm(m).trim() && name.includes(norm(m).trimEnd()))) return e;
    if ((e.phones || []).some((p) => phones.includes(digits(p)))) return e;
  }
  return null;
}

// Every listed trade or eatery in a site's data that is on the never-list: ["trades: <name>", ...].
function listedProblems(trades, eat, list = LIST) {
  const out = [];
  for (const t of (trades && trades.trades) || []) if (blocked(t, list)) out.push(`trades: ${t.name}`);
  for (const p of (eat && eat.places) || []) if (blocked(p, list)) out.push(`eat: ${p.name}`);
  return out;
}

module.exports = { blocked, listedProblems, LIST };
