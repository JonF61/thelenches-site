// worker/test/runs.test.mjs
// Offline tests for admin/runs.js: plain names for runs, and an Edit page commit's
// "Building… / Live" status from build.yml's runs.
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, statusFrom } from '../src/admin/runs.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (o) => ({ head_sha: OTHER, status: 'completed', conclusion: 'success', created_at: '2026-10-28T10:00:00Z', html_url: 'u', ...o });

test('runRow gives plain names and the first line of the title', () => {
  const r = runRow({ id: 1, path: '.github/workflows/build.yml', name: 'Build and deploy to GitHub Pages', display_title: 'Page edit: x\n\nmore', event: 'push', status: 'completed', conclusion: 'success', run_started_at: 's', updated_at: 'u', html_url: 'h' });
  assert.equal(r.name, 'Build site');
  assert.equal(r.title, 'Page edit: x');
  assert.equal(r.event, 'after a change');
  assert.equal(runRow({ path: '.github/workflows/new.yml', name: 'New thing' }).name, 'New thing');
});

test('statusFrom: own run building, live, failed', () => {
  assert.equal(statusFrom([run({ head_sha: SHA, status: 'in_progress', conclusion: null })], SHA, '').state, 'building');
  assert.equal(statusFrom([run({ head_sha: SHA })], SHA, '').state, 'live');
  assert.equal(statusFrom([run({ head_sha: SHA, conclusion: 'failure' })], SHA, '').state, 'failed');
});

test('statusFrom: a run cancelled by a newer build is live once that build succeeds', () => {
  const mine = run({ head_sha: SHA, conclusion: 'cancelled', created_at: '2026-10-28T10:00:00Z' });
  assert.equal(statusFrom([run({ created_at: '2026-10-28T10:01:00Z' }), mine], SHA, '').state, 'live');
  assert.equal(statusFrom([run({ created_at: '2026-10-28T10:01:00Z', status: 'in_progress', conclusion: null }), mine], SHA, '').state, 'building');
  assert.equal(statusFrom([mine], SHA, '').state, 'failed');
});

test('statusFrom: not listed yet is building, then failed after 10 minutes', () => {
  const at = '2026-10-28T10:00:00Z';
  const t = Date.parse(at);
  assert.equal(statusFrom([], SHA, at, t + 30000).state, 'building');
  assert.equal(statusFrom([run({ created_at: '2026-10-28T10:00:05Z' })], SHA, at, t + 30000).state, 'live');
  assert.equal(statusFrom([run({ created_at: '2026-10-28T09:00:00Z' })], SHA, at, t + 11 * 60000).state, 'failed');
});
