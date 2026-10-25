// scripts/contacts/index.js
// Contacts run (contacts.yml): reads email to website@ (an alias of GMAIL_USER), keeps one
// Contacts row per person who writes in, with a Claude-written profile and what they have
// contributed (from the Pending tab). Creates the tab if missing.
//   FULL=true    read all mail to website@ (the first backfill, or a rebuild)
//   otherwise    mail from the last SINCE_DAYS days (default 8)
//   DRY_RUN=true count only: no Claude calls, no Sheet writes
// Logs may be public: they print counts only, never names, addresses or profiles.
'use strict';

const g = require('../ingest/google');
const c = require('./contacts');
const { profileFor } = require('./profile');

const truthy = (v) => /^(true|yes|y|1)$/i.test(String(v ?? '').trim());

function nowUk() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}

async function main() {
  const full = truthy(process.env.FULL);
  const dry = truthy(process.env.DRY_RUN);
  const sinceDays = Number(process.env.SINCE_DAYS) || 8;
  // website@ is an alias: match it in any header, plus the Pipeline label (Bcc'd mail).
  const W = c.WEBSITE;
  const within = `-in:sent -in:chats -in:drafts${full ? '' : ` newer_than:${sinceDays}d`}`;
  const ids = await g.searchAllMessageIds(`{to:${W} cc:${W} deliveredto:${W} label:Pipeline} ${within}`);
  const labelled = new Set(await g.searchAllMessageIds(`label:Pipeline ${within}`));
  const counted = [];
  const skipped = {};
  for (const id of ids) {
    const msg = await g.getMessage(id);
    const why = c.skipReason(msg, labelled.has(id));
    if (why) skipped[why] = (skipped[why] || 0) + 1;
    else counted.push(msg);
  }
  const senders = c.groupBySender(counted);
  console.log(`${full ? 'Full' : `Last ${sinceDays} days`}: ${ids.length} messages, ${counted.length} counted from ${senders.size} senders.`);
  console.log(`Skipped: ${JSON.stringify(skipped)}`);

  if (!dry) await g.ensureTab(c.TAB, c.HEADERS);
  const existingRows = dry ? await g.readTable(c.TAB).catch(() => []) : await g.readTable(c.TAB);
  const pending = await g.readTable('Pending');
  const byEmail = new Map(existingRows.map((r) => [c.norm(r.email), r]));
  const stamp = nowUk();

  const adds = [];
  const updates = [];
  let profiled = 0;
  let failed = 0;
  let ignored = 0;

  for (const sender of senders.values()) {
    const existing = byEmail.get(sender.email) || null;
    if (c.locked(existing)) { ignored++; continue; }
    const contrib = c.contributionsFor(sender.email, pending, g.addressOf);
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
        console.log(`Profile failed (${err.message.slice(0, 120)}); row kept without it.`);
      }
    }
    const row = c.mergeRow(existing, sender, contrib, profile, stamp);
    if (existing) updates.push({ rowNumber: existing._row, row });
    else adds.push(row);
  }

  // Contributions or status (dormant) may have changed for people who didn't write this time.
  for (const ex of existingRows) {
    const email = c.norm(ex.email);
    if (!email || senders.has(email) || c.locked(ex)) continue;
    const contrib = c.contributionsFor(email, pending, g.addressOf);
    const status = c.statusFor(ex.status, contrib.count, ex.last_contact, c.ymd(Date.now()));
    if (status || String(contrib.count) !== String(ex.contribution_count || 0) || contrib.list !== String(ex.contributions || '')) {
      const row = { contributions: contrib.list, contribution_count: contrib.count, updated_at: stamp };
      if (status) row.status = status;
      updates.push({ rowNumber: ex._row, row });
    }
  }

  console.log(`${adds.length} new, ${updates.length} updated, ${ignored} ignored, ${profiled} profiles written, ${failed} failed${dry ? ' (dry run: nothing written)' : ''}.`);
  if (dry) return;
  for (const u of updates) await g.updateRow(c.TAB, u.rowNumber, u.row);
  if (adds.length) await g.appendRows(c.TAB, adds);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
