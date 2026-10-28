// worker/src/admin/runs.js
// GitHub Actions runs, read-only, for the panel's Activity screen and Edit page's
// "Building… / Live" status. Nothing here starts, re-runs or cancels a run.
//   recentRuns(env, n)        the latest n runs of every workflow, newest first
//   buildStatus(env, sha, at) whether a commit (an Edit page save) is live yet

import { github } from '../core.js';

// Plain names for the workflow files; anything else shows GitHub's own name.
export const WORKFLOW_NAMES = {
  'build.yml': 'Build site',
  'ingest.yml': 'Ingest',
  'publish.yml': 'Publish',
  'approval.yml': 'Apply approval',
  'newsletter.yml': 'Newsletter',
  'newsletter-draft.yml': 'Newsletter draft',
  'deploy-worker.yml': 'Deploy Worker',
  'digest.yml': 'Digest',
  'daily-approvals.yml': 'Daily approvals email',
  'diagnostic.yml': 'Diagnostic',
  'contacts.yml': 'Contacts',
  'lessons.yml': 'Holly lessons',
  'photos.yml': 'Photos',
  'signup.yml': 'Sign-up',
  'unsubscribe.yml': 'Unsubscribe',
  'suggest.yml': 'Image suggestions',
  'eventimages.yml': 'Event images',
  'read-sheet-tab.yml': 'Read Sheet tab',
  'library-candidates.yml': 'Library candidates',
  'watchdog-alert.yml': 'Watchdog alert',
  'dependabot-check.yml': 'Dependabot check',
};

const EVENTS = {
  push: 'after a change', schedule: 'on schedule', workflow_dispatch: 'started by hand',
  repository_dispatch: 'started by the Worker', workflow_run: 'after another run', pull_request: 'pull request',
};

export function runRow(r) {
  const file = String(r.path || '').split('/').pop();
  return {
    id: r.id,
    name: WORKFLOW_NAMES[file] || r.name || file,
    title: String(r.display_title || '').split('\n')[0].slice(0, 90),
    event: EVENTS[r.event] || r.event || '',
    status: r.status, // queued, in_progress, completed (or waiting, requested, pending)
    conclusion: r.conclusion || '', // success, failure, cancelled, skipped, timed_out…
    started: r.run_started_at || r.created_at,
    updated: r.updated_at,
    url: r.html_url,
  };
}

export async function recentRuns(env, n = 20) {
  const per = Math.min(Math.max(Number(n) || 20, 1), 50);
  const r = await github(env, `/repos/${env.REPO}/actions/runs?per_page=${per}`);
  if (!r.ok) throw new Error(`GitHub runs: HTTP ${r.status}`);
  const j = await r.json();
  return (j.workflow_runs || []).map(runRow);
}

// A commit's site build, from build.yml's recent runs: { state: building|live|failed, url?, started? }.
// A run cancelled by a newer build counts as live once a later build has succeeded.
export function statusFrom(runs, sha, at, nowMs = Date.now()) {
  const mine = runs.find((r) => r.head_sha === sha);
  const t = (r) => Date.parse(r.created_at);
  const laterOk = (after) => runs.some((r) => t(r) >= after && r.status === 'completed' && r.conclusion === 'success');
  const laterRunning = (after) => runs.some((r) => t(r) >= after && r.status !== 'completed');
  if (mine) {
    const out = { url: mine.html_url, started: mine.run_started_at || mine.created_at };
    if (mine.status !== 'completed') return { state: 'building', ...out };
    if (mine.conclusion === 'success') return { state: 'live', ...out };
    if (mine.conclusion === 'cancelled' || mine.conclusion === 'skipped') {
      if (laterOk(t(mine))) return { state: 'live', ...out };
      if (laterRunning(t(mine))) return { state: 'building', ...out };
    }
    return { state: 'failed', ...out };
  }
  // Not listed yet (GitHub takes a few seconds), or pushed out of the list by newer builds.
  const since = Date.parse(at) || nowMs;
  if (laterOk(since)) return { state: 'live' };
  if (nowMs - since < 10 * 60000) return { state: 'building' };
  return { state: 'failed' };
}

export async function buildStatus(env, sha, at) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return { ok: false, status: 400, error: 'Bad commit' };
  const r = await github(env, `/repos/${env.REPO}/actions/workflows/build.yml/runs?per_page=10`);
  if (!r.ok) return { ok: false, status: 502, error: `GitHub runs: HTTP ${r.status}` };
  const j = await r.json();
  return { ok: true, ...statusFrom(j.workflow_runs || [], sha, at) };
}
