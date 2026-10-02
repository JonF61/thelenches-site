// scripts/newsletter/unsub.js
// Per-recipient unsubscribe links (step 5b part 3). The token carries an opaque
// subscriber id (HMAC of the address), never the address itself: the repo and its
// Actions logs are public. The Worker's /u endpoint takes one-click POSTs (RFC 8058)
// and footer-link clicks, and fires repository_dispatch "unsubscribe";
// scripts/newsletter/unsubscribe.js matches the id and adds the address to Do Not Send.
'use strict';

const crypto = require('crypto');
const { signToken, linksEnabled } = require('../ingest/links');
const { UNSUB_MARK } = require('./render');

const FROM = 'website@thelenches.org.uk';
const LINK_YEARS = 5;
const PREVIEW_URL = 'https://thelenches.org.uk/privacy/';

function subscriberId(email) {
  if (!process.env.APPROVAL_SIGNING_KEY) throw new Error('APPROVAL_SIGNING_KEY is not set');
  return crypto.createHmac('sha256', process.env.APPROVAL_SIGNING_KEY)
    .update(`unsub:${String(email || '').trim().toLowerCase()}`)
    .digest('base64url')
    .slice(0, 22);
}

function unsubUrl(email) {
  if (!linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY and WORKER_URL are needed for unsubscribe links');
  const e = Math.floor(Date.now() / 1000) + LINK_YEARS * 365 * 86400;
  return signToken({ a: 'unsub', i: subscriberId(email), e }, '/u');
}

// The issue for one recipient: footer link plus List-Unsubscribe headers (one-click + mailto).
function personalise(issue, email) {
  const url = unsubUrl(email);
  return {
    html: issue.html.split(UNSUB_MARK).join(url),
    text: issue.text.split(UNSUB_MARK).join(url),
    headers: {
      'List-Unsubscribe': `<${url}>, <mailto:${FROM}?subject=UNSUBSCRIBE>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

// Preview copies: the footer link goes to the privacy page, so a click unsubscribes nobody.
function forPreview(issue) {
  return {
    ...issue,
    html: issue.html.split(UNSUB_MARK).join(PREVIEW_URL),
    text: issue.text.split(UNSUB_MARK).join(PREVIEW_URL),
  };
}

module.exports = { subscriberId, unsubUrl, personalise, forPreview };
