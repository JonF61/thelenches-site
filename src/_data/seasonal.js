// Seasonal touches worked out at build time (UK date). The Worker's nightly rebuild (00:10 UK)
// switches them on and off on the right day.
// poppies: small poppies in the Home skyline (home-skyline.njk) each year from 24 October
// (around the start of the Poppy Appeal) to Armistice Day, 11 November; gone from the 12th.
const { ukToday } = require('../../lib/whatson.js');

module.exports = () => {
  const md = ukToday().slice(5); // "MM-DD"
  return { poppies: md >= '10-24' && md <= '11-11' };
};
