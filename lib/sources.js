// Local-news signposts (Evesham Journal RSS): shown as notices with a source tag,
// on the site (scripts/publish) and in the newsletter's Notices (scripts/newsletter/select.js).
// Other RSS feeds stay as they were (newsletter: Elsewhere).
// keepLocalStory() is the ingest filter (scripts/ingest/rss.js): a local-news story goes on to
// Claude and approval only if it names one of our villages or nearby places (PLACES), or is a
// county-wide story on a topic residents need to know about (TOPICS). "Evesham" alone is not enough.
'use strict';

const LOCAL_FEED = /evesham\s*journal|eveshamjournal\.co\.uk/i;
const LOCAL_NAME = 'Evesham Journal';

// The five Lenches, Harvington, Inkberrow, Abbots Morton, Lenchwick, Radford and Norton
// (not Chipping or Midsomer Norton).
const PLACES = new RegExp([
  /\b(?:church|rous|ab|atch|sheriff'?s)\s+lench\b/,
  /\blenches\b/,
  /\bharvington\b/,
  /\binkberrow\b/,
  /\babbots?\s+morton\b/,
  /\blenchwick\b/,
  /\bradford\b/,
  /(?<!chipping\s)(?<!midsomer\s)\bnorton\b/,
].map((r) => r.source).join('|'), 'i');

// County-wide topics: landline/digital phone switchover, scams and fraud, burglaries,
// flooding and flood warnings, power cuts.
const TOPICS = new RegExp([
  /\blandlines?\b/,
  /\bdigital\s+(?:phone|landline|voice|switch-?over)\b/,
  /\b(?:phone|telephone)\s+switch(?:-?over|-?off)\b/,
  /\bscam(?:s|mers?|med)?\b/,
  /\bfraud(?:s|sters?|ulent)?\b/,
  /\bburglar(?:y|ies|s)?\b|\bburgled\b/,
  /\bflood(?:s|ing|ed|\s+warnings?|\s+alerts?)?\b/,
  /\bpower\s+(?:cuts?|outages?)\b/,
].map((r) => r.source).join('|'), 'i');

const str = (v) => String(v ?? '').trim();
const isRssRow = (row) => /^rss-/i.test(str(row && row.id)) || /^rss:/i.test(str(row && row.message_id));

// A Pending row's source name if it is a local-news signpost, else ''.
function localSource(row) {
  if (!isRssRow(row)) return '';
  if (!LOCAL_FEED.test(`${str(row.source)} ${str(row.from)} ${str(row.link_url)}`)) return '';
  return LOCAL_FEED.test(str(row.source)) ? str(row.source) : LOCAL_NAME;
}

// A local-news feed item ({ title, text }) worth sending on: names a place we cover, or a topic.
function keepLocalStory(item) {
  const text = `${str(item && item.title)}\n${str(item && item.text)}`;
  return PLACES.test(text) || TOPICS.test(text);
}

module.exports = { LOCAL_FEED, PLACES, TOPICS, isRssRow, localSource, keepLocalStory };
