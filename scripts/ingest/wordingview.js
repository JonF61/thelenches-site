// scripts/ingest/wordingview.js
// "Use my wording" in the digest and the action email: both versions side by side, and
// the Approve buttons for them (signed links, as Approve; lib/wording.js decides the rest).
'use strict';

const { signedLink } = require('./links');
const { tidyText, isOfficial, isVerbatim, chosenWording } = require('../../lib/wording');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const paras = (s) => String(s ?? '').split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);

// Why the choice is offered, e.g. "Official notice · They asked for their wording".
function reasonOf(row) {
  return [isOfficial(row) && 'Official notice', isVerbatim(row) && 'They asked for their wording']
    .filter(Boolean).join(' · ');
}

function defaultLine(row) {
  return chosenWording(row) === 'own'
    ? 'Approving in the Sheet instead publishes their wording.'
    : 'Approving in the Sheet instead publishes our rewrite.';
}

function box(label, text, C, chosen) {
  const body = paras(text).map((p, i) => `<p style="margin:${i ? '8px' : '0'} 0 0;">${esc(p)}</p>`).join('');
  return `<div style="margin-bottom:8px;border-left:4px solid ${chosen ? C.green : '#DCCFAE'};background:${C.cream};border-radius:4px;padding:8px 12px;">`
    + `<div style="font-size:12px;font-weight:bold;color:${C.grey};text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">${esc(label)}</div>`
    + `<div style="font-size:14px;">${body || '<i>(empty)</i>'}</div></div>`;
}

// The two versions as HTML, replacing the single summary. C: the email's colours.
function versionsHtml(row, C) {
  const own = chosenWording(row) === 'own';
  return `<div style="color:${C.orange};font-weight:bold;font-size:13px;margin-bottom:6px;">${esc(reasonOf(row))}: choose the wording</div>`
    + box('Their wording', tidyText(row.own_text), C, own)
    + box('Our rewrite', row.summary, C, !own);
}

// Approve buttons for the two versions. button: the email's own button(href, label, bg).
function buttonsHtml(row, button, C) {
  return button(signedLink(row, 'approve_own'), 'Approve with their wording', C.green)
    + button(signedLink(row, 'approve_rewrite'), 'Approve with rewrite', C.green)
    + button(signedLink(row, 'reject'), 'Reject', C.red);
}

function versionsText(row) {
  return [
    `[${reasonOf(row)}: choose the wording]`,
    'THEIR WORDING:', tidyText(row.own_text),
    'OUR REWRITE:', String(row.summary || ''),
  ];
}

function linksText(row) {
  return [
    `Approve with their wording: ${signedLink(row, 'approve_own')}`,
    `Approve with rewrite: ${signedLink(row, 'approve_rewrite')}`,
    `Reject: ${signedLink(row, 'reject')}`,
    defaultLine(row),
  ];
}

module.exports = { versionsHtml, buttonsHtml, versionsText, linksText, defaultLine };
