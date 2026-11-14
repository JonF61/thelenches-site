// scripts/ingest/toolcall.js
// One structured tool call on models that refuse forced tool_choice (Opus 5.5 returns a 400 for
// type "tool" or "any", 2 Nov 2026). Asks with tool_choice "auto" (one call at most) and a plain
// instruction to call the tool; if Claude answers without calling it, asks once more with a
// reminder. Returns { res, block } (block = the tool_use block, or null after both tries).
'use strict';

const reminder = (name) => `Call the ${name} tool now, exactly once. Do not answer in text.`;

function withReminder(messages, name) {
  const out = messages.slice();
  const last = out[out.length - 1];
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
  content.push({ type: 'text', text: reminder(name) });
  out[out.length - 1] = { ...last, content };
  return out;
}

async function callTool(client, req, name) {
  const base = { ...req, tool_choice: { type: 'auto', disable_parallel_tool_use: true } };
  let res = await client.messages.create({ ...base, messages: withReminder(req.messages, name) });
  let block = res.content.find((b) => b.type === 'tool_use' && b.name === name) || null;
  if (!block && res.stop_reason !== 'max_tokens' && res.stop_reason !== 'refusal') {
    res = await client.messages.create({ ...base, messages: withReminder(withReminder(req.messages, name), name) });
    block = res.content.find((b) => b.type === 'tool_use' && b.name === name) || null;
  }
  return { res, block };
}

module.exports = { callTool, withReminder };
