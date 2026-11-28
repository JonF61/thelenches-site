// Offline tests for the planning feed (25 Nov 2026): lib/planning.js parsing, scripts/planning's
// apply(), and the newsletter's "Planning this week" section for both sites. Synthetic lists only
// (the real PDFs name applicants and officers, so they are never committed).
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../lib/planning');

const ok = (name) => console.log(`ok - ${name}`);

const PAGE = `
<a href="/component/fileman/?view=file&amp;routed=1&amp;itemless=1&amp;name=Planning%20Applications%2016%20-%2020%20November%202026.pdf&amp;folder=Documents/Planning/WeeklyLists/2026/November&amp;container=fileman-files">A</a>
<a href="/component/fileman/?view=file&amp;routed=1&amp;itemless=1&amp;name=Planning%20Applications%2009-13%20November.pdf&amp;folder=Documents/Planning/WeeklyLists/2026/November/161126&amp;container=fileman-files">A2</a>
<a href="/component/fileman/?view=file&amp;routed=1&amp;itemless=1&amp;name=Planning%20Appeals%20Received%2009-13%20November.pdf&amp;folder=x&amp;container=fileman-files">B</a>
<a href="/component/fileman/?view=file&amp;routed=1&amp;itemless=1&amp;name=Enforcement%20Appeals%2016%20-%2020%20November%202026.pdf&amp;folder=x&amp;container=fileman-files">E</a>
<a href="/component/fileman/?view=file&amp;routed=1&amp;itemless=1&amp;name=Decisions%20Made%2016%20-%2020%20November%202026.pdf&amp;folder=Documents/Planning/WeeklyLists/2026/November&amp;container=fileman-files">C</a>
<a href="/component/fileman/?view=file&amp;routed=1&amp;itemless=1&amp;name=Tree%20Works%2016%20-%2020%20November%202026.pdf&amp;folder=x&amp;container=fileman-files">T</a>`;

const APPS = `PLANNING APPLICATIONS REGISTERED
Weekly list for 16/11/2026 to 20/11/2026
Listed by Ward, then Parish, then Application Number order

Application Number:          W/26/02669/PIP
Location:                    Land At Os 0208 4905, Sheriffs Lench
Proposal:                    Permission in principle for minimum of 1 and maximum of 1 dwelling
Date Valid:                  17/11/2026
Applicant:                   Mr Test Applicant
Expected Decision Level:     Delegated
Agents Name:                 Ms Test Agent
Application Type:            Permission in Principle
Ward(s):                     Inkberrow Ward
Parish(es):                  South Lenches
Case Officer:                Test Officer
Telephone Number:            01386 000000
Email:                       test.officer@example.gov.uk
Online Register:             View Planning Application: W/26/02669/PIP

Page 1 of 3                                                      Doc Ref: Weekly List of Planning Applications
\fApplication Number:        W/26/00001/HP
Location:                  Manor Farm House, Abbots Lench Lane, Abbots Lench, Church Lench, Evesham,
                           WR11 4UP
Proposal:                  Application for a certificate of proposed lawful use/development for demolition of
                           existing conservatory and erection of single-storey rear extension with flat roof
                           extending beyond original rear wall.
Date Valid:                18/11/2026
Applicant:                 Mrs Someone
Application Type:          Householder Planning
Parish(es):                South Lenches
Online Register:           View Planning Application: W/26/00001/HP

\fApplication Number:        W/26/00002/FUL
Location:                  1 High Street, Harvington, EVESHAM, WR11 8NE
Proposal:                  New shed
Date Valid:                19/11/2026
Application Type:          Full planning permission
Parish(es):                Harvington
Online Register:           View Planning Application: W/26/00002/FUL

\fApplication Number:        W/26/00003/FUL
Location:                  2 Somewhere, Bredon's Norton
Proposal:                  Elsewhere
Date Valid:                19/11/2026
Application Type:          Full planning permission
Parish(es):                Bredon's Norton
`;

