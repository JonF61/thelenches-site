// scripts/ingest/links.js
// Signed links, verified by the Cloudflare Worker with the same key.
// Format: base64url(JSON).base64url(HMAC-SHA256), matching scripts/digest/index.js.
'use strict';

const crypto = require('crypto');
const { siteName } = require('../../lib/site');

const LINK_DAYS = 14; // approve/reject links expire after this

function workerUrl() {
  return String(process.env.WORKER_URL || '').replace(/\/+$/, '');
}

function linksEnabled() {
  return Boolean(process.env.APPROVAL_SIGNING_KEY && workerUrl());
}

// Any payload ({ a, i, e, ... }) as a Worker URL. route: "/a" (actions) or "/u" (unsubscribe).
// An action, unsubscribe or click link made by another site's run names that site (s), so the
// Worker sends the decision or unsubscribe to that site's run and counts the click for it
// (Harvington stages 4c and 5a); Lenches links stay as they were.
const SITE_ROUTES = ['/a', '/u', '/c', '/s', '/r', '/sg'];
function signToken(payload, route = '/a') {
  const site = siteName();
  if (SITE_ROUTES.includes(route) && site !== 'lenches' && payload.s === undefined) payload = { ...payload, s: site };
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

// "Trust this source" (daily approvals email). k is the sender address or feed URL,
// shown on the Worker's confirm page; scripts/approve works it out again from the row.
function trustLink(item, sourceKey) {
  return signToken({
    i: item.id,
    a: 'trust',
    t: String(item.title || '').slice(0, 80),
    k: String(sourceKey || '').slice(0, 300),
    e: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400,
  });
}

// Edit form for a reply draft (Worker /a, action "edit", part 2). The draft travels in the
// signed token so the form can show it; '' if the link would be too long for some mail
// apps (the action email then offers Edit by email only).
const MAX_EDIT_URL = 2000;
function editFormLink(row) {
  const url = signToken({
    i: row.reply_id,
    a: 'edit',
    t: `Reply to ${row.to}`.slice(0, 80),
    b: String(row.body || ''),
    e: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400,
  });
  return url.length <= MAX_EDIT_URL ? url : '';
}

// Redraft page for a reply draft (Worker /a, action "redraft"). Like editFormLink, the draft
// travels in the signed token so the page can show it above the instruction box (26 Oct);
// if that would make the link too long, the link goes without it (the page then just asks).
function redraftLink(row) {
  const base = { i: row.reply_id, a: 'redraft', t: `Reply to ${row.to}`.slice(0, 80), e: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400 };
  const url = signToken({ ...base, b: String(row.body || '') });
  return url.length <= MAX_EDIT_URL ? url : signToken(base);
}

module.exports = { signedLink, trustLink, editFormLink, redraftLink, signToken, linksEnabled, workerUrl, LINK_DAYS };
