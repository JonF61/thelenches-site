// scripts/newsletter/render.js
// Turns an issue model (select.js) into subject, HTML and plain text. Pure and
// deterministic: no clock, no randomness; the content hash covers all three.
// Layout: the mock-up agreed 2 Oct 2026. 600px table, inline CSS, site palette
// (src/style.css :root), JPEG images hosted on the site.
// The footer's unsubscribe link is UNSUB_MARK in the hashed content; unsub.js swaps in
// each recipient's own link at send time (step 5b part 3).
'use strict';

const crypto = require('crypto');
const { anchorUrl } = require('../../lib/anchors');

const SITE = 'https://thelenches.org.uk';
const UNSUB_MARK = '%%UNSUBSCRIBE_URL%%';
const LINKS = {
  site: `${SITE}/`,
  privacy: `${SITE}/privacy/`,
  bins: `${SITE}/bins/`,
  submit: 'website@thelenches.org.uk',
};
const C = {
  green: '#3F5233', greenDark: '#2E3D26', greenLight: '#EFE7D3', ink: '#2E2A1F',
  muted: '#5B5240', accentText: '#9A5312', cream: '#F6F1E4', paper: '#FBF8F1',
  card: '#ffffff', line: '#DCCFAE', accent: '#C0703A', red: '#A33B2B',
};
const SANS = 'Arial,Helvetica,sans-serif';
const SERIF = 'Georgia,\'Times New Roman\',serif';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Paragraphs at blank lines ("\n\n"), as the site's paras filter (.eleventy.js).
const paras = (s) => String(s ?? '').split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
const para = (s) => paras(s)
  .map((p, i) => `<p style="margin:${i ? '8px' : '0'} 0 0;">${esc(p)}</p>`).join('');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function dateParts(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const day = DAYS[d.getUTCDay()];
  const month = MONTHS[d.getUTCMonth()];
  return {
    dow: day.slice(0, 3).toUpperCase(),
    dayShort: day.slice(0, 3),
    date: d.getUTCDate(),
    mon: month.slice(0, 3),
    long: `${day} ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`,
    short: `${day.slice(0, 3)} ${d.getUTCDate()} ${month.slice(0, 3)}`,
    subject: `${day} ${d.getUTCDate()} ${month}`,
  };
}

function binList(bins) {
  const names = bins.map((b) => b.toLowerCase());
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

function binLines(bins) {
  if (bins.expired || !bins.groups.length) return [];
  return bins.groups.map((g) => {
    const note = g.note ? ` (${g.note})` : '';
    return `${g.names.join(', ')}: ${dateParts(g.date).short}, ${binList(g.bins)}${note}`;
  });
}

function summaryLine(m) {
  const parts = [];
  if (m.events.length) parts.push(plural(m.events.length, 'event', 'events'));
  if (m.news.length) parts.push(plural(m.news.length, 'news story', 'news stories'));
  if (m.notices.length) parts.push(plural(m.notices.length, 'notice', 'notices'));
  if (m.roads.length) parts.push(plural(m.roads.length, 'roadworks item', 'roadworks items'));
  if (!parts.length) return 'A quiet week: nothing new to report.';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `This week: ${list}.`;
}

/* ----------------------------------------------------------------- HTML -- */

const a = (url, text, color) => `<a href="${esc(url)}" style="color:${color};text-decoration:underline;">${esc(text)}</a>`;

function sectionHead(title) {
  return `<tr><td class="px" style="padding:20px 24px 0;">`
    + `<div style="font-family:${SANS};font-size:17px;font-weight:bold;color:${C.green};border-bottom:1px solid ${C.line};padding-bottom:4px;">${esc(title)}</div>`
    + `</td></tr>`;
}

// The picture links to the item on the site (lib/anchors.js), when there is one.
function imageRow(img, width, href) {
  const tag = `<img src="${esc(img.src)}" width="${width}" alt="${esc(img.alt)}" `
    + `style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;">`;
  return href ? `<a href="${esc(href)}" style="display:block;text-decoration:none;">${tag}</a>` : tag;
}

// "Lenches" badge (site: .lenches-badge in src/events.njk). A table cell, not a styled
// span, so classic Outlook keeps the padding and background.
function titleWithBadge(titleHtml, style) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td valign="middle" style="${style}">${titleHtml}</td>`
    + `<td valign="middle" style="padding-left:6px;">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td bgcolor="#fbe6d6" style="background:#fbe6d6;color:#8a3e0c;font-family:${SANS};font-size:11px;font-weight:bold;`
    + `line-height:16px;mso-line-height-rule:exactly;padding:1px 7px;border-radius:4px;white-space:nowrap;">Lenches</td>`
    + `</tr></table></td></tr></table>`;
}

