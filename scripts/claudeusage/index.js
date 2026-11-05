// scripts/claudeusage/index.js
// Writer for lib/claudeusage.js: reads the run's usage rows (JSON on stdin) and appends
// them to the Sheet's "Claude usage" tab (made here if missing; code alone writes it).
// Columns: at, job, run, model, calls, input, cache_write, cache_read, output, cost_usd.
// Counts and dollars only. Always exits 0: a missed row must never fail a workflow.
'use strict';

const TAB = 'Claude usage';
const HEADERS = ['at', 'job', 'run', 'model', 'calls', 'input', 'cache_write', 'cache_read', 'output', 'cost_usd'];

function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  let rows;
  try {
    rows = JSON.parse(readStdin() || '[]');
  } catch {
    rows = [];
  }
  rows = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && r.model);
  if (!rows.length) return;
  const g = require('../ingest/google');
  await g.ensureTab(TAB, HEADERS);
  await g.appendRows(TAB, rows);
  const total = rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  console.log(`Claude usage: ${rows.reduce((s, r) => s + Number(r.calls || 0), 0)} calls, $${total.toFixed(4)} (logged to ${TAB}).`);
}

if (require.main === module) {
  main().catch((e) => console.log(`Claude usage not logged: ${e.message}`)).finally(() => process.exit(0));
}

module.exports = { TAB, HEADERS };
