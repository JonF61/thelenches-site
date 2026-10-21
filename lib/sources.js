// Local-news signposts (Evesham Journal RSS): shown as notices with a source tag,
// on the site (scripts/publish) and in the newsletter's Notices (scripts/newsletter/select.js).
// Other RSS feeds stay as they were (newsletter: Elsewhere).
'use strict';

const LOCAL_FEED = /evesham\s*journal|eveshamjournal\.co\.uk/i;
const LOCAL_NAME = 'Evesham Journal';

const str = (v) => String(v ?? '').trim();
const isRssRow = (row) => /^rss-/i.test(str(row && row.id)) || /^rss:/i.test(str(row && row.message_id));

// A Pending row's source name if it is a local-news signpost, else ''.
function localSource(row) {
  if (!isRssRow(row)) return '';
  if (!LOCAL_FEED.test(`${str(row.source)} ${str(row.from)} ${str(row.link_url)}`)) return '';
  return LOCAL_FEED.test(str(row.source)) ? str(row.source) : LOCAL_NAME;
}

module.exports = { LOCAL_FEED, isRssRow, localSource };
