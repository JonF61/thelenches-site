// scripts/ingest/sitefacts.js
// What the website shows today, as compact facts with the page link for each: the only
// source replies.js lets Claude answer questions from (agreed 23 Oct). Read from the repo
// checkout (src/_data, src/items via lib/whatson.js, pipeline.json), so it is what is live
// now; Pending items are never included, so a reply can't say something is live before
// it is. urls is every link a draft may contain.
// 23 Oct: also the "Living here" data, including what the build computes (next parish
// council meetings from meetings.js, school holidays from termdates.js), so a question
// like "when's the next South Lenches PC meeting?" is answered from the Council page.
// Outside links (NHS, bus and council sites) are left out: a reply links to our page.
'use strict';

const fs = require('fs');
const path = require('path');
const { loadWhatson, ukToday } = require('../../lib/whatson');
const { anchorUrl } = require('../../lib/anchors');
const meetings = require('../../src/_data/meetings');
const termdates = require('../../src/_data/termdates');

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
  ['Regular activities', '/regulars/', 'Weekly classes, clubs and groups, in day order, with who runs them and how to join in.'],
  ['Groups & Clubs', '/groups/', 'Clubs, societies, the Pre-school and First School.'],
  ['Village Halls', '/halls/', 'Church Lench and Rous Lench halls, history and bookings.'],
  ['Churches', '/churches/', 'Service times and readings across the ARCH Benefice.'],
  ['Living here', '/living-here/', 'Regular activities, groups, halls, churches, health, transport, council, schools and walks.'],
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

  const living = livingHere(opts);

  return {
    facts: {
      today,
      pages: PAGES.map(([title, u, about]) => ({ title, url: `${SITE}${u}`, about })),
      events,
      notices,
      bins,
      church_services: services,
      ...living,
    },
    urls,
  };
}

// Computed data files are functions; a failure leaves that part out rather than the lot.
function computed(fn, dflt) {
  try {
    return fn();
  } catch (err) {
    console.warn(`Site facts: computed data unavailable: ${(err && err.message) || err}`);
    return dflt;
  }
}

const NOT_WORKED_OUT = 'not worked out on the site: point them to the Council page, which links to the council\'s own meetings page';

// Council, schools, health, transport and walks pages. opts.council etc.: for tests.
function livingHere(opts) {
  const c = opts.council || readJson('council.json', {});
  const next = opts.meetings || computed(meetings, {});
  const council = {
    parishes: (c.parishes || []).map((p) => ({
      name: str(p.name), covers: str(p.covers), meets: str(p.meets),
      next_meeting: next[p.key] || NOT_WORKED_OUT,
      ...(p.clerk ? { clerk: str(p.clerk) } : {}), ...(p.phone ? { phone: str(p.phone) } : {}),
    })),
    councillors: (c.councillors || []).map((a) => `${a.area}: ${(a.people || []).map((x) => x.name).join(', ')}`),
    url: `${SITE}/living-here/council/`,
  };

  const s = opts.schools || readJson('schools.json', {});
  const schools = {
    local: (s.local || []).map((x) => ({ name: str(x.name), where: str(x.where), details: clip(x.text), ...(x.phone ? { phone: str(x.phone) } : {}) })),
    holidays: (opts.termdates || computed(termdates, [])).map((b) => ({
      name: b.name, closes: b.closes, ...(b.reopens ? { reopens: b.reopens } : {}), ...(b.on ? { on_now: true } : {}),
    })),
    holidays_note: str(s.terms && s.terms.note),
    url: `${SITE}/living-here/schools/`,
  };

  const h = opts.health || readJson('health.json', {});
  const places = (list) => (list || []).map((x) => [x.name, x.address, x.phone, x.hours].filter(Boolean).map(str).join(', '));
  const health = {
    numbers: (h.numbers || []).map((n) => `${n.label}: ${n.number}`),
    minor_injuries_and_ae: places(h.injuries),
    gps: places(h.gps && h.gps.items),
    pharmacies: places(h.pharmacies && h.pharmacies.items),
    defibrillators: ((h.defibs && h.defibs.villages) || []).map((v) => `${v.name}: ${(v.sites || []).map((x) => `${x.name} (${x.address})`).join('; ') || str(v.note) || 'none listed'}`),
    url: `${SITE}/living-here/health/`,
  };

  const t = opts.transport || readJson('transport.json', {});
  const transport = {
    buses: ((t.buses && t.buses.items) || []).map((b) => [b.name, b.route, b.days, b.stops && `Stops: ${b.stops}`].filter(Boolean).map(str).join(' ')),
    buses_note: clip(t.buses && t.buses.note),
    on_demand: t.ondemand ? `${str(t.ondemand.name)}: ${str(t.ondemand.text)}${t.ondemand.phone ? ` Phone ${t.ondemand.phone}.` : ''}` : '',
    community_transport: places(t.community && t.community.items),
    stations: places(t.trains && t.trains.items),
    url: `${SITE}/living-here/getting-around/`,
  };

  const w = opts.walks || readJson('walks.json', {});
  const walks = {
    walks: (w.walks || []).map((x) => [x.name, x.start && `from ${x.start}`, ...(x.tags || [])].filter(Boolean).map(str).join(', ')),
    url: `${SITE}/living-here/walks/`,
  };

  return { council, schools, health, transport, walks };
}

module.exports = { siteFacts, SITE };
