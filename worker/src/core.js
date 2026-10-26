// worker/src/core.js
// Shared by the signed email links (index.js /a) and the admin panel (admin/): the action
// list, payload checks and the one path to GitHub (decide -> repository_dispatch). The
// panel never has its own approval logic; it builds the same payload and calls decide().

export const NL_MODES = ['shadow', 'canary', 'live'];

// action -> [confirm verb, done word, button class]
export const ACTIONS = {
  approve: ['Approve', 'Approved', 'approve'],
  reject: ['Reject', 'Rejected', 'reject'],
  approve_own: ['Approve with their wording', 'Approved with their wording', 'approve'],
  approve_rewrite: ['Approve with rewrite', 'Approved with our rewrite', 'approve'],
  trust: ['Trust this source', 'Source trusted', 'approve'],
  send: ['Approve and send reply', 'Reply approved', 'approve'],
  skip: ['Reject reply', 'Reply rejected', 'reject'],
  edit: ['Send edited reply', 'Edited reply queued to send', 'approve'],
  redraft: ['Redraft reply', 'Redraft requested', 'approve'],
  close: ['Close, no reply needed', 'Closed', 'reject'],
  nlsend: ['Send newsletter', 'Send started', 'approve'],
  nlbuild: ['Rebuild newsletter', 'Rebuild started', 'approve'],
  unsub: ['Unsubscribe', 'Unsubscribed', 'reject'],
  // Reader feedback (Feedback tab), admin panel only: no signed email links carry these.
  fb_approve: ['Approve', 'Approved', 'approve'],
  fb_reject: ['Reject', 'Rejected', 'reject'],
  fb_postpone: ['Postpone', 'Postponed', 'approve'],
  fb_done: ['Mark implemented', 'Marked implemented', 'approve'],
  fb_send: ['Send reply', 'Reply sent', 'approve'],
  fb_edit: ['Send edited reply', 'Edited reply sent', 'approve'],
  fb_skip: ['Skip reply', 'Reply skipped', 'reject'],
  // Outreach (admin panel only): Holly drafts a nudge to one contact (admin/outreach.mjs). The
  // id is a hash of their address; the draft then waits for Jon's send / edit / skip.
  nudge: ['Draft nudge', 'Draft requested', 'approve'],
};

export const FEEDBACK_ACTIONS = ['fb_approve', 'fb_reject', 'fb_postpone', 'fb_done', 'fb_send', 'fb_edit', 'fb_skip'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function validPayload(p) {
  if (!p || !Object.prototype.hasOwnProperty.call(ACTIONS, p.a)) return false;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(p.i || ''))) return false;
  if (p.a === 'nlsend' || p.a === 'nlbuild') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.i)) return false;
  }
  if ((p.a === 'edit' || p.a === 'fb_edit') && (typeof p.b !== 'string' || p.b.length > 3000)) return false;
  if (p.a === 'fb_postpone' && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.d || ''))) return false;
  if (p.a === 'trust') {
    const k = String(p.k || '');
    if (k.length > 300 || !(/^[^\s@<>]+@[^\s@<>]+$/.test(k) || /^https?:\/\/\S+$/i.test(k))) return false;
  }
  if (p.a === 'nlsend') {
    if (!/^[0-9a-f]{12,64}$/.test(String(p.h || ''))) return false;
    if (!Number.isInteger(p.n) || p.n < 0 || p.n > 5000) return false;
    if (!NL_MODES.includes(p.m)) return false;
  }
  return true;
}

export function github(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lenches-approvals-worker',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

// repository_dispatch with retries. Returns true on HTTP 204.
export async function dispatch(env, eventType, clientPayload, tries = 1) {
  let last = '';
  for (let n = 1; n <= tries; n += 1) {
    try {
      const r = await github(env, `/repos/${env.REPO}/dispatches`, {
        method: 'POST', body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
      });
      if (r.status === 204) return true;
      last = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
    } catch (e) {
      last = e.message;
    }
    if (n < tries) await sleep(3000 * n);
  }
  console.error(`Dispatch "${eventType}" failed: ${last}`);
  return false;
}

// Optional reason typed on the Reject reply page (Reply feedback tab): one line, short.
// Also the Redraft page's instruction (required, up to 500 characters).
export const cleanReason = (v, max = 300) => String(v || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
// Edited reply text: keeps line breaks, drops other control characters.
export const cleanBody = (v) => String(v || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 3000);

export function dispatchFor(p, reason = '', body = '') {
  if (p.a === 'nlsend') {
    return ['newsletter', {
      action: 'send', issue_date: p.i, confirm_count: String(p.n), expect_hash: p.h, expect_mode: p.m,
    }];
  }
  if (p.a === 'nlbuild') return ['newsletter', { action: 'build', issue_date: p.i, rebuild: true }];
  if ((p.a === 'skip' || p.a === 'redraft') && reason) return ['approval', { id: p.i, action: p.a, reason }];
  if (p.a === 'edit') return ['approval', { id: p.i, action: p.a, body, reason }];
  // approval.yml passes only id, action, reason and body: the postpone date rides in reason.
  if (p.a === 'fb_postpone') return ['approval', { id: p.i, action: p.a, reason: p.d }];
  if (p.a === 'fb_edit') return ['approval', { id: p.i, action: p.a, body }];
  if (p.a === 'fb_reject' && reason) return ['approval', { id: p.i, action: p.a, reason }];
  return ['approval', { id: p.i, action: p.a }];
}

// One decision (approve, reject, trust, send, skip, edit, redraft, close, nlsend, nlbuild,
// the reader feedback fb_* actions, and nudge) to GitHub. True when GitHub accepted it. Single use and every safeguard are downstream.
export async function decide(env, p, reason = '', body = '') {
  const [eventType, payload] = dispatchFor(p, reason, body);
  return dispatch(env, eventType, payload, 2);
}
