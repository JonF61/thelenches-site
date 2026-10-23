// scripts/newsletter/waitruns.js
// Rebuild safety (23 Oct). Runs in newsletter.yml's build job before the issue is built
// (Rebuild button or the Thursday build). A build started while "Apply approval"
// (approval.yml) or "Publish to site" (publish.yml) is queued or running misses those
// decisions, and new images go out text only until publish has made the JPEG. So:
//   - polls the GitHub API every 30 seconds while any such run is queued or in progress,
//     for up to 10 minutes. After the last one finishes it checks once more, 30 seconds
//     later, for the publish run a finished approval starts.
//   - if it waited, brings the checkout up to date with main (publish commits there).
//   - still running after 10 minutes: builds anyway, and writes BUILD_WAIT_NOTE to
//     $GITHUB_ENV; index.js shows it on the preview only (never the subscriber copy, and
//     not in the content hash).
//   - API call fails: logs a warning and the build goes ahead as before.
// Always exits 0. Env (set by Actions): GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY,
// GITHUB_API_URL, GITHUB_ENV.
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const WORKFLOWS = [
  { file: 'approval.yml', name: 'Apply approval' },
  { file: 'publish.yml', name: 'Publish to site' },
];
const EVERY_MS = 30 * 1000;
const MAX_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Runs of the watched workflows that haven't completed (queued, in progress, waiting...).
async function activeRuns({ fetchFn = fetch, env = process.env } = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('GITHUB_TOKEN or GITHUB_REPOSITORY not set');
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const out = [];
  for (const wf of WORKFLOWS) {
    const res = await fetchFn(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${wf.file}/runs?per_page=50`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`${wf.file}: GitHub API ${res.status}`);
    const body = await res.json();
    for (const r of body.workflow_runs || []) {
      if (r.status !== 'completed') out.push({ id: r.id, name: wf.name, status: String(r.status).replace(/_/g, ' '), url: r.html_url });
    }
  }
  return out;
}

const describe = (runs) => runs.map((r) => `${r.name} (${r.status})`).join(', ');
const names = (runs) => [...new Set(runs.map((r) => r.name))].join(', ');

// Returns { seen: runs waited for, still: runs still going at the end, error: message or '' }.
async function waitForRuns({ fetchFn, env, wait = sleep, now = Date.now, log = console.log,
  everyMs = EVERY_MS, maxMs = MAX_MS } = {}) {
  const start = now();
  const seen = new Map();
  let settled = false;
  for (;;) {
    let runs;
    try {
      runs = await activeRuns({ fetchFn, env });
    } catch (err) {
      const error = (err && err.message) || String(err);
      console.warn(`Warning: couldn't check for approval and publish runs (${error}); building now.`);
      return { seen: [...seen.values()], still: [], error };
    }
    runs.forEach((r) => seen.set(r.id, r));
    const timeLeft = now() - start + everyMs <= maxMs;
    if (!runs.length) {
      if (seen.size && !settled && timeLeft) {
        settled = true;
        log('Those runs have finished; checking once more in 30 seconds for a publish run they start.');
        await wait(everyMs);
        continue;
      }
      log(seen.size ? `Waited for: ${names([...seen.values()])} (${seen.size} run(s), ${Math.round((now() - start) / 1000)}s). None left; building.`
        : 'No approval or publish runs queued or in progress; building.');
      return { seen: [...seen.values()], still: [], error: '' };
    }
    settled = false;
    if (!timeLeft) {
      log(`Still in progress after ${Math.round(maxMs / 60000)} minutes: ${describe(runs)}. Building anyway (preview carries a warning).`);
      return { seen: [...seen.values()], still: runs, error: '' };
    }
    log(`Waiting for: ${describe(runs)}.`);
    await wait(everyMs);
  }
}

// The preview banner line for runs still going.
function waitNote(still) {
  const names = [...new Set(still.map((r) => `${r.name} (${r.status})`))];
  return `Built while ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} still running after a 10 minute wait, `
    + 'so a decision or image may be missing. Tap Rebuild once they have finished.';
}

async function main() {
  const result = await waitForRuns();
  if (result.seen.length) {
    try {
      execFileSync('git', ['fetch', '--depth=1', 'origin', 'main'], { stdio: 'inherit' });
      execFileSync('git', ['reset', '--hard', 'FETCH_HEAD'], { stdio: 'inherit' });
      console.log('Checkout updated to the latest main.');
    } catch (err) {
      console.warn(`Warning: couldn't update the checkout to the latest main: ${(err && err.message) || err}`);
    }
  }
  if (result.still.length && process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `BUILD_WAIT_NOTE=${waitNote(result.still)}\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.warn(`Warning: run check failed (${(err && err.message) || err}); building now.`);
  });
}

module.exports = { activeRuns, waitForRuns, waitNote };
