// scripts/newsletter/track.js
// Anonymous newsletter counts (28 Oct 2026; privacy page section 11; on while site.json has
// "newsletterCounts": true). For a live send only, after the content and hash checks:
//   every http(s) link in the HTML goes via the Worker's /c (a signed { a: "c", i: issue
//   date, u: url } token: one click counted for that issue and link, then straight on),
//   and a 1x1 image from the Worker's /o?i=<issue date> counts opens.
// The same copy goes to everyone: nothing in it identifies a subscriber. The plain-text
// part is left as it is. Test and preview copies are never changed.
'use strict';

const { signToken, linksEnabled } = require('../ingest/links');

const ISSUE = /^\d{4}-\d{2}-\d{2}$/;
const unescapeHref = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function workerUrl() {
  return String(process.env.WORKER_URL || '').replace(/\/+$/, '');
}

function clickUrl(url, issueDate) {
  return signToken({ a: 'c', i: issueDate, u: url }, '/c');
}

// issue: { html, text, ... } -> the same with counted links and the open image.
function trackIssue(issue, issueDate) {
  if (!ISSUE.test(String(issueDate || ''))) throw new Error(`Bad issue date "${issueDate}"`);
  if (!linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY and WORKER_URL are needed for counted links');
  const worker = workerUrl();
  let links = 0;
  let html = issue.html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, href) => {
    const url = unescapeHref(href);
    if (url.startsWith(`${worker}/`)) return m; // the Worker's own links (unsubscribe) stay as they are
    links += 1;
    return `href="${clickUrl(url, issueDate)}"`;
  });
  const pixel = `<img src="${worker}/o?i=${issueDate}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : `${html}${pixel}`;
  return { ...issue, html, trackedLinks: links };
}

module.exports = { trackIssue, clickUrl };
