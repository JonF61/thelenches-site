// Works out each parish council's next meeting date at build time, from the
// rule in council.json (nth weekday of listed months). An optional
// "override" (YYYY-MM-DD) wins while it is today or later, for one-off moves.
// The nightly rebuild rolls the date over the day after each meeting.
const council = require('./council.json');

function londonToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function nthWeekday(year, month, weekday, nth) {
  // month 1-12, weekday 0=Sun..6=Sat, nth 1-5
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const d = new Date(Date.UTC(year, month - 1, 1 + offset + (nth - 1) * 7));
  return d.getUTCMonth() === month - 1 ? d : null;
}

function fromRule(rule, today) {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    for (const m of rule.months) {
      const d = nthWeekday(y, m, rule.weekday, rule.nth);
      if (d && iso(d) >= today) return d;
    }
  }
  return null;
}

function label(d) {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });
}

module.exports = function () {
  const today = londonToday();
  const out = {};
  for (const p of council.parishes || []) {
    let d = null;
    if (p.override && p.override >= today) d = new Date(p.override + 'T00:00:00Z');
    else if (p.rule) d = fromRule(p.rule, today);
    out[p.key] = d ? label(d) : '';
  }
  return out;
};