const DECS = `LIST OF DECISIONS MADE
Weekly list for 16/11/2026 to 20/11/2026

Application Number:   W/26/02479/CAN
Location:             Bank House, Stratford Road, Harvington, WR11 8NP
Proposal:             T1 Thuja - reduce height
Desicion Date:        17/11/2026
Decision:             No Objection
Applicant:            Mr Tree
Applicant Address:    1 Tree Road
                      Worcester
Parish(es):           Harvington

Application Number:   W/26/00010/HP
Location:             3 Low Road, Church Lench, WR11 4UH
Proposal:             Single storey extension.
Desicion Date:        16/11/2026
Decision:             Approval
Applicant:            Mr Private Person
Applicant Address:    9 Private Lane
                      Evesham
                      WR11 1AA
Agent Name:           Ms Agent
Agent Address:        26 Agent Grove
                      Worcester
Parish(es):           South Lenches
Case Officer:         Officer Name
Email:                officer@example.gov.uk
`;

const APPEALS = `Planning Appeals Received
Weekly List from 16/11/2026 to 20/11/2026


DETR/Appeal Reference:   6019583
Application Number:      W/26/00662/PIP
Location:                74 Lenchwick Lane
                         Lenchwick
                         Evesham
                         WR11 4TG
Proposal:                Permission in Principle for 1 no. dwelling
Appeal Start Date:       18/11/26
Appeal Method:           Written Procedure
Parish:                  Norton and Lenchwick
Ward:                    Harvington & Norton Ward
Online Register:         View Planning Application: W/26/00662/PIP

Total Number of Appeals = 1
`;

// ---- Links
{
  const l = P.newestLinks(PAGE, P.LIST_PAGE);
  assert.strictEqual(l.applications.name, 'Planning Applications 16 - 20 November 2026.pdf');
  assert.strictEqual(l.decisions.name, 'Decisions Made 16 - 20 November 2026.pdf');
  assert.strictEqual(l.appeals.name, 'Planning Appeals Received 09-13 November.pdf');
  assert.ok(l.applications.url.startsWith('https://www.wychavon.gov.uk/component/fileman/'));
  assert.ok(l.applications.url.includes('folder=Documents%2FPlanning') || l.applications.url.includes('folder=Documents/Planning'));
  assert.strictEqual(P.pdfLinks(PAGE).length, 4, 'enforcement appeals and tree works ignored');
  ok('newest link of each kind, odd names, others ignored');
}