function linkLine(link) {
  return link ? `<div style="margin-top:6px;font-family:${SANS};font-size:13px;">${a(link.url, link.text, C.accentText)}</div>` : '';
}

function eventCard(ev) {
  const p = dateParts(ev.date);
  const tile = `<table role="presentation" width="50" cellpadding="0" cellspacing="0" border="0" style="background:${C.greenLight};">`
    + `<tr><td align="center" style="padding:6px 0;font-family:${SANS};">`
    + `<div style="font-size:11px;color:${C.accentText};">${p.dow}</div>`
    + `<div style="font-size:20px;font-weight:bold;color:${C.greenDark};line-height:1.2;">${p.date}</div>`
    + `<div style="font-size:11px;color:${C.muted};">${p.mon}</div>`
    + `</td></tr></table>`;
  const meta = ev.meta ? `<div style="font-family:${SANS};font-size:12px;color:${C.muted};margin-top:2px;">${esc(ev.meta)}</div>` : '';
  const body = ev.body ? `<div style="margin-top:4px;">${para(ev.body)}</div>` : '';
  const img = ev.image
    ? `<tr><td colspan="2" style="padding:0 12px 12px;">${imageRow(ev.image, 528, anchorUrl('event', ev))}</td></tr>`
    : '';
  const titleStyle = `font-family:${SANS};font-weight:bold;font-size:15px;`;
  const title = ev.lenches
    ? titleWithBadge(esc(ev.title), `${titleStyle}color:${C.ink};`)
    : `<div style="${titleStyle}">${esc(ev.title)}</div>`;
  return `<tr><td class="px" style="padding:10px 24px 0;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};">`
    + `<tr><td width="62" valign="top" style="padding:12px 0 12px 12px;">${tile}</td>`
    + `<td valign="top" style="padding:12px;font-family:${SERIF};font-size:14px;line-height:1.5;color:${C.ink};">`
    + `${title}${meta}${body}${linkLine(ev.link)}</td></tr>${img}</table></td></tr>`;
}

function storyBlock(it, titleSize, kind) {
  const meta = it.meta ? `<div style="font-family:${SANS};font-size:12px;color:${C.muted};">${esc(it.meta)}</div>` : '';
  const img = it.image ? `<div style="margin-top:8px;">${imageRow(it.image, 552, anchorUrl(kind, it))}</div>` : '';
  return `<tr><td class="px" style="padding:12px 24px 0;font-family:${SERIF};font-size:14px;line-height:1.55;color:${C.ink};">`
    + `<div style="font-weight:bold;font-size:${titleSize}px;">${esc(it.title)}</div>${meta}`
    + (it.body ? `<div style="margin-top:4px;">${para(it.body)}</div>` : '')
    + `${linkLine(it.link)}${img}</td></tr>`;
}

function roadsAndBins(m) {
  const lines = [];
  for (const r of m.roads) {
    const when = r.date ? ` (from ${dateParts(r.date).short})` : '';
    lines.push(`<div style="margin-bottom:8px;"><span style="color:${C.accentText};">Roadworks</span> · `
      + `<strong>${esc(r.title)}</strong>${esc(when)}`
      + (r.body ? para(r.body) : '')
      + (r.link ? `<div>${a(r.link.url, r.link.text, C.accentText)}</div>` : '') + `</div>`);
  }
  const bl = binLines(m.bins);
  if (bl.length) {
    lines.push(`<div><span style="color:${C.accentText};">Bins</span> · ${bl.map(esc).join(' · ')} · ${a(LINKS.bins, 'Bins page', C.accentText)}</div>`);
  } else {
    lines.push(`<div><span style="color:${C.accentText};">Bins</span> · Check your collection day on ${a(m.bins.lookup, 'Wychavon\'s lookup', C.accentText)}</div>`);
  }
  return `<tr><td class="px" style="padding:12px 24px 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.ink};">${lines.join('')}</td></tr>`;
}

