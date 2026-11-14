// This month's sponsor (UK calendar month at build time), or null: only an entry in
// sponsors.json that Jon has approved and that is paid. The nightly rebuild moves it on.
const sponsors = require('./sponsors.json');

function ukMonth(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

function sponsorFor(month, data = sponsors) {
  const s = (data.months || {})[month];
  if (!s || s.approved !== true || s.paid !== true || !s.name) return null;
  return { name: s.name, line: s.line || '', url: s.url || '', logo: s.logo || '' };
}

module.exports = () => sponsorFor(ukMonth());
module.exports.sponsorFor = sponsorFor;
module.exports.ukMonth = ukMonth;