// ---- Parsing
{
  assert.deepStrictEqual(P.weekOf(APPS), { from: '2026-11-16', to: '2026-11-20' });
  assert.deepStrictEqual(P.weekOf(APPEALS), { from: '2026-11-16', to: '2026-11-20' });
  const apps = P.parseList(APPS, 'applications');
  assert.strictEqual(apps.length, 4);
  assert.deepStrictEqual(apps[0], {
    ref: 'W/26/02669/PIP', location: 'Land at OS 0208 4905, Sheriffs Lench',
    proposal: 'Permission in principle for minimum of 1 and maximum of 1 dwelling', type: 'Permission in Principle',
    date: '2026-11-17', parish: 'South Lenches', link: 'https://plan.wychavon.gov.uk/Planning/Display/W/26/02669/PIP',
  });
  assert.strictEqual(apps[1].location, 'Manor Farm House, Abbots Lench Lane, Abbots Lench, Church Lench');
  assert.ok(apps[1].proposal.endsWith('original rear wall.'), 'continuation lines joined');
  assert.strictEqual(apps[2].location, '1 High Street, Harvington');
  const decs = P.parseList(DECS, 'decisions');
  assert.strictEqual(decs.length, 1, 'tree works (CAN) left out');
  assert.deepStrictEqual(Object.keys(decs[0]).sort(), ['date', 'decision', 'link', 'location', 'parish', 'proposal', 'ref', 'type']);
  assert.strictEqual(decs[0].decision, 'Approval');
  assert.strictEqual(decs[0].date, '2026-11-16');
  assert.strictEqual(decs[0].type, 'Householder');
  const json = JSON.stringify([apps, decs]);
  for (const secret of ['Test Applicant', 'Test Agent', 'Officer', 'officer', 'Private', 'Agent Grove', '01386', '1AA']) {
    assert.ok(!json.includes(secret), `never keeps "${secret}"`);
  }
  const ap = P.parseList(APPEALS, 'appeals');
  assert.strictEqual(ap.length, 1);
  assert.strictEqual(ap[0].location, '74 Lenchwick Lane, Lenchwick');
  assert.strictEqual(ap[0].date, '2026-11-18');
  assert.strictEqual(ap[0].parish, 'Norton and Lenchwick');
  assert.strictEqual(P.entryCount(APPS), 4);
  assert.ok(P.isTreeWork('W/26/1/TPOA') && P.isTreeWork('W/26/1/CAN') && !P.isTreeWork('W/26/1/HED'));
  ok('entries parsed, kept fields only, tree works out');

  assert.deepStrictEqual(P.forParishes(apps, ['South Lenches', 'Rous Lench']).map((e) => e.ref), ['W/26/02669/PIP', 'W/26/00001/HP']);
  assert.deepStrictEqual(P.forParishes(apps, ['Harvington', 'Norton and Lenchwick']).map((e) => e.ref), ['W/26/00002/FUL'], 'exact parish names (not Bredon\'s Norton)');
  const short = P.shortProposal(apps[1].proposal);
  assert.ok(short.length <= 121 && short.endsWith('…'));
  assert.strictEqual(P.shortProposal('New shed.'), 'New shed');
  ok('parishes matched exactly; proposals shortened with …');
}

// ---- Map links
{
  const pt = P.gridPoint('Land at OS 0208 4905, Sheriffs Lench');
  assert.ok(Math.abs(pt.lat - 52.1398) < 0.002 && Math.abs(pt.lon - -1.9710) < 0.002, 'SP grid ref near Sheriffs Lench');
  const so = P.gridPoint('Land At (OS 9764 4714), Church Lane, Lower Moor');
  assert.ok(Math.abs(so.lat - 52.1226) < 0.002 && Math.abs(so.lon - -2.0358) < 0.002, 'SO grid ref near Lower Moor');
  assert.strictEqual(P.gridPoint('Brock House, Low Road, Church Lench'), null);
  assert.strictEqual(P.mapUrl('Brock House, Low Road, Church Lench'), 'https://www.google.com/maps/search/?api=1&query=Brock%20House%2C%20Low%20Road%2C%20Church%20Lench%2C%20Worcestershire');
  assert.ok(P.mapUrl('Land at OS 0208 4905, Sheriffs Lench').endsWith('query=52.13979%2C-1.97095'));
  ok('map links: addresses searched, grid references pinned');
}