function renderHtml(m, subject) {
  const p = dateParts(m.issueDate);
  const rows = [];

  rows.push(`<tr><td class="px" style="background:${C.cream};padding:18px 24px;border-bottom:3px solid ${C.accent};">`
    + `<div style="font-family:${SANS};font-size:22px;font-weight:bold;color:${C.green};">The Lenches Newsletter</div>`
    + `<div style="font-family:${SANS};font-size:12px;color:${C.muted};">Church · Rous · Ab · Atch · Sheriffs · Harvington</div>`
    + `<div style="font-family:${SANS};font-size:13px;color:${C.accentText};margin-top:8px;">${esc(p.long)} · ${a(LINKS.site, 'thelenches.org.uk', C.accentText)}</div>`
    + `</td></tr>`);
  // "New on the website" intro (select.js siteUpdates); no row at all when there are none,
  // so older snapshots render exactly as before.
  const site = m.siteUpdates || [];
  if (site.length) {
    rows.push(`<tr><td class="px" style="background:${C.cream};padding:10px 24px;border-bottom:1px solid ${C.line};font-family:${SANS};font-size:13px;line-height:1.5;">`
      + site.map((u) => `<div style="margin:2px 0;">${a(u.url, u.text, C.accentText)}</div>`).join('')
      + `</td></tr>`);
  }
  rows.push(`<tr><td class="px" style="padding:16px 24px 0;font-family:${SERIF};font-size:15px;line-height:1.6;color:${C.ink};">${esc(summaryLine(m))}</td></tr>`);

  if (m.events.length || m.regulars) {
    rows.push(sectionHead('Coming up'));
    for (const ev of m.events) rows.push(eventCard(ev));
    if (m.regulars) {
      rows.push(`<tr><td class="px" style="padding:10px 24px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};">${para(m.regulars)}</td></tr>`);
    }
  }
  if (m.news.length) {
    rows.push(sectionHead('News'));
    for (const it of m.news) rows.push(storyBlock(it, 16, 'news'));
  }
  if (m.notices.length) {
    rows.push(sectionHead('Notices'));
    for (const it of m.notices) rows.push(storyBlock(it, 15, 'notice'));
  }
  rows.push(sectionHead('Roads and bins'));
  rows.push(roadsAndBins(m));
  if (m.elsewhere.length) {
    rows.push(sectionHead('Elsewhere'));
    rows.push(`<tr><td class="px" style="padding:12px 24px 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.ink};">`
      + m.elsewhere.map((e) => `<div style="margin-bottom:4px;">${esc(e.title)} · ${a(e.link.url, e.link.text, C.accentText)}</div>`).join('')
      + `</td></tr>`);
  }

  const cream = C.cream;
  rows.push(`<tr><td style="padding:20px 0 0;"></td></tr>`);
  rows.push(`<tr><td class="px" style="background:${C.greenDark};color:${cream};padding:16px 24px;font-family:${SANS};font-size:12px;line-height:1.6;">`
    + `Got news for next week? Email ${a(`mailto:${LINKS.submit}`, LINKS.submit, cream)} by 6pm Wednesday.<br>`
    + `To stop receiving this newsletter, ${a(UNSUB_MARK, 'unsubscribe here', cream)} or reply with UNSUBSCRIBE.<br>`
    + `${a(LINKS.site, 'thelenches.org.uk', cream)} · ${a(LINKS.privacy, 'Privacy', cream)}`
    + `</td></tr>`);

  return '<!DOCTYPE html>\n<html lang="en-GB"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="x-apple-disable-message-reformatting">'
    + `<title>${esc(subject)}</title>`
    + '<style>@media only screen and (max-width:620px){.wrap{width:100%!important}.px{padding-left:16px!important;padding-right:16px!important}}</style>'
    + `</head><body style="margin:0;padding:0;background:${C.greenLight};">\n<!--PREVIEW-->\n`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.greenLight};"><tr><td align="center" style="padding:16px 8px;">`
    + `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.paper};border:1px solid ${C.line};">\n`
    + rows.join('\n')
    + '\n</table></td></tr></table>\n</body></html>\n';
}

/* ----------------------------------------------------------------- Text -- */

