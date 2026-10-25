// scripts/contacts/profile.js
// Claude reads one sender's emails to website@ (plus what we already know) and returns
// { name, organisation, village, role, profile, status } for the Contacts tab.
// classifyFor (the one-off RECLASSIFY run) picks a status from what the row already holds.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_CHARS_PER_MESSAGE = 3000;
const MAX_CHARS = 24000;

// What each status means (shared by both prompts). "none" = not for the list at all.
const STATUS_GUIDE = `status: what this person is to the website and newsletter. Pick the ONE that fits best; the first five describe who they are, so prefer them over contributor when they fit.
- official: a parish or county council, councillor, police or another official body.
- organiser: runs or speaks for a club, church group, village hall or regular event.
- business: a local business, trade or shop.
- media: another newsletter, a Facebook group admin, local press or radio.
- collaborator: helps run or improve the website or newsletter (proofreading, sharing it, helping with content), beyond sending their own items.
- contributor: sends events, notices, news or photos for us in a personal capacity.
- lead: likely to contribute but has not yet (offered to, or is part of a group whose events we would carry).
- other: has a real reason to be on a list of people who supply or could supply content, but fits none of the above.
- none: wrote only to subscribe or unsubscribe, ask a question, complain, report a problem with the site, or about something else; not a contributor or potential one. Such people are not kept.`;
const STATUS_ENUM = ['official', 'organiser', 'business', 'media', 'collaborator', 'contributor', 'lead', 'other', 'none'];

const SYSTEM = `You keep the contact list for a volunteer-run community website and weekly newsletter for the Lenches villages in Worcestershire (Church, Rous, Ab, Atch and Sheriffs Lench, plus Harvington). People email website@ with events, notices, photos, questions and news.

From one person's emails, record who they are and a short profile that helps the team deal with them well. British English, plain and factual, kind. Use only what the emails show; leave a field empty rather than guess. Never record health, religious belief beyond a church role, politics, money troubles or other sensitive personal details, and nothing about third parties.

profile: 2-4 sentences covering what they usually send (and for which group), how often or in what season, how they like to send it (e.g. flyers as PDF, photos, plain text), anything they asked us to do or avoid, and the tone of the relationship. Do not repeat their name or email address.

${STATUS_GUIDE}`;

const TOOL = {
  name: 'record_contact',
  description: 'Record the contact details and profile.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Full name as they sign, or "" if unknown. For an organisation-only mailbox, the person who signs, else "".' },
      organisation: { type: 'string', description: 'Group, club, church, council or business they write for; "" if just themselves.' },
      village: { type: 'string', description: 'Their village or town if stated, else "".' },
      role: { type: 'string', description: 'Their role, e.g. "secretary, Lenches Club"; "" if unknown.' },
      profile: { type: 'string' },
      status: { type: 'string', enum: STATUS_ENUM },
    },
    required: ['name', 'organisation', 'village', 'role', 'profile', 'status'],
  },
};

let client;

function buildText(sender, existing, contributions) {
  const parts = [`Sender address: ${sender.email}`, `Display name: ${sender.name || '(none)'}`];
  if (existing && existing.profile) {
    parts.push(`What we already recorded (update it with the new emails):\nname: ${existing.name}\norganisation: ${existing.organisation}\nvillage: ${existing.village}\nrole: ${existing.role}\nprofile: ${existing.profile}`);
  }
  if (contributions) parts.push(`Items the pipeline took from their emails (newest first): ${contributions}`);
  let budget = MAX_CHARS;
  const msgs = [];
  for (const m of [...sender.messages].reverse()) { // newest first within the budget
    const body = String(m.text || '').slice(0, MAX_CHARS_PER_MESSAGE);
    const block = `--- ${new Date(m.internalDate).toISOString().slice(0, 10)} | Subject: ${m.subject || '(none)'}${(m.attachments || []).length ? ` | attachments: ${m.attachments.map((a) => a.filename).filter(Boolean).join(', ')}` : ''}\n${body}`;
    if (block.length > budget) break;
    budget -= block.length;
    msgs.unshift(block);
  }
  parts.push(`Their emails (oldest first):\n${msgs.join('\n\n')}`);
  return parts.join('\n\n');
}

async function profileFor(sender, existing, contributions) {
  client = client || new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'record_contact' },
    messages: [{ role: 'user', content: buildText(sender, existing, contributions) }],
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error(`No structured output from Claude (stop_reason: ${res.stop_reason})`);
  return block.input;
}

const CLASSIFY_SYSTEM = `You sort the contact list for a volunteer-run community website and weekly newsletter for the Lenches villages in Worcestershire. From what is recorded about one contact, choose their status. Use only what is recorded; if it is unclear whether they supply content, prefer lead over none.

${STATUS_GUIDE}`;
const CLASSIFY_TOOL = {
  name: 'record_status',
  description: 'Record the contact status.',
  input_schema: { type: 'object', properties: { status: { type: 'string', enum: STATUS_ENUM } }, required: ['status'] },
};

// One existing row -> its status (one of STATUS_ENUM). Reads only the row, never email.
function classifyText(row) {
  return ['name', 'organisation', 'village', 'role', 'profile', 'contributions', 'contribution_count', 'message_count', 'last_contact', 'notes']
    .map((k) => `${k}: ${String(row[k] ?? '').trim() || '(blank)'}`).join('\n');
}

async function classifyFor(row) {
  client = client || new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'record_status' },
    messages: [{ role: 'user', content: classifyText(row) }],
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block || !STATUS_ENUM.includes(block.input.status)) throw new Error(`No status from Claude (stop_reason: ${res.stop_reason})`);
  return block.input.status;
}

module.exports = { profileFor, buildText, classifyFor, classifyText, STATUS_ENUM };