// ---- New homes, open applications (25 Nov 2026)
{
  const cases = [
    ['Permission in Principle for minimum of 3 dwellings and maximum 5 dwellings.', 'W/26/1/PIP', 5, 'Up to 5 new homes'],
    ['Permission in principle for minimum of 1 and maximum of 1 dwelling', 'W/26/1/PIP', 1, '1 new home'],
    ['Notification for Prior Approval for the change of use of an Agricultural Building to 2 Dwellinghouses (Class C3)', 'W/26/1/GPDQ', 2, '2 new homes'],
    ['Erection of a 5no. holiday cabins together with ancillary works.', 'W/26/1/FUL', 0, ''],
    ['Conversion of existing outbuildings into a family annexe', 'W/26/1/FUL', 0, ''],
    ['Two storey side and rear extensions to dwelling', 'W/26/1/HP', 0, ''],
    ['Outline application for up to 30 dwellings with access', 'W/26/1/OUT', 30, 'Up to 30 new homes'],
    ['Proposed rural workers dwelling', 'W/26/1/FUL', 1, '1 new home'],
  ];
  for (const [prop, ref, n, label] of cases) {
    assert.strictEqual(P.homesIn(prop, ref), n, prop);
    assert.strictEqual(P.homesLabel(prop, n), label, prop);
  }
  ok('new homes counted from the wording; extensions, annexes and holiday lets left out');

  const page = (decision, date) => `<html><body><h2>Planning Online Status</h2><div>Application</div><div>Valid</div><div>27/07/2026</div>
    <div>Consultation</div><div>End</div><div>17/12/2026</div><div>Committee</div><div>Meeting</div><div>N/A</div>
    <div>Decision</div><div>${decision}</div><div>Decision</div><div>Date</div><div>${date}</div>
    <div>Appeal</div><div>Started</div><div>N/A</div><div>Appeal</div><div>Decision</div><div>N/A</div>
    <h3>Summary</h3><dt>Application Number</dt><dd>W/26/00197/FUL</dd><dt>Location Address</dt><dd>Hill Barn Orchard</dd><dd>Church Lench</dd><dd>Evesham</dd><dd>WR11 4UB</dd>
    <dt>Proposal</dt><dd>Erection of 2 dwellings.</dd><dt>Status</dt><dd>${decision}</dd><dt>Application Type</dt><dd>Full planning permission</dd>
    <dt>Case Officer</dt><dd>Officer Person</dd><dt>Parish</dt><dd>South Lenches</dd><dt>Applicant</dt><dd>Mr Private</dd><dt>Agent Address</dt><dd>1 Agent St</dd></body></html>`;
  const d = P.parseDisplay(page('Pending', 'N/A'));
  assert.deepStrictEqual(d, { valid: '2026-07-27', consultationEnd: '2026-12-17', committee: '', decision: 'Pending', decisionDate: '',
    appealStarted: '', appealDecision: '', status: 'Pending', location: 'Hill Barn Orchard, Church Lench', proposal: 'Erection of 2 dwellings.',
    type: 'Full planning permission', parish: 'South Lenches', postcode: 'WR11 4UB' });
  assert.ok(P.isOpen(d));
  assert.ok(!P.isOpen(P.parseDisplay(page('Approval', '04/11/2026'))));
  assert.strictEqual(P.parseDisplay('<html>Not found</html>'), null);
  const st = P.openStatus({ valid: '2026-07-27', consultationEnd: '2026-12-17' }, '2026-11-25').map((x) => x.text);
  assert.deepStrictEqual(st, ['Valid 27 Jul', 'Comments until 17 Dec', 'waiting 3 months']);
  const old = P.openStatus({ valid: '2024-04-29', consultationEnd: '2025-07-03', committee: '2025-09-18' }, '2026-11-25').map((x) => x.text);
  assert.deepStrictEqual(old, ['Valid 29 Apr 2024', 'comments closed 3 Jul 2025', 'went to planning committee 18 Sep 2025', 'waiting 2 years: check Wychavon for the latest']);
  ok('application pages read for stage only; stage lines');

  // Comments close soon (28 Nov 2026): undecided, comments open, ending within 10 days, soonest first.
  const opens = [
    { ref: 'A', consultationEnd: '2026-12-07', homes: 0 }, { ref: 'B', consultationEnd: '2026-11-30', homes: 5 },
    { ref: 'C', consultationEnd: '2026-11-27' }, { ref: 'D', consultationEnd: '2026-12-20' },
    { ref: 'E', consultationEnd: '2026-12-01', decisionDate: '2026-11-26' }, { ref: 'F', consultationEnd: '2026-12-01', appealStarted: '2026-11-01' },
    { ref: 'G', consultationEnd: '2026-11-28' },
  ];
  const cs = P.closingSoon(opens, '2026-11-28');
  assert.deepStrictEqual(cs.map((e) => [e.ref, e.daysLeft]), [['G', 0], ['B', 2], ['A', 9]]);
  assert.deepStrictEqual(P.commentCounts(opens, '2026-11-28'), { comments: 4, withHomes: 1, closing: 3 });
  assert.deepStrictEqual([0, 1, 4].map(P.daysLeftText), ['closes today', 'closes tomorrow', '4 days left']);
  ok('comments close soon and the Home counts');
  const ct = P.atCommittee([{ ref: 'A', committee: '2026-12-10' }, { ref: 'B', committee: '2026-11-27' }, { ref: 'C', committee: '2026-12-30' },
    { ref: 'D', committee: '2026-12-03', decisionDate: '2026-12-03' }, { ref: 'E', committee: '2026-11-28' }], '2026-11-28');
  assert.deepStrictEqual(ct.map((e) => e.ref), ['E', 'A']);
  ok('going to planning committee: the next 21 days, undecided');

  const { refreshOpen } = require('./planning/index.js');
  const data = { weeks: [{ from: '2026-11-16', applications: [{ ref: 'W/26/00197/FUL', location: 'x', proposal: 'y', link: P.DISPLAY + 'W/26/00197/FUL', date: '2026-11-17' },
    { ref: 'W/26/00002/HP', location: 'a', proposal: 'b', link: P.DISPLAY + 'W/26/00002/HP' }], decisions: [{ ref: 'W/26/00002/HP' }] }],
    open: [{ ref: 'W/26/00009/FUL', location: 'old', proposal: 'p', link: P.DISPLAY + 'W/26/00009/FUL' }] };
  const disp = async (u) => (u.endsWith('00009/FUL') ? page('Refusal', '01/11/2026') : page('Pending', 'N/A'));
  refreshOpen(data, { parishes: ['South Lenches'], wait: 0, today: '2026-11-20', getDisplay: disp }).then((kept) => {
    const k = kept.open.find((e) => e.ref === 'W/26/00009/FUL');
    assert.ok(k && k.decision === 'Refusal' && k.decisionDate === '2026-11-01', 'decided within 4 weeks: kept with its outcome');
    return refreshOpen(data, { parishes: ['South Lenches'], wait: 0, today: '2026-12-15', getDisplay: disp });
  }).then((r) => {
    assert.deepStrictEqual(r.open.map((e) => e.ref), ['W/26/00197/FUL'], 'decided over 4 weeks ago dropped; one decided in a list never added');
    assert.strictEqual(r.open[0].homes, 2);
    assert.strictEqual(r.open[0].homesLabel, '2 new homes');
    const json = JSON.stringify(r.open);
    for (const secret of ['Officer', 'Private', 'Agent']) assert.ok(!json.includes(secret), `never keeps "${secret}"`);
    ok('refreshOpen() keeps undecided ones with their stage and drops decided ones');
  }).catch((e) => { console.error(e); process.exit(1); });
}

