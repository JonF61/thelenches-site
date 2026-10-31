// scripts/contacts/index.js
// Contacts run (contacts.yml): reads email to website@ (an alias of GMAIL_USER), keeps one
// Contacts row per person who writes in, with a Claude-written profile and what they have
// contributed (from the Pending tab). Creates the tab if missing.
//   FULL=true    read all mail to website@ (the first backfill, or a rebuild)
//   otherwise    mail from the last SINCE_DAYS days (default 8)
//   DRY_RUN=true count only: no Claude calls, no Sheet writes
//   RECLASSIFY=true  one-off: no mail read; Claude picks a status for every row whose status is
//                still a phase-1 one (blank, contributor, lead, dormant) from what the row holds;
//                "none" is written as "not a contributor" for Jon to review and delete
// Mail from before contacts.js CUTOFF, or from a deleted contact's address before its deletion
// (Deleted contacts tab, written by the admin panel), is never read. A new sender is added
// only if Claude places them (status other than "none"). A row's other_emails (typed by Jon)
// are the same person: mail and Pending items from them count on that row.
// Logs may be public: they print counts only, never names, addresses or profiles.
'use strict';

const g = require('../ingest/google');
const { subscribeContacts } = require('../ingest/subscriptions');
const c = require('./contacts');
const { profileFor, classifyFor } = require('./profile');

const truthy = (v) => /^(true|yes|y|1)$/i.test(String(v ?? '').trim());

function nowUk() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}

async function readDeleted() {
  try {
    return c.deletedMap(await g.readTable(c.DELETED_TAB));
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) return new Map(); // no deletions yet
    throw err;
  }
}

