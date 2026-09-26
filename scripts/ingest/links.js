// scripts/ingest/links.js
// Signed Approve/Reject links, verified by the Cloudflare Worker with the same key.
// Format: base64url(JSON).base64url(HMAC-SHA256), matching scripts/digest/index.js.
'use strict';

const crypto = require('crypto');

const LINK_DAYS = 14; // links expire after this

function workerUrl() {
  return String(process.env.WORKER_URL || '').replace(/\/+$/, '');
}

function linksEnabled() {
  return Boolean(process.env.APPROVAL_SIGNING_KEY && workerUrl());
}

function signedLink(item, action) {
  const payload = {
    i: item.id,
    a: action,
    t: String(item.title || '').slice(0, 80),
    e: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.APPROVAL_SIGNING_KEY).update(body).digest('base64url');
  return `${workerUrl()}/a?t=${body}.${sig}`;
}

module.exports = { signedLink, linksEnabled, LINK_DAYS };