// ---- Weeks
{
  let d = null;
  for (let i = 0; i < 10; i += 1) {
    const from = P.addDays('2026-09-14', i * 7);
    d = P.addList(d, { from, to: P.addDays(from, 4) }, 'applications', [{ ref: `W/26/0000${i}/HP` }]);
  }
  assert.strictEqual(d.weeks.length, 8, 'keeps 8 weeks');
  assert.strictEqual(d.weeks[0].from, '2026-11-16', 'newest first');
  assert.ok(P.hasList(d, { from: '2026-11-16' }, 'applications'));
  assert.ok(!P.hasList(d, { from: '2026-11-16' }, 'decisions'));
  // The 26 Nov issue shows 16-20 Nov; the 3 Dec issue (no newer list) shows nothing.
  assert.strictEqual(P.weekForIssue(d, '2026-11-26').from, '2026-11-16');
  assert.strictEqual(P.weekForIssue(d, '2026-12-03'), null);
  assert.strictEqual(P.weekForIssue(d, '2026-11-26').lists.decisions, undefined);
  ok('8 weeks kept, one issue per week');
}

// ---- apply(): skips stored lists, writes both sites' parishes
{
  const { apply } = require('./planning/index.js');
  const lists = [
    { kind: 'applications', week: P.weekOf(APPS), entries: P.parseList(APPS, 'applications') },
    { kind: 'decisions', week: P.weekOf(DECS), entries: P.parseList(DECS, 'decisions') },
    { kind: 'appeals', week: P.weekOf(APPEALS), entries: P.parseList(APPEALS, 'appeals') },
  ];
  const store = {};
  const io = { read: (s) => store[s] || null, write: (s, data) => { store[s] = data; }, today: '2026-11-25' };
  const r1 = apply({ lists, problems: [] }, io);
  assert.deepStrictEqual(r1.changed, ['lenches', 'harvington']);
  assert.strictEqual(store.lenches.weeks[0].applications.length, 2);
  assert.strictEqual(store.lenches.weeks[0].decisions.length, 1);
  assert.strictEqual(store.harvington.weeks[0].appeals.length, 1);
  assert.deepStrictEqual(store.harvington.weeks[0].lists, { applications: true, decisions: true, appeals: true });
  const r2 = apply({ lists, problems: [] }, io);
  assert.deepStrictEqual(r2.changed, [], 'no new list: nothing written');
  const r3 = apply({ lists, problems: ['parser found no entries in the non-empty decisions list "x"'] }, io);
  assert.deepStrictEqual(r3.changed, ['lenches', 'harvington'], 'a new problem is written for the diagnostic');
  assert.strictEqual(store.lenches.check.problems.length, 1);
  ok('apply() adds new lists, skips stored ones, records problems');
}

