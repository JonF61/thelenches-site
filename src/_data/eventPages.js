// Events with their own page (SEO step 1, 26 Nov 2026; lib/eventpage.js): every hand-written event
// (this site's and shared ones) and published pipeline event that is upcoming or ended within the
// last 30 days. Empty unless site.json has "eventPages": true, so other sites build as before.
const { siteConfig, siteData } = require("../../lib/site.js");
const { loadWhatson, ukToday } = require("../../lib/whatson.js");
const { pageEvents } = require("../../lib/eventpage.js");

module.exports = () => {
  if (siteConfig().eventPages !== true) return [];
  const pipeline = siteData("pipeline", {});
  return pageEvents([...loadWhatson({ all: true }).events, ...((pipeline && pipeline.events) || [])], ukToday());
};
