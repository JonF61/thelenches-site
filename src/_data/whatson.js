// Hand-written events, notices, bin line and events footnote, assembled from src/items/
// (one file per item; see lib/whatson.js and CLAUDE.md). Expired items are left out.
const { loadWhatson } = require("../../lib/whatson.js");

module.exports = () => loadWhatson();
