// scripts/rimmer/index.js
// Rimmer (3 Nov, Jon; named after the Red Dwarf character): an independent second Claude that reads what readers will see and
// reports problems to Jon on the admin panel. It never changes anything: it only writes rows
// to the "Rimmer" tab, which the panel lists (Summary, Newsletter draft, Health) with Fix…, Send to
// Kryten and Dismiss (fixes: scripts/rimmer/fix.js). Rimmer is "he" (Jon, 3 Nov).
//   newsletter  the next issue exactly as draft.js builds it (Wednesday evening, and the
//               draft bar's Check button)
//   listings    the built site's listings pages (weekly)
//   site        every page of the built site (monthly)
// For each finding whose words are in an entry Fix… can change, Holly drafts the fix in the same run
// (fix_status "offered"), so the panel shows Apply / Discard straight away; Jon still applies it.
// Each run marks the same scope's earlier open findings "replaced" and adds its own. Findings
// Jon dismissed (last 120 days) are passed back so they are not raised again.
// Logs print counts only (logs are public). rimmer.yml runs it; listings/site need _site built.
'use strict';

const fs = require('fs');
const path = require('path');
const { callTool } = require('../ingest/toolcall');

const ROOT = path.join(__dirname, '..', '..');
const SITE_DIR = path.join(ROOT, '_site');
const TAB = 'Rimmer';
// status: open, dismissed, replaced, fixed, kryten (sent to Kryten). fix_*: Fix… (scripts/rimmer/fix.js).
const HEADERS = ['id', 'created_at', 'scope', 'target', 'page', 'where', 'severity', 'problem', 'quote', 'suggestion', 'status',
  'fix_status', 'fix_note', 'fix_source', 'fix_label', 'fix_field', 'fix_old', 'fix_new', 'fix_reason', 'fixed_at'];
const SCOPES = ['newsletter', 'listings', 'site'];
// The website pages the newsletter's sections come from: read beside it so Rimmer can check the
// two agree (Jon, 10 Nov).
const NEWSLETTER_SITE_PAGES = ['/events/', '/notices/', '/living-here/roads/', '/regulars/'];
const LISTING_PAGES = ['/events/', '/notices/', '/living-here/roads/', '/regulars/', '/living-here/eat/', '/living-here/trades/'];
const SKIP_PAGES = new Set(['/search/']);
const MAX_FINDINGS = 15;
const BUSY_FIX = ['asked', 'proposed', 'applying'];
const DISMISSED_DAYS = 120;
const TZ = 'Europe/London';
const MODEL = () => process.env.RIMMER_MODEL || 'claude-opus-5-5';
// Fixes drafted in the same run (4 Nov, Jon): Holly (Opus) drafts one per finding whose words are
// in an entry Fix… can change, 3 at a time; RIMMER_AUTOFIX=off turns it off.
const AUTOFIX_AT_ONCE = 3;