// ---- readLists(): a non-empty PDF the parser can't read is a problem
{
  const { readLists } = require('./planning/index.js');
  const garbled = `Weekly list for 16/11/2026 to 20/11/2026\n${'Some changed layout text. '.repeat(30)}`;
  readLists({
    getText: async () => PAGE,
    getPdfText: async (url) => (/Decisions/.test(url) ? garbled : /Appeals/.test(url) ? APPEALS : APPS),
  }).then((r) => {
    assert.strictEqual(r.lists.length, 3);
    assert.deepStrictEqual(r.problems, ['parser found no entries in the non-empty decisions list "Decisions Made 16 - 20 November 2026.pdf"']);
    ok('readLists() flags a non-empty list with no entries');
    newsletter(lists2());
  }).catch((e) => { console.error(e); process.exit(1); });
}

function lists2() {
  let d = null;
  d = P.addList(d, P.weekOf(APPS), 'applications', P.forParishes(P.parseList(APPS, 'applications'), ['South Lenches', 'Rous Lench']));
  d = P.addList(d, P.weekOf(DECS), 'decisions', []);
  return d;
}

// ---- readLists(): a page that can't be read is a problem, not a crash
{
  const { readLists } = require('./planning/index.js');
  readLists({ getText: async () => { throw new Error('HTTP 307 for https://www.wychavon.gov.uk/x'); } }).then((r) => {
    assert.deepStrictEqual(r, { lists: [], problems: ["Wychavon's weekly list page could not be read (HTTP 307)"] });
    ok('readLists() records an unreadable page as a problem');
  }).catch((e) => { console.error(e); process.exit(1); });
}

