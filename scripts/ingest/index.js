// scripts/ingest/index.js
// Ingestion run: Gmail "Pipeline" label -> Claude extraction -> Pending tab.
// Gmail is read-only; processed messages are recorded in the Log tab.
// Nothing is committed to the repo and nothing is sent by this script.
'use strict';

const g = require('./google');
const { extract } = require('./extract');
const { prepareAttachments, hashDistance } = require('./images');

const MAX_RETRIES = 3;            // after this, a failing message is left for the diagnostic
const MAX_MESSAGES_PER_RUN = 25;  // caps run time and spend; the rest wait for the next run
const REPEAT_HASH_DISTANCE = 10;  // image hashes this close count as the same picture
const LOW_CONFIDENCE = 0.5;       // auto sources below this go to approval (except holiday mode)
const TZ = 'Europe/London';

/* ---------------------------------------------------------------- dates -- */

function londonDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms); // YYYY-MM-DD
}

function londonDateTime(ms) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${londonDate(ms)} ${time}`;
}

function londonOffsetMinutes(ms) {
  const tz = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName').value; // "GMT" or "GMT+1"
  const m = tz.match(/GMT([+-]\d+)/);
  return m ? Number(m[1]) * 60 : 0;
}

// Accepts 2026-10-15 or 15/10/2026 (in case the Sheet reformats the date).
function parseYmd(value) {
  const v = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

function londonMidnightEpoch(ymd) {
  const utc = Date.parse(`${ymd}T00:00:00Z`);
  return Math.floor((utc - londonOffsetMinutes(utc) * 60000) / 1000);
}

/* ------------------------------------------------------------- matching -- */

// Sender first, so e.g. a Wychavon email forwarded via website@ counts as Wychavon.
function matchSource(msg, sources) {
  const from = msg.from.toLowerCase();
  const recipients = msg.recipients.toLowerCase();
  return sources.find((s) => from.includes(s.match))
    || sources.find((s) => recipients.includes(s.match))
    || null;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findRepeat(item, hash, existing) {
  const t = normTitle(item.title);
  for (const row of existing) {
    if (hash && row.image_hash && hashDistance(hash, row.image_hash) <= REPEAT_HASH_DISTANCE) {
      return { row, byImage: true };
    }
    const rt = normTitle(row.title);
    const titleMatch = t && rt && (t === rt
      || ((t.includes(rt) || rt.includes(t)) && Math.min(t.length, rt.length) >= 12));
    const dateMatch = !item.event_date || !row.event_date || item.event_date === row.event_date;
    if (titleMatch && dateMatch) return { row, byImage: false };
  }
  return null;
}

function decideStatus(item, mode, holiday) {
  if (item.people_in_image || item.political_commercial) return 'pending'; // always a human decision
  if (holiday) return 'auto';
  if (mode === 'auto' && item.confidence >= LOW_CONFIDENCE) return 'auto';
  return 'pending';
}

/* -------------------------------------------------------------- process -- */

async function processMessage(id, ctx) {
  const msg = await g.getMessage(id);
  const received = londonDateTime(msg.internalDate);
  const source = matchSource(msg, ctx.sources);
  if (!source) {
    return { status: 'skipped', received, source: '', items: 0, error: 'No matching source in Settings' };
  }
  if (source.mode === 'ignore') {
    return { status: 'skipped', received, source: source.source, items: 0, error: 'Source set to ignore' };
  }

  const { images, pdfs, notes } = await prepareAttachments(
    msg.attachments,
    (att) => g.getAttachmentData(msg.id, att)
  );
  const result = await extract({
    msg, sourceName: source.source, receivedIso: received, today: ctx.today, images, pdfs,
  });
  ctx.tokensIn += (result.usage && result.usage.input_tokens) || 0;
  ctx.tokensOut += (result.usage && result.usage.output_tokens) || 0;

  const link = g.gmailLink(msg);
  const rows = result.items.map((item, n) => {
    const img = item.image_index >= 0 ? images[item.image_index] : null;
    const repeat = findRepeat(item, img && img.hash, ctx.existing);
    const noteParts = [item.notes, ...notes];
    if (repeat) {
      noteParts.push(`Possible repeat of ${repeat.row.id} (${repeat.byImage ? 'same image' : 'same title/date'})`);
    }
    return {
      id: `${msg.id}-${n + 1}`,
      received,
      source: source.source,
      from: msg.from,
      subject: msg.subject,
      title: item.title,
      event_date: item.event_date,
      event_time: item.event_time,
      village: item.village,
      category: item.category,
      summary: item.summary,
      cost: item.cost,
      contact: item.contact,
      link_text: item.link_text,
      link_url: item.link_url,
      confidence: item.confidence,
      urgent: item.urgent,
      people_in_image: item.people_in_image,
      political_commercial: item.political_commercial,
      possible_repeat: Boolean(repeat),
      image_part_id: img ? img.partId : '',
      image_filename: img ? img.filename : '',
      image_hash: img ? img.hash : '',
      alt_text: item.alt_text,
      image_url: '',
      gmail_link: link,
      status: decideStatus(item, source.mode, ctx.holiday),
      // Resubmitting doesn't reset limits: carry counts over from the earlier item.
      newsletter_count: repeat ? Number(repeat.row.newsletter_count) || 0 : 0,
      flyer_count: repeat && repeat.byImage ? Number(repeat.row.flyer_count) || 0 : 0,
      message_id: msg.id,
      notes: noteParts.filter(Boolean).join(' | '),
    };
  });

  if (rows.length) await g.appendRows('Pending', rows);
  rows.forEach((r) => ctx.existing.push(r)); // later emails in this run can match these

  return {
    status: 'ok',
    received,
    source: source.source,
    items: rows.length,
    error: rows.length ? '' : `No items: ${result.skipReason || 'none found'}`,
  };
}

async function main() {
  const { sources, settings } = await g.readSettings();
  const override = process.env.START_DATE_OVERRIDE || '';
  const startYmd = parseYmd(override) || parseYmd(settings.start_date);
  if (!startYmd) throw new Error(`Invalid start date: "${override || settings.start_date}"`);
  const holiday = String(settings.holiday_mode || '').toUpperCase() === 'TRUE';

  const logRows = await g.readTable('Log');
  const logById = new Map(logRows.map((r) => [r.message_id, r]));
  const existing = await g.readTable('Pending');

  const ids = (await g.listMessageIds(process.env.GMAIL_LABEL || 'Pipeline', londonMidnightEpoch(startYmd)))
    .reverse(); // oldest first
  const todo = ids.filter((id) => {
    const r = logById.get(id);
    return !r || (r.status === 'error' && (Number(r.retries) || 0) < MAX_RETRIES);
  });
  const batch = todo.slice(0, MAX_MESSAGES_PER_RUN);

  console.log(`Start ${startYmd}${override ? ' (override)' : ''}, holiday mode ${holiday ? 'ON' : 'off'}.`);
  console.log(`${ids.length} labelled, ${todo.length} to process, ${batch.length} this run.`);

  const ctx = { sources, holiday, existing, today: londonDate(Date.now()), tokensIn: 0, tokensOut: 0 };
  let failed = 0;
  let gaveUp = 0;

  for (const id of batch) {
    const prev = logById.get(id);
    const prevRetries = prev ? Number(prev.retries) || 0 : 0;
    let outcome;
    try {
      outcome = await processMessage(id, ctx);
      outcome.retries = prevRetries;
    } catch (err) {
      const retries = prevRetries + 1;
      failed += 1;
      if (retries >= MAX_RETRIES) gaveUp += 1;
      outcome = {
        status: 'error',
        received: prev ? prev.received : '',
        source: prev ? prev.source : '',
        items: 0,
        error: String((err && err.message) || err).slice(0, 500),
        retries,
      };
      console.error(`${id}: ${outcome.error}`);
    }
    const fields = {
      message_id: id,
      received: outcome.received,
      processed_at: londonDateTime(Date.now()),
      source: outcome.source,
      status: outcome.status,
      items_created: outcome.items,
      error: outcome.error,
      retries: outcome.retries,
    };
    if (prev) await g.updateRow('Log', prev._row, fields);
    else await g.appendRows('Log', [fields]);
    console.log(`${id}: ${outcome.status}, ${outcome.items} item(s)${outcome.error ? ` — ${outcome.error}` : ''}`);
  }

  console.log(`Done. ${failed} failed. Claude tokens: ${ctx.tokensIn} in, ${ctx.tokensOut} out.`);
  if (todo.length > batch.length) console.log(`${todo.length - batch.length} left for the next run.`);
  if (gaveUp) {
    // Fails the run so GitHub emails an alert; the message won't be retried again.
    console.error(`${gaveUp} message(s) failed ${MAX_RETRIES} times and need attention.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
