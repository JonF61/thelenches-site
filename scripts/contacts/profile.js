// scripts/contacts/profile.js
// Claude reads one sender's emails to website@ (plus what we already know) and returns
// { name, organisation, village, role, profile } for the Contacts tab.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_CHARS_PER_MESSAGE = 3000;
const MAX_CHARS = 24000;

const SYSTEM = `You keep the contact list for a volunteer-run community website and weekly newsletter for the Lenches villages in Worcestershire (Church, Rous, Ab, Atch and Sheriffs Lench, plus Harvington). People email website@ with events, notices, photos, questions and news.

From one person's emails, record who they are and a short profile that helps the team deal with them well. British English, plain and factual, kind. Use only what the emails show; leave a field empty rather than guess. Never record health, religious belief beyond a church role, politics, money troubles or other sensitive personal details, and nothing about third parties.

profile: 2-4 sentences covering what they usually send (and for which group), how often or in what season, how they like to send it (e.g. flyers as PDF, photos, plain text), anything they asked us to do or avoid, and the tone of the relationship. Do not repeat their name or email address.`;

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
    },
    required: ['name', 'organisation', 'village', 'role', 'profile'],
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

module.exports = { profileFor, buildText };