// ---- Newsletter section, both sites (child processes: SITE is read at load).
function newsletter(lenchesData) {
  const harvData = P.addList(null, P.weekOf(APPEALS), 'appeals', P.parseList(APPEALS, 'appeals'));
  const script = `
    const { select } = require('./scripts/newsletter/select.js');
    const { render } = require('./scripts/newsletter/render.js');
    const planning = JSON.parse(process.argv[1]);
    const base = { issueDate: '2026-11-26', pending: [], whatson: { events: [], notices: [] }, bins: null, issues: [], settings: {}, sources: [], jpegFor: () => '' };
    const m = select({ ...base, planning });
    const r = render(m);
    const old = select(base);
    const o = render(old);
    const m2 = JSON.parse(JSON.stringify(m)); delete m2.planning;
    process.stdout.write(JSON.stringify({ has: 'planning' in m, html: r.html, text: r.text, keys: m.keys.length, empty: m.empty,
      oldHas: 'planning' in old, oldHtml: o.html, stripped: render(m2).html, late: 'planning' in select({ ...base, issueDate: '2026-12-03', planning }) }));`;
  const run = (site, data) => JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(data)], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, SITE: site }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  }));

  const l = run('lenches', lenchesData);
  assert.ok(l.has && !l.oldHas, 'model has planning only with data');
  assert.ok(!l.late, 'a week is in one issue only');
  assert.strictEqual(l.keys, 0, 'planning is not counted as items');
  assert.ok(l.empty, 'planning alone leaves the issue "empty" (no items)');
  assert.ok(l.html.includes('Planning this week'));
  assert.ok(l.html.includes("From Wychavon&#39;s weekly list for South Lenches and Rous Lench parishes, 16 to 20 November."));
  assert.ok(l.html.includes('https://thelenches.org.uk/living-here/planning/'));
  assert.ok(l.html.includes('<b>Land at OS 0208 4905, Sheriffs Lench</b>'));
  assert.ok(l.html.includes('https://plan.wychavon.gov.uk/Planning/Display/W/26/02669/PIP'));
  assert.ok(l.html.includes('None this week.'), 'decisions read, none for these parishes');
  assert.ok(l.html.includes('>1 new home</span>'), 'new homes badge');
  assert.ok(/<a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=52\.13979%2C-1\.97095" target="_blank"[^>]*>Map<\/a>/.test(l.html), 'map link opens in a new window');
  assert.ok(l.html.indexOf('Planning this week') < l.html.indexOf('From Wychavon') && /Planning this week<\/div><\/td><\/tr><tr>/.test(l.html), 'rule straight under the title, intro below');
  assert.ok(l.text.includes('Sheriffs Lench [1 new home]:'));
  assert.ok(l.html.includes('Not yet published by Wychavon.'), 'appeals list not read yet');
  assert.ok(l.html.indexOf('Planning this week') < l.html.indexOf('>Bins<'), 'before Bins');
  assert.ok(l.text.includes('PLANNING THIS WEEK') && l.text.includes('- Land at OS 0208 4905, Sheriffs Lench [1 new home]: Permission in principle'));
  assert.ok(!l.oldHtml.includes('Planning this week'));
  assert.strictEqual(l.stripped, l.oldHtml, 'a snapshot without planning renders exactly as before');
  ok('Lenches newsletter section; older snapshots unchanged');

  const h = run('harvington', harvData);
  assert.ok(h.html.includes('for Harvington and Norton and Lenchwick parishes, 16 to 20 November.'));
  assert.ok(h.html.includes('https://harvingtonvillage.org.uk/living-here/planning/'));
  assert.ok(h.html.includes('appeal started 18 Nov'));
  assert.strictEqual((h.html.match(/Not yet published by Wychavon\./g) || []).length, 2);
  ok('Harvington newsletter section');
  console.log('All planning tests passed.');
}

