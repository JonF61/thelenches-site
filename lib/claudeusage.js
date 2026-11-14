// lib/claudeusage.js
// What each workflow run spends on the Claude API. Loaded into every step that holds
// ANTHROPIC_API_KEY by NODE_OPTIONS (--require ./lib/claudeusage.js), so no script needs
// changing: it wraps the SDK's messages.create, adds up each response's usage per model,
// and when the process ends hands the totals to scripts/claudeusage (a child process,
// because nothing async can run at exit), which appends one row per model to the Sheet's
// "Claude usage" tab. Raw fetch callers (the diagnostic) call record() themselves.
// Counts and costs only: never a prompt, reply or address. A failure here never fails a job.
'use strict';

// US dollars per million tokens (Anthropic list prices, Nov 2026). Cache writes: 5-minute
// TTL = 1.25x input, 1-hour = 2x; reads as listed. Unknown models are costed as Opus (the
// dearest we use), so the total errs high, never low.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1 },
};
const FALLBACK = 'claude-opus-5-5';

// "claude-haiku-4-5-20251001" -> the claude-haiku-4-5 price.
function priceFor(model) {
  const m = String(model || '').replace(/-\d{8}$/, '');
  return PRICES[m] || PRICES[FALLBACK];
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Dollars for one model's summed usage.
function costOf(model, t) {
  const p = priceFor(model);
  const usd = (n(t.input) * p.input + n(t.output) * p.output + n(t.read) * p.read
    + n(t.write5m) * p.input * 1.25 + n(t.write1h) * p.input * 2) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

const totals = new Map(); // model -> { calls, input, output, read, write5m, write1h }

// Adds one response's usage. Safe with any shape (missing fields count 0).
function record(model, usage) {
  if (!usage || typeof usage !== 'object') return;
  const key = String(model || 'unknown');
  const t = totals.get(key) || { calls: 0, input: 0, output: 0, read: 0, write5m: 0, write1h: 0 };
  const cc = usage.cache_creation || null;
  const w1h = cc ? n(cc.ephemeral_1h_input_tokens) : 0;
  t.calls += 1;
  t.input += n(usage.input_tokens);
  t.output += n(usage.output_tokens);
  t.read += n(usage.cache_read_input_tokens);
  t.write1h += w1h;
  t.write5m += Math.max(0, n(usage.cache_creation_input_tokens) - w1h);
  totals.set(key, t);
}

// One row per model, ready for the tab.
function rows(meta = {}) {
  const at = meta.at || new Date().toISOString();
  return [...totals.entries()].map(([model, t]) => ({
    at,
    job: meta.job || '',
    run: meta.run || '',
    model,
    calls: t.calls,
    input: t.input,
    cache_write: t.write5m + t.write1h,
    cache_read: t.read,
    output: t.output,
    cost_usd: costOf(model, t).toFixed(4),
  }));
}

function reset() { totals.clear(); }

// Wraps messages.create on the SDK's Messages class (every client shares the prototype).
function patchSdk() {
  let Messages;
  try {
    const sdk = require('@anthropic-ai/sdk');
    Messages = (sdk.Anthropic && sdk.Anthropic.Messages) || sdk.Messages;
  } catch {
    return false;
  }
  if (!Messages || !Messages.prototype || Messages.prototype.__usageWrapped) return false;
  const original = Messages.prototype.create;
  Messages.prototype.create = function create(body, ...rest) {
    const p = original.call(this, body, ...rest);
    // A streaming call returns a stream, not a message: left alone (none of ours stream).
    if (p && typeof p.then === 'function' && !(body && body.stream)) {
      p.then((res) => { try { record((res && res.model) || (body && body.model), res && res.usage); } catch { /* never */ } }, () => {});
    }
    return p;
  };
  Messages.prototype.__usageWrapped = true;
  return true;
}

// At exit, if anything was spent, run the writer with the rows on stdin.
function flushAtExit() {
  process.on('exit', () => {
    if (!totals.size) return;
    try {
      const { spawnSync } = require('child_process');
      const path = require('path');
      const meta = { job: process.env.GITHUB_WORKFLOW || path.basename(process.argv[1] || 'local'), run: process.env.GITHUB_RUN_ID || '' };
      spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'claudeusage', 'index.js')], {
        input: JSON.stringify(rows(meta)),
        env: { ...process.env, CLAUDE_USAGE_CHILD: '1', NODE_OPTIONS: '' },
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: 60000,
      });
    } catch { /* never fail the job */ }
  });
}

// Active only when preloaded in a workflow step (or asked for), never in tests or the child.
if (!process.env.CLAUDE_USAGE_CHILD && (process.env.GITHUB_ACTIONS || process.env.CLAUDE_USAGE_ON) && !process.env.CLAUDE_USAGE_OFF) {
  patchSdk();
  flushAtExit();
}

module.exports = { PRICES, priceFor, costOf, record, rows, reset, patchSdk };