const str = (v) => String(v ?? '').trim();
const clip = (t, n) => { const f = str(t).replace(/\s+/g, ' '); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const ukDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
const ukStamp = (ms) => {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return `${ukDate(ms)} ${t}`;
};

/* ------------------------------------------------------------ text -- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', pound: '£', middot: '·', times: '×' };
function decode(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Readable text from HTML: headings marked, list items bulleted, links as "words (url)",
// images as their alt text; scripts, styles and comments dropped.
function htmlToText(html) {
  let t = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, '')
    // The orange "Lenches" badge on an event's title (site .lenches-badge; newsletter titleWithBadge,
    // a #fbe6d6 cell): shown as a marker, so it never reads as a stray word in the heading (5 Nov).
    .replace(/<span\b[^>]*\blenches-badge\b[^>]*>[\s\S]*?<\/span>/gi, ' [Lenches badge] ')
    .replace(/<td\b[^>]*#fbe6d6[^>]*>\s*Lenches\s*<\/td>/gi, ' [Lenches badge] ')
    .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/gi, (m, alt) => (alt ? ` [image: ${alt}] ` : ' '))
    .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const words = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const url = decode(href);
      if (!words) return ` (${url}) `;
      // mailto:/tel: shown as the address or number itself, so the reader-visible target is never hidden.
      const shown = url.replace(/^(mailto:|tel:)/i, '').replace(/\?.*$/, '');
      return words.includes(shown.replace(/^https?:\/\//, '').replace(/\/$/, '')) ? ` ${words} ` : ` ${words} (${shown}) `;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|table|section|article|header|ul|ol|dl|dt|dd|figure|figcaption|blockquote)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  t = decode(t);
  return t.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim().replace(/^(\|\s*)+/, '').replace(/(\s*\|)+$/, '').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A built page's own content: the data-src wrapper base.njk puts round {{ content }}.
function pageContent(html) {
  const start = html.search(/<div\b[^>]*\bdata-src="/i);
  if (start < 0) return '';
  const end = html.indexOf('<footer', start);
  return htmlToText(html.slice(start, end > start ? end : undefined));
}

function sitePages(dir = SITE_DIR) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'index.html') out.push(`/${path.relative(dir, d).split(path.sep).join('/')}${d === dir ? '' : '/'}`.replace(/^\/\/$/, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

function readPages(paths, dir = SITE_DIR) {
  const docs = [];
  for (const p of paths) {
    if (SKIP_PAGES.has(p)) continue;
    const file = path.join(dir, p, 'index.html');
    if (!fs.existsSync(file)) continue;
    const text = pageContent(fs.readFileSync(file, 'utf8'));
    if (text.length >= 40) docs.push({ page: p, text });
  }
  return docs;
}

// Dates with weekdays, so Claude never has to work a weekday out.
function calendar(today, days = 70, back = 7) {
  const out = [];
  const t0 = Date.parse(`${today}T12:00:00Z`);
  for (let i = -back; i < days; i += 1) {
    const d = new Date(t0 + i * 86400000);
    out.push(`${d.toISOString().slice(0, 10)} ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}${i === 0 ? ' (today)' : ''}`);
  }
  return out.join('\n');
}

/* ---------------------------------------------------------- prompt -- */

const SYSTEM = `You are Rimmer: an independent reviewer for a small community website and weekly
email newsletter covering the Lenches villages in Worcestershire (Church, Rous, Ab, Atch and
Sheriffs Lench). Other software (and another Claude) wrote what you are given; you read it the way
a careful local reader would, and report the problems a reader would notice or be misled by, so
the person who runs it can fix them. You change nothing yourself.

Report only concrete problems, for example:
- repeats: the same thing said twice, in the same or different words, or the same event or
  notice listed twice (say where both are);
- contradictions: two places giving different dates, times, places, prices or contact details for
  the same thing;
- dates: a weekday that does not match its date (use the calendar given; never work a weekday out
  yourself), an event shown as coming up whose date has passed, a notice that is clearly out of
  date, a date with no time where readers need one, "this Saturday" style wording that will be
  wrong by the time it is read;
- missing essentials: an event with no place or no time, a booking or entry mentioned with no
  way to do it, a link or phone number that looks broken, cut off or like a placeholder;
- wording: typos, garbled or cut-off sentences, a sentence that does not make sense, text in the
  wrong section, headings that do not match what is under them;
- policy: another organisation's sponsors named, a private person's personal email or phone
  given where it looks unintended, anything that could embarrass or upset a reader.
Do not report matters of taste or style, British spellings, the order of items, things you merely
would have written differently, or anything you would have to look up outside what you are given.
"[Lenches badge]" after a title is the small label that marks an event in the Lenches villages: it
is meant to be there, so never report it as a stray or repeated word.
Statements from parish councils, councillors and other official bodies are kept in their own
words on purpose: report only obvious typos or broken links in them.
Use severity "problem" when you are sure it is wrong, "check" when it may be wrong and a person
should look. Quote the exact words (short) so the person can find them. Suggest the fix in one
sentence. Say where it is (the section, item title or page). At most ${MAX_FINDINGS} findings, the most
important first; none is a fine answer. The person has already dismissed the findings listed under
"dismissed": do not raise them again unless the text has changed so they now matter more.
Write in plain British English.`;

const TOOL = {
  name: 'report_findings',
  description: 'Report the problems found (an empty list if none).',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['problem', 'check'] },
            page: { type: 'string', description: 'The page path (e.g. /events/), or "newsletter".' },
            where: { type: 'string', description: 'Section, item title or heading.' },
            quote: { type: 'string', description: 'The exact words, short.' },
            problem: { type: 'string', description: 'What is wrong, one or two sentences.' },
            suggestion: { type: 'string', description: 'The fix, one sentence.' },
          },
          required: ['severity', 'page', 'where', 'problem'],
        },
      },
    },
    required: ['findings'],
  },
};

