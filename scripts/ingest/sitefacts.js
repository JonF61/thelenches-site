// scripts/ingest/sitefacts.js
// What the website shows today, as compact facts with the page link for each: the only
// source replies.js lets Claude answer questions from (agreed 23 Oct). Read from the repo
// checkout (src/_data, src/items via lib/whatson.js, pipeline.json), so it is what is live
// now; Pending items are never included, so a reply can't say something is live before
// it is. urls is every link a draft may contain.
'use strict';

const fs = require('fs');
const path = require('path');
const { loadWhatson, ukToday } = require('../../lib/whatson');
const { anchorUrl } = require('../../lib/anchors');

const SITE = 'https://thelenches.org.uk';
const DATA = path.join(__dirname, '..', '..', 'src', '_data');
const EVENT_DAYS = 60;   // events this far ahead
const MAX_EVENTS = 40;
const MAX_NOTICES = 30;
const MAX_TEXT = 220;    // chars of each item's text

// Every page a reply may point to (titles and blurbs as on the hub cards).
const PAGES = [
  ['Home', '/', 'Front page, plus how to join the Thursday newsletter (email website@thelenches.org.uk and ask to be added).'],
  ['Events', '/events/', "What's on across the villages, week by week."],
  ['Notices', '/notices/', 'Parish council notices and news from around the villages.'],
  ['Roads', '/living-here/roads/', 'Road closures and roadworks, on now and coming up.'],
  ['Bins', '/bins/', 'Next collections and what goes where.'],
  ['Community', '/community/', 'Groups and clubs, village halls and churches.'],
  ['Groups & Clubs', '/groups/', 'Clubs, societies, the Pre-school and First School.'],
  ['Village Halls', '/halls/', 'Church Lench and Rous Lench halls, history and bookings.'],
  ['Churches', '/churches/', 'Service times and readings across the ARCH Benefice.'],
  ['Living here', '/living-here/', 'Health, transport, council, schools and walks.'],
  ['Health & emergencies', '/living-here/health/', 'GPs, pharmacies, hospitals and defibrillators.'],
  ['Getting around', '/living-here/getting-around/', 'Buses, on-demand and community transport, stations.'],
  ['Council & planning', '/living-here/council/', 'Parish councils, councillors and planning searches.'],
  ['Schools', '/living-here/schools/', 'Local schools, applying and term dates.'],
  ['Walks & footpaths', '/living-here/walks/', 'Circular walks, maps and the Countryside Code.'],
  ['Contact', '/contact/', 'How to send in events and news (submission guidelines), and how to get in touch.'],
  ['Privacy policy', '/privacy/', 'What we keep about subscribers and contributors.'],
];

const str = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const clip = (s) => (str(s).length > MAX_TEXT ? `${str(s).slice(0, MAX_TEXT)}…` : str(s));

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  } catch {
    return dflt;
  }
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// opts.today, opts.whatson, opts.pipeline: for tests.
function siteFacts(opts = {}) {
  const today = opts.today || ukToday();
  const until = addDays(today, EVENT_DAYS);
  const whatson = opts.whatson || loadWhatson({ today });
  const pipeline = opts.pipeline || readJson('pipeline.json', {});
  const urls = new Set(PAGES.map(([, u]) => `${SITE}${u}`));
  const use = (u) => { if (u) urls.add(u); return u; };

  const events = [...(whatson.events || []), ...(pipeline.events || [])]
    .filter((e) => e.title && e.date && (e.endDate || e.date) >= today && e.date <= until)
    .sort((a, b) => (a.date === b.date ? String(a.title).localeCompare(b.title) : (a.date < b.date ? -1 : 1)))
    .slice(0, MAX_EVENTS)
    .map((e) => ({
      date: e.date, ...(e.endDate ? { end_date: e.endDate } : {}), title: str(e.title), details: clip(e.body),
      url: use(anchorUrl('event', e) || `${SITE}/events/`),
    }));

  const notices = [...(pipeline.notices || []), ...(pipeline.news || []), ...(whatson.notices || [])]
    .filter((n) => n.title && (!n.expires || String(n.expires) >= today))
    .slice(0, MAX_NOTICES)
    .map((n) => ({ title: str(n.title), details: clip(n.body), url: use(anchorUrl('notice', n)) }));

  const b = opts.bins || readJson('bins.json', {});
  const bins = {
    areas: (b.areas || []).map((a) => `${a.name}: ${a.day}`),
    put_out_by: b.putOutBy || '',
    next: (b.collections || []).filter((c) => String(c.date) >= today).slice(0, 4),
    note: str(b.note),
    url: `${SITE}/bins/`,
  };

  const s = opts.services || readJson('services.json', {});
  const services = {
    sundays: (s.dates || []).filter((d) => String(d.date) >= today).slice(0, 2)
      .map((d) => ({ date: d.date, services: (d.services || []).map((x) => `${x.time} ${x.village}: ${x.service}`) })),
    midweek: str(s.midweek),
    url: `${SITE}/churches/`,
  };

  return {
    facts: {
      today,
      pages: PAGES.map(([title, u, about]) => ({ title, url: `${SITE}${u}`, about })),
      events,
      notices,
      bins,
      church_services: services,
    },
    urls,
  };
}

module.exports = { siteFacts, SITE };
