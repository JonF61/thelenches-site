// scripts/ingest/links.js
// Signed links, verified by the Cloudflare Worker with the same key.
// Format: base64url(JSON).base64url(HMAC-SHA256), matching scripts/digest/index.js.
'use strict';

const crypto = require('crypto');

const LINK_DAYS = 14; // approve/reject links expire after this

function workerUrl() {
  return String(process.env.WORKER_URL || '').replace(/\/+$/, '');
}

function linksEnabled() {
  return Boolean(process.env.APPROVAL_SIGNING_KEY && workerUrl());
}

// Any payload ({ a, i, e, ... }) as a Worker URL. route: "/a" (actions) or "/u" (unsubscribe).
function signToken(payload, route = '/a') {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.APPROVAL_SIGNING_KEY).update(body).digest('base64url');
  return `${workerUrl()}${route}?t=${body}.${sig}`;
}

function signedLink(item, action) {
  return signToken({
    i: item.id,
    a: action,
    t: String(item.title || '').slice(0, 80),
    e: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400,
  });
}

module.exports = { signedLink, signToken, linksEnabled, workerUrl, LINK_DAYS };