// Newsletter: Comments close soon at the top of the band, also on its own before the week's list is out.
{
  const { render } = require('./newsletter/render.js');
  const closing = [{ ref: 'W/26/1/FUL', location: 'Hill Barn, Church Lench', proposal: 'Erection of 2 dwellings', link: P.DISPLAY + 'W/26/1/FUL', consultationEnd: '2026-12-07', daysLeft: 4, homes: 2, homesLabel: '2 new homes' }];
  const base = { issueDate: '2026-12-03', events: [], notices: [], roads: [], regulars: [], elsewhere: [], bins: { expired: true, groups: [] } };
  const committee = [{ ref: 'W/26/2/FUL', location: 'Woodlands, Church Lench', proposal: 'Up to 5 dwellings', link: P.DISPLAY + 'W/26/2/FUL', committee: '2026-12-10' }];
  const out = render({ ...base, planning: { parishes: ['South Lenches', 'Rous Lench'], closing, committee } });
  assert.ok(out.html.includes('Going to planning committee') && out.html.includes('Committee Thu 10 Dec'));
  assert.ok(out.text.includes('- Committee Thu 10 Dec: Woodlands, Church Lench'));
  {
    const html = out.html || String(out);
    assert.ok(html.includes('Comments close soon') && html.includes('By Mon 7 Dec (4 days left)'));
    assert.ok(html.includes("This week&#39;s list from Wychavon isn&#39;t out yet."));
    assert.ok(!html.includes('Not yet published by Wychavon.'), 'no weekly parts without a week');
    assert.ok(html.includes('See the plans and comment'));
    assert.ok((out.text || '').includes('Comments close soon:'), 'text version too');
    console.log('ok - newsletter Comments close soon');
  }
}

// Map (28 Nov 2026): placeAll gives each application a point once (grid reference, else the postcode
// on its page; the postcode is never stored; unreadable pages are tried again), mapPoints the pins.
(async () => {
  const { placeAll } = require('./planning/index.js');
  const data = {
    weeks: [{ applications: [{ ref: 'W/26/1/FUL', location: 'Land at OS 0208 4905, Sheriffs Lench', proposal: 'Erection of 1 dwelling' },
      { ref: 'W/26/2/HP', location: 'Hill Barn, Church Lench', proposal: 'Extension' }, { ref: 'W/26/3/HP', location: 'Gone, Rous Lench', proposal: 'x' }],
    decisions: [{ ref: 'W/26/2/HP', location: 'Hill Barn, Church Lench', proposal: 'Extension', decision: 'Approval' }] }],
    open: [{ ref: 'W/26/1/FUL', location: 'Land at OS 0208 4905, Sheriffs Lench', proposal: 'Erection of 1 dwelling', consultationEnd: '2026-12-01', homes: 1 }],
  };
  const pages = { 'W/26/2/HP': 'WR11 4UH' };
  const getDisplay = async (u) => {
    const ref = u.replace(P.DISPLAY, '');
    if (!pages[ref]) throw new Error('unreadable');
    return `<p>Planning Online Status</p><p>Summary</p><p>Location Address</p><p>Hill Barn</p><p>Church Lench</p><p>${pages[ref]}</p><p>Proposal</p><p>Extension</p><p>Status</p><p>Pending</p>`;
  };
  let lookups = 0;
  const r = await placeAll(data, { getDisplay, lookup: async () => { lookups += 1; return { lat: 52.1234567, lng: -1.9876543 }; }, wait: 0 });
  assert.strictEqual(lookups, 1, 'one lookup per reference');
  assert.deepStrictEqual([data.weeks[0].applications[1].lat, data.weeks[0].applications[1].place, data.weeks[0].decisions[0].place], [52.12346, 'postcode', 'postcode']);
  assert.strictEqual(data.open[0].place, 'grid');
  assert.ok(!data.weeks[0].applications[2].place, 'an unreadable page is tried again next run');
  assert.ok(!JSON.stringify(data).includes('WR11'), 'postcode never stored');
  assert.strictEqual(r.placed, 4);
  const pins = P.mapPoints(data, '2026-11-28');
  assert.deepStrictEqual(pins.map((p) => [p.ref, p.kind, p.anchor, p.approx, p.homes]),
    [['W/26/1/FUL', 'closing', 'pl-w-26-1-ful', false, 1], ['W/26/2/HP', 'decided', 'pl-w-26-2-hp', true, 0]]);
  console.log('ok - map points and pins');
})().catch((e) => { console.error(e); process.exit(1); });