function renderText(m) {
  const p = dateParts(m.issueDate);
  const out = [];
  const head = (t) => { out.push('', t.toUpperCase(), '-'.repeat(t.length), ''); };
  const item = (title, meta, body, link) => {
    out.push(title);
    if (meta) out.push(meta);
    if (body) out.push(paras(body).join('\n\n'));
    if (link) out.push(`${link.text}: ${link.url.replace(/^mailto:/i, '')}`);
    out.push('');
  };

  out.push('THE LENCHES NEWSLETTER', 'Church · Rous · Ab · Atch · Sheriffs · Harvington', `${p.long} · ${LINKS.site}`, '');
  for (const u of m.siteUpdates || []) out.push(u.text, u.url, '');
  out.push(summaryLine(m));
  if (m.events.length || m.regulars) {
    head('Coming up');
    for (const ev of m.events) item(`${dateParts(ev.date).short} · ${ev.title}${ev.lenches ? ' [Lenches]' : ''}`, ev.meta, ev.body, ev.link);
    if (m.regulars) out.push(paras(m.regulars).join('\n\n'), '');
  }
  if (m.news.length) {
    head('News');
    for (const it of m.news) item(it.title, it.meta, it.body, it.link);
  }
  if (m.notices.length) {
    head('Notices');
    for (const it of m.notices) item(it.title, it.meta, it.body, it.link);
  }
  head('Roads and bins');
  for (const r of m.roads) item(`Roadworks · ${r.title}${r.date ? ` (from ${dateParts(r.date).short})` : ''}`, '', r.body, r.link);
  const bl = binLines(m.bins);
  if (bl.length) out.push(`Bins · ${bl.join(' · ')}`, `Bins page: ${LINKS.bins}`);
  else out.push(`Bins · Check your collection day: ${m.bins.lookup}`);
  if (m.elsewhere.length) {
    head('Elsewhere');
    for (const e of m.elsewhere) out.push(`${e.title} · ${e.link.text}: ${e.link.url}`);
  }
  out.push('', '--', `Got news for next week? Email ${LINKS.submit} by 6pm Wednesday.`,
    `To unsubscribe: ${UNSUB_MARK} (or reply with UNSUBSCRIBE).`,
    `Website: ${LINKS.site}`, `Privacy: ${LINKS.privacy}`, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------ Render API -- */

function render(model) {
  const subject = `The Lenches Newsletter – ${dateParts(model.issueDate).subject}`;
  const html = renderHtml(model, subject);
  const text = renderText(model);
  const hash = crypto.createHash('sha256').update(`${subject}\n\u0000${html}\n\u0000${text}`, 'utf8').digest('hex');
  return { subject, html, text, hash };
}

// Signed buttons (actions.js) as HTML and text, for the preview and reminder emails.
// info: { send, rebuild, pending: [{ title, approve?, reject? }], pendingTotal, note }
function actionsBlock(info) {
  const btn = (link, bg) => (link
    ? `<a href="${esc(link.url)}" style="display:inline-block;margin:6px 8px 0 0;padding:10px 16px;background:${bg};color:#ffffff;font-family:${SANS};font-size:14px;font-weight:bold;border-radius:4px;text-decoration:none;">${esc(link.label)}</a>`
    : '');
  const pend = info.pending || [];
  const total = info.pendingTotal ?? pend.length;
  const item = (p) => esc(p.title) + (p.approve
    ? ` · <a href="${esc(p.approve)}" style="color:${C.green};font-weight:bold;">Approve</a>`
      + ` · <a href="${esc(p.reject)}" style="color:${C.red};font-weight:bold;">Reject</a>`
    : '');
  const html = (total
    ? `<div style="margin-top:8px;"><strong>Awaiting approval (${total}):</strong><br>${pend.map(item).join('<br>')}`
      + `<div style="color:${C.muted};font-size:12px;">Approvals reach this issue only when you Rebuild.</div></div>`
    : '<div style="margin-top:8px;">Nothing awaiting approval.</div>')
    + `<div style="margin-top:10px;">${btn(info.send, C.green)}${btn(info.rebuild, C.accentText)}</div>`
    + (info.note ? `<div style="margin-top:6px;color:${C.muted};font-size:12px;">${esc(info.note)}</div>` : '');
  const lines = [total ? `Awaiting approval (${total}; approvals reach this issue only when you Rebuild):` : 'Nothing awaiting approval.'];
  for (const p of pend) {
    lines.push(`- ${p.title}`);
    if (p.approve) lines.push(`  Approve: ${p.approve}`, `  Reject: ${p.reject}`);
  }
  if (info.send) lines.push('', `${info.send.label}: ${info.send.url}`);
  if (info.rebuild) lines.push(`${info.rebuild.label}: ${info.rebuild.url}`);
  if (info.note) lines.push(info.note);
  return { html, text: lines.join('\n') };
}

// Preview copy for Jon: a banner with the buttons above the issue. Never part of the hash.
// info: { testTo, status, ...actions.buttons() }
function wrapPreview(rendered, info) {
  const block = actionsBlock(info);
  const banner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:16px 8px 0;">`
    + `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:2px solid ${C.accent};">`
    + `<tr><td style="padding:14px 18px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.ink};">`
    + `<div style="font-size:15px;font-weight:bold;color:${C.accentText};">PREVIEW: not sent to subscribers</div>`
    + `<div>Test copy sent to ${esc(info.testTo)}. Status: ${esc(info.status)}. Hash ${esc(rendered.hash.slice(0, 12))}.</div>`
    + block.html
    + `</td></tr></table></td></tr></table>`;
  const textBanner = ['PREVIEW: not sent to subscribers',
    `Test copy sent to ${info.testTo}. Status: ${info.status}. Hash ${rendered.hash.slice(0, 12)}.`,
    block.text, '', '========', ''].join('\n');
  return {
    subject: `[Preview] ${rendered.subject}`,
    html: rendered.html.replace('<!--PREVIEW-->', banner),
    text: textBanner + rendered.text,
  };
}

module.exports = { render, wrapPreview, actionsBlock, dateParts, UNSUB_MARK };
