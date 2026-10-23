// Offline test for scripts/newsletter/waitruns.js (rebuild safety, 23 Oct) and the preview
// warning it leads to. The GitHub API and the clock are mocked; nothing waits for real.
// Usage: node scripts/test-waitruns.js [preview-dir]   (writes preview-warning.html there)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { waitForRuns, waitNote } = require('./newsletter/waitruns');
const { wrapPreview } = require('./newsletter/render');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };
const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: 'https://api.example' };

// polls: one entry per poll, { 'approval.yml': [statuses], 'publish.yml': [statuses] }.
// The last entry repeats once the list runs out.
function scenario(polls, { failAt = -1 } = {}) {
  let clock = 0;
  let poll = 0;
  let calls = 0;
  const urls = [];
  const fetchFn = async (url, opts) => {
    urls.push(url);
    assert.strictEqual(opts.headers.Authorization, 'Bearer t');
    const file = url.match(/workflows\/([a-z]+\.yml)\/runs/)[1];
    const p = polls[Math.min(poll, polls.length - 1)];
    calls += 1;
    if (calls % 2 === 0) poll += 1; // two workflows per poll
    if (poll === failAt) return { ok: false, status: 403, json: async () => ({}) };
    const runs = (p[file] || []).map((status, i) => ({ id: `${file}-${i}`, status, html_url: `https://gh/${file}/${i}` }));
    runs.push({ id: `${file}-done`, status: 'completed' });
    return { ok: true, json: async () => ({ workflow_runs: runs }) };
  };
  const logs = [];
  const run = () => waitForRuns({
    fetchFn, env, wait: async (ms) => { clock += ms; }, now: () => clock, log: (m) => logs.push(m),
  });
  return { run, logs, urls, elapsed: () => clock, polls: () => poll };
}

(async () => {
  // Nothing running: builds at once.
  let s = scenario([{}]);
  let r = await s.run();
  ok(r.seen.length === 0 && r.still.length === 0 && !r.error && s.elapsed() === 0, 'nothing running: no wait');
  ok(s.urls.every((u) => u.startsWith('https://api.example/repos/owner/repo/actions/workflows/')), 'asks the GitHub API for both workflows');
  ok(/No approval or publish runs/.test(s.logs.join('\n')), 'logged: nothing to wait for');

  // Approval in progress, then it starts publish, then all done.
  s = scenario([
    { 'approval.yml': ['in_progress'] },
    { 'approval.yml': ['in_progress'], 'publish.yml': [] },
    {},
    { 'publish.yml': ['queued'] },
    { 'publish.yml': ['in_progress'] },
    {},
  ]);
  r = await s.run();
  ok(r.still.length === 0 && r.seen.length === 2, 'waited for approval, then the publish it started');
  ok(s.elapsed() === 6 * 30000, `polled every 30 seconds (${s.elapsed() / 1000}s)`);
  ok(/Waiting for: Apply approval \(in progress\)/.test(s.logs.join('\n')) && /Waiting for: Publish to site \(queued\)/.test(s.logs.join('\n')),
    'logged what it waited for');
  ok(/Waited for: Apply approval, Publish to site \(2 run\(s\), 180s\)/.test(s.logs[s.logs.length - 1]), 'final log names the runs');

  // Still running after 10 minutes: builds anyway with a note.
  s = scenario([{ 'approval.yml': ['queued', 'in_progress'], 'publish.yml': ['in_progress'] }]);
  r = await s.run();
  ok(r.still.length === 3 && s.elapsed() <= 10 * 60000 && s.elapsed() >= 9 * 60000, `gives up after 10 minutes (${s.elapsed() / 1000}s)`);
  ok(/Still in progress after 10 minutes/.test(s.logs[s.logs.length - 1]), 'logged: still in progress');
  const note = waitNote(r.still);
  ok(/Apply approval \(queued\), Apply approval \(in progress\), Publish to site \(in progress\) were still running/.test(note)
    && /Rebuild/.test(note), `note names the runs and suggests Rebuild: ${note}`);

  // API failure: warning, build as now.
  const warn = console.warn;
  let warned = '';
  console.warn = (m) => { warned += m; };
  s = scenario([{ 'approval.yml': ['queued'] }], { failAt: 0 });
  r = await s.run();
  console.warn = warn;
  ok(r.error && r.still.length === 0 && s.elapsed() === 0 && /Warning: couldn't check/.test(warned), 'API failure: warning, no wait');
  // No token: same.
  console.warn = () => {};
  r = await waitForRuns({ env: {}, wait: async () => {}, log: () => {} });
  console.warn = warn;
  ok(/GITHUB_TOKEN/.test(r.error), 'no token: warning, no wait');

  // Preview banner: shown, and the subscriber copy and hash are untouched.
  const rendered = { subject: 'The Lenches Newsletter', hash: 'abcdef1234567890', html: '<body><!--PREVIEW--><p>Issue</p></body>', text: 'Issue' };
  const before = JSON.stringify(rendered);
  const plain = wrapPreview(rendered, { testTo: 'test@example.com', status: 'tested' });
  const warned2 = wrapPreview(rendered, { testTo: 'test@example.com', status: 'tested', warning: note });
  ok(!plain.html.includes('still running') && !plain.text.includes('WARNING'), 'no warning when nothing was still running');
  ok(warned2.html.includes('were still running after a 10 minute wait') && warned2.text.includes(`WARNING: ${note}`), 'preview shows the warning');
  ok(JSON.stringify(rendered) === before && warned2.html.includes('Hash abcdef123456'), 'subscriber copy and content hash unchanged');
  if (process.argv[2]) {
    fs.mkdirSync(process.argv[2], { recursive: true });
    fs.writeFileSync(path.join(process.argv[2], 'preview-warning.html'), warned2.html);
  }

  console.log(`All wait-for-runs tests passed (${checks} checks).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