function buildRequest({ scope, docs, today, dismissed, issueDate }) {
  const what = scope === 'newsletter'
    ? `The next newsletter issue (${issueDate}), as subscribers will receive it. It is sent on the morning of ${issueDate}; judge "coming up" and dates from that day.`
      + (docs.length > 1 ? `\nAlso given: the website pages the newsletter's sections come from (events, notices, roads, regular activities), as they stand now. Check the newsletter against them: an item in both should give the same title, date, time, place, price, contact details and links; report any difference, saying which wording looks right. Also report an item in the newsletter that is missing from the website or shows there as past or withdrawn. The newsletter shows only some of the website's items (events in the next two weeks, notices new since the last issue), so never report website items that are not in the newsletter, and do not check the website pages for other problems: only how they agree with the newsletter. Give the page as "newsletter" when the newsletter wording is wrong, or the website page's path when the website is wrong.` : '')
    : scope === 'listings'
      ? 'The website\'s listings pages (events, notices, roads, regular activities, places to eat, local trades). Check each page and across pages.'
      : 'Every page of the website. Check each page and across pages (the same facts on two pages should agree).';
  const body = docs.map((d) => `=== ${d.page} ===\n${d.text}`).join('\n\n');
  const user = `${what}\n\nCalendar:\n${calendar(today)}\n\ndismissed:\n${dismissed.length ? dismissed.map((d) => `- ${d}`).join('\n') : '(none)'}\n\n${body}`;
  return {
    model: MODEL(),
    // Opus thinks before answering: 4000 cut off the first listings run (3 Nov) with no findings.
    max_tokens: 16000,
    system: SYSTEM,
    tools: [TOOL],
    messages: [{ role: 'user', content: user }],
  };
}

function cleanFindings(input, scope, docs) {
  const pages = new Set(docs.map((d) => d.page));
  const list = Array.isArray(input && input.findings) ? input.findings : [];
  return list.slice(0, MAX_FINDINGS).map((f) => ({
    severity: f && f.severity === 'problem' ? 'problem' : 'check',
    page: pages.has(str(f && f.page)) ? str(f.page) : (scope === 'newsletter' ? 'newsletter' : clip(f && f.page, 80)),
    where: clip(f && f.where, 120),
    quote: clip(f && f.quote, 300),
    problem: clip(f && f.problem, 600),
    suggestion: clip(f && f.suggestion, 400),
  })).filter((f) => f.problem);
}

/* ------------------------------------------------------------- run -- */

async function docsFor(scope, g) {
  if (scope === 'newsletter') {
    const { buildDraft, loadInputs } = require('../newsletter/draft');
    const { meta, html } = buildDraft(await loadInputs(g));
    const docs = [{ page: 'newsletter', text: `Subject: ${meta.subject}\n\n${htmlToText(html)}` }];
    // The website pages, when the site is built (rimmer.yml builds it), for the consistency check.
    if (fs.existsSync(path.join(SITE_DIR, 'index.html'))) docs.push(...readPages(NEWSLETTER_SITE_PAGES));
    return { target: meta.issue_date, issueDate: meta.issue_date, docs };
  }
  if (!fs.existsSync(path.join(SITE_DIR, 'index.html'))) throw new Error('No built site in _site: run Eleventy first');
  const docs = readPages(scope === 'listings' ? LISTING_PAGES : sitePages());
  return { target: scope === 'listings' ? 'listings pages' : 'whole site', docs };
}

// Dismissed findings, and those sent to Kryten, of this scope (for the site, listings ones too)
// from the last 120 days.
function dismissedFor(rows, scope, nowMs) {
  const from = ukDate(nowMs - DISMISSED_DAYS * 86400000);
  const scopes = scope === 'site' ? ['site', 'listings'] : [scope];
  return rows.filter((r) => ['dismissed', 'kryten'].includes(str(r.status)) && scopes.includes(str(r.scope)) && str(r.created_at).slice(0, 10) >= from)
    .slice(-40).map((r) => clip(`${r.page} · ${r.where}: ${r.problem}${r.quote ? ` ("${r.quote}")` : ''}`, 300));
}

function newRows(findings, { scope, target, nowMs }) {
  const stamp = ukStamp(nowMs);
  const base = `K${stamp.replace(/\D/g, '').slice(0, 12)}`;
  return findings.map((f, i) => ({ id: `${base}-${scope[0]}${i + 1}`, created_at: stamp, scope, target, ...f, status: 'open' }));
}

