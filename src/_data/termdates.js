// Upcoming school holidays from schools.json, worked out at build time.
// Drops breaks the schools are already back from; the nightly rebuild rolls it on.
const schools = require('./schools.json');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(dt, withYear) {
  const s = DAYS[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()];
  return withYear ? s + ' ' + dt.getUTCFullYear() : s;
}

module.exports = function () {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const list = [];
  for (const b of schools.terms.breaks) {
    const closes = parse(b.closes);
    const reopens = b.reopens ? parse(b.reopens) : null;
    if ((reopens || closes) < today) continue;
    const on = closes <= today && (!reopens || reopens > today);
    list.push({
      name: b.name,
      closes: fmt(closes, !reopens),
      reopens: reopens ? fmt(reopens, true) : null,
      on
    });
  }
  const shown = list.slice(0, 6);
  if (shown.length) shown[0].next = true;
  return shown;
};