// One-off: a status for every row still on a phase-1 status. Counts only in the log.
async function reclassify(dry) {
  const rows = await g.readTable(c.TAB);
  const stamp = nowUk();
  const counts = {};
  let failed = 0;
  for (const r of rows) {
    if (!c.norm(r.email) || c.locked(r) || !c.OLD_AUTO.includes(c.norm(r.status))) continue;
    if (dry) { counts.candidates = (counts.candidates || 0) + 1; continue; }
    try {
      const s = await classifyFor(r);
      const status = s === 'none' ? 'not a contributor' : s;
      counts[status] = (counts[status] || 0) + 1;
      if (status !== c.norm(r.status)) await g.updateRow(c.TAB, r._row, { status, updated_at: stamp });
    } catch (err) {
      failed++;
      console.log(`Classify failed (${err.message.slice(0, 120)}); row left as it was.`);
    }
  }
  console.log(`Reclassify${dry ? ' (dry run: nothing written)' : ''}: ${JSON.stringify(counts)}, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

async function main() {
  const full = truthy(process.env.FULL);
  const dry = truthy(process.env.DRY_RUN);
  if (truthy(process.env.RECLASSIFY)) return reclassify(dry);
  const sinceDays = Number(process.env.SINCE_DAYS) || 8;
  // website@ is an alias: match it in any header, plus the Pipeline label (Bcc'd mail).
  const W = c.WEBSITE;
  const within = `-in:sent -in:chats -in:drafts after:${c.CUTOFF.replace(/-/g, '/')}${full ? '' : ` newer_than:${sinceDays}d`}`;
  const deleted = await readDeleted();
  const ids = await g.searchAllMessageIds(`{to:${W} cc:${W} deliveredto:${W} label:Pipeline} ${within}`);
  const labelled = new Set(await g.searchAllMessageIds(`label:Pipeline ${within}`));
  const counted = [];
  const skipped = {};
  for (const id of ids) {
    const msg = await g.getMessage(id);
    const why = c.skipReason(msg, labelled.has(id)) || c.tooOld(msg, deleted);
    if (why) skipped[why] = (skipped[why] || 0) + 1;
    else counted.push(msg);
  }
  const bySender = c.groupBySender(counted);
  console.log(`${full ? 'Full' : `Last ${sinceDays} days`}: ${ids.length} messages, ${counted.length} counted from ${bySender.size} senders.`);
  console.log(`Skipped: ${JSON.stringify(skipped)}`);

  if (!dry) await g.ensureTab(c.TAB, c.HEADERS);
  const existingRows = dry ? await g.readTable(c.TAB).catch(() => []) : await g.readTable(c.TAB);
  const pending = await g.readTable('Pending');
  const byAddress = c.rowsByAddress(existingRows);
  // One sender per row: mail from a row's other_emails joins the row's own.
  const senders = c.joinSenders(bySender, byAddress);
  const stamp = nowUk();

  const adds = [];
  const updates = [];
  let profiled = 0;
  let failed = 0;
  let ignored = 0;
  let notContributors = 0;

  for (const sender of senders.values()) {
    const existing = byAddress.get(sender.email) || null;
    if (c.locked(existing)) { ignored++; continue; }
    const contrib = c.contributionsFor(existing ? c.addressesOf(existing) : sender.email, pending, g.addressOf);
    const fresh = existing
      ? sender.messages.filter((m) => !existing.last_contact || c.ymd(m.internalDate) > existing.last_contact)
      : sender.messages;
    const auto = !existing || c.norm(existing.profile_source) === 'auto';
    let profile = null;
    if (auto && (full || fresh.length) && !dry) {
      try {
        profile = await profileFor(sender, existing, contrib.list);
        profiled++;
      } catch (err) {
        failed++;
        console.log(`Profile failed (${err.message.slice(0, 120)}); ${existing ? 'row kept without it' : 'not added this run'}.`);
      }
    }
    // A new sender goes on the list only once Claude has placed them (a later run retries a failure).
    if (!existing && !dry && !c.shouldAdd(profile)) {
      if (profile) notContributors++;
      continue;
    }
    const row = c.mergeRow(existing, sender, contrib, profile, stamp);
    if (existing) updates.push({ rowNumber: existing._row, row });
    else adds.push(row);
  }

  // Ignore rows: cleared to email and status, so nothing about them is kept.
  let cleared = 0;
  for (const ex of existingRows) {
    const clear = c.locked(ex) && c.clearIgnored(ex);
    if (clear) { updates.push({ rowNumber: ex._row, row: clear }); cleared++; }
  }

  // Contributions may have changed for people who didn't write this time (status never does).
  for (const ex of existingRows) {
    const email = c.norm(ex.email);
    if (!email || senders.has(email) || c.locked(ex)) continue;
    const contrib = c.contributionsFor(c.addressesOf(ex), pending, g.addressOf);
    if (String(contrib.count) !== String(ex.contribution_count || 0) || contrib.list !== String(ex.contributions || '')) {
      updates.push({ rowNumber: ex._row, row: { contributions: contrib.list, contribution_count: contrib.count, updated_at: stamp } });
    }
  }

  console.log(`${adds.length} new, ${updates.length} updated, ${ignored} ignored, ${notContributors} not contributors (not added), ${cleared} ignore rows cleared, ${profiled} profiles written, ${failed} failed${dry ? ' (dry run: nothing written)' : ''}.`);
  if (dry) return;
  for (const u of updates) await g.updateRow(c.TAB, u.rowNumber, u.row);
  if (adds.length) await g.appendRows(c.TAB, adds);

  // Every contact gets the newsletter unless they've unsubscribed (Jon, 31 Oct): each
  // row's own address (not ignore rows, not other_emails) is added to Subscribers.
  try {
    const addresses = [...existingRows.filter((r) => !c.locked(r)), ...adds].map((r) => r.email);
    const r = await subscribeContacts(addresses, stamp);
    console.log(`Newsletter: ${r.added} contacts added to Subscribers, ${r.already} already there, ${r.offList} unsubscribed (left off), ${r.unusable} unusable.`);
  } catch (err) {
    failed++;
    console.log(`Adding contacts to Subscribers failed: ${err.message.slice(0, 160)}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
