// lib/wording.js
// "Use my wording": which version of an item's text is published.
// Pending columns (added after the existing ones; any may be missing, see below):
//   official            TRUE for notices from an official body (council, police, utility...)
//   verbatim_requested  TRUE when the submitter asked us to use their own wording
//   own_text            the submitter's own text, only obvious typos and broken links fixed
//   wording             "own" or "rewrite" once chosen (Worker buttons, holiday mode or by
//                       hand); blank = default: own for verbatim_requested, else rewrite
// With the columns missing every item is a plain rewrite, exactly as before.
'use strict';

const str = (v) => String(v ?? '').trim();
const truthy = (v) => /^(true|yes|y|1)$/i.test(str(v));

// Tidies a body for the Sheet: paragraphs kept (blank line between), stray spaces and
// runs of blank lines removed. Single line breaks inside a paragraph are kept.
function tidyText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const hasOwn = (row) => Boolean(str(row && row.own_text));
const isOfficial = (row) => truthy(row && row.official);
const isVerbatim = (row) => truthy(row && row.verbatim_requested);
// Items whose two versions are shown side by side, with the two Approve buttons.
const offersChoice = (row) => hasOwn(row) && (isOfficial(row) || isVerbatim(row));

// "own" or "rewrite": the version that is (or would be) published.
function chosenWording(row) {
  const w = str(row && row.wording).toLowerCase();
  if (!hasOwn(row)) return 'rewrite';
  if (w === 'own' || w === 'rewrite') return w;
  return isVerbatim(row) ? 'own' : 'rewrite';
}

// The text to publish on the site and in the newsletter.
function bodyOf(row) {
  return chosenWording(row) === 'own' ? tidyText(row.own_text) : str(row && row.summary);
}

module.exports = { tidyText, hasOwn, isOfficial, isVerbatim, offersChoice, chosenWording, bodyOf };
