// Seasonal touches in the Home page skyline (home-skyline.njk), worked out at build time from the
// UK date. The Worker's nightly rebuild (00:10 UK) switches them on and off on the right day.
//   poppies    24 Oct to 11 Nov (Poppy Appeal to Armistice Day), except 31 Oct
//   halloween  31 Oct: pumpkins and bats
//   harvest    15 Sep to 7 Oct: apples on the trees, wheat sheaves
//   christmas  1 Dec to 6 Jan (Twelfth Night): snow and a star; santa on 24 Dec as well
//   easter     Palm Sunday to Easter Monday: daffodils
//   blossom    15 Mar to 30 Apr, but not during Easter
//   stgeorge   23 Apr: a flag of St George on the church tower (needs the taller sky)
const { ukToday } = require('../../lib/whatson.js');

// Easter Sunday for a year (Gregorian; anonymous algorithm), as "YYYY-MM-DD".
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const shift = (iso, days) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function seasonsFor(today) {
  const md = today.slice(5);
  const easter = easterSunday(+today.slice(0, 4));
  const isEaster = today >= shift(easter, -7) && today <= shift(easter, 1);
  const halloween = md === '10-31';
  const s = {
    poppies: md >= '10-24' && md <= '11-11' && !halloween,
    halloween,
    harvest: md >= '09-15' && md <= '10-07',
    christmas: md >= '12-01' || md <= '01-06',
    santa: md === '12-24',
    easter: isEaster,
    blossom: md >= '03-15' && md <= '04-30' && !isEaster,
    stgeorge: md === '04-23',
  };
  s.tallSky = s.stgeorge;
  return s;
}

module.exports = () => seasonsFor(ukToday());
module.exports.seasonsFor = seasonsFor;
module.exports.easterSunday = easterSunday;