const autofixOn = () => !/^(off|false|0|no)$/i.test(str(process.env.RIMMER_AUTOFIX));

// Holly drafts a fix for each finding Fix… could handle (its words are in a listing, regular
// activity, website update or published submission), writing the fix_* cells onto the finding
// before it is added. A finding with no such entry, or whose draft fails, is left for Fix….
async function draftFixes(findings, { g, client, nowMs }) {
  const fix = require('./fix');
  const stats = { offered: 0, cannot: 0, skipped: 0, failed: 0, calls: 0, inTok: 0, outTok: 0 };
  let all;
  try { all = fix.sources({ pending: await g.readTable('Pending') }); } catch (e) { stats.failed = findings.length; return stats; }
  const todo = findings.filter((f) => {
    if (fix.candidates(f, all).length) return true;
    stats.skipped += 1;
    return false;
  });
  const one = async (f) => {
    try {
      const { result, usage } = await fix.draftFix(f, { all, client, today: ukDate(nowMs) });
      stats.calls += 1;
      stats.inTok += (usage && usage.input_tokens) || 0;
      stats.outTok += (usage && usage.output_tokens) || 0;
      Object.assign(f, fix.fixFields(result, 'offered'));
      stats[result.ok ? 'offered' : 'cannot'] += 1;
    } catch {
      stats.failed += 1;
    }
  };
  for (let i = 0; i < todo.length; i += AUTOFIX_AT_ONCE) await Promise.all(todo.slice(i, i + AUTOFIX_AT_ONCE).map(one));
  return stats;
}

async function run(scope, { g, client, nowMs = Date.now() } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`Unknown scope "${scope}" (newsletter, listings or site)`);
  const { target, docs, issueDate } = await docsFor(scope, g);
  await g.ensureTab(TAB, HEADERS);
  const rows = await g.readTable(TAB);
  const req = buildRequest({ scope, docs, today: ukDate(nowMs), dismissed: dismissedFor(rows, scope, nowMs), issueDate });
  const { res, block } = await callTool(client, req, TOOL.name);
  if (!block) throw new Error(`Claude gave no findings (stop: ${res && res.stop_reason})`);
  // A cut-off answer is not "no problems": fail, leaving earlier findings open.
  if (res.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing (max_tokens); nothing written');
  const findings = cleanFindings(block.input, scope, docs);
  const drafted = autofixOn() ? await draftFixes(findings, { g, client, nowMs }) : null;
  // A finding with a fix on the way (asked, proposed, applying) is left for Jon to finish; one
  // Holly drafted in an earlier run ("offered") is replaced like any other.
  const old = rows.filter((r) => str(r.scope) === scope && str(r.status) === 'open' && !BUSY_FIX.includes(str(r.fix_status)));
  for (const r of old) await g.updateRow(TAB, r._row, { status: 'replaced' });
  const add = newRows(findings, { scope, target, nowMs });
  if (add.length) await g.appendRows(TAB, add);
  const u = res.usage || {};
  console.log(`Rimmer ${scope} (${target}): ${docs.length} page(s), ${docs.reduce((n, d) => n + d.text.length, 0)} characters read; `
    + `${add.filter((f) => f.severity === 'problem').length} problem(s), ${add.filter((f) => f.severity === 'check').length} to check; `
    + `${old.length} earlier finding(s) replaced; tokens in ${u.input_tokens || 0}, out ${u.output_tokens || 0}.`);
  if (drafted) {
    console.log(`Holly's fixes: ${drafted.offered} drafted, ${drafted.cannot} she couldn't, ${drafted.skipped} with no entry to change, ${drafted.failed} failed; `
      + `${drafted.calls} call(s), tokens in ${drafted.inTok}, out ${drafted.outTok}.`);
  }
  return add;
}

async function main() {
  const scope = str(process.env.CHECK_SCOPE || process.argv[2] || 'newsletter').toLowerCase();
  const g = require('../ingest/google');
  const Anthropic = require('@anthropic-ai/sdk');
  await run(scope, { g, client: new Anthropic({ maxRetries: 2, timeout: 600000 }) });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { NEWSLETTER_SITE_PAGES,
  run, htmlToText, pageContent, sitePages, readPages, calendar, buildRequest, cleanFindings, dismissedFor, newRows,
  TAB, HEADERS, SCOPES, LISTING_PAGES, SYSTEM, TOOL, BUSY_FIX, ukStamp, str, clip, draftFixes,
};
