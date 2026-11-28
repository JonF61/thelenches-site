// Fetch for outside websites (28 Nov 2026, Jon): Node's fetch first; if the site refuses it
// (a firewall answer such as HTTP 403/429/503, or a failure like a redirect loop) the same GET
// is read with curl, which some firewalls (Wychavon's Sucuri, 27 Nov) let through. Each time curl
// succeeds where fetch didn't, one log line names the host and why (hosts only, never page text),
// so we can see which sites need it. Never solves a challenge or disguises the client beyond this.
//
// webFetch(url, init) takes fetch's arguments and returns a real Response (body stream, text(),
// arrayBuffer(), headers.get, url). Only GET and HEAD fall back; a timeout or the caller's abort
// does not (it would double the wait). Use it for other people's websites, not for Google,
// Claude, GitHub or our own Worker. Test: scripts/test-webfetch.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BLOCK_STATUS = new Set([403, 406, 429, 503]);
const MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url); } };
const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /timed? ?out|abort/i.test(String(e.message)));

function headerList(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function' && !Array.isArray(headers)) return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers);
}

// The last header block curl wrote (one block per redirect).
function parseHeaders(raw) {
  const blocks = String(raw).split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  const h = new Headers();
  const last = blocks[blocks.length - 1] || '';
  for (const line of last.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) { try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* bad header */ } }
  }
  return h;
}

// One GET (or HEAD) with curl -> Response. Throws if curl gets no answer at all.
function curlFetch(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, bin = 'curl' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webfetch-'));
  const body = path.join(dir, 'body');
  const head = path.join(dir, 'head');
  const method = String(init.method || 'GET').toUpperCase();
  const args = ['-sS', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--max-filesize', String(MAX_BYTES), '-o', body, '-D', head, '-w', '%{http_code} %{url_effective}'];
  if (init.redirect !== 'manual') args.push('-L', '--max-redirs', '10');
  if (method === 'HEAD') args.push('-I');
  for (const [k, v] of headerList(init.headers)) args.push(/^user-agent$/i.test(k) ? '-A' : '-H', /^user-agent$/i.test(k) ? String(v) : `${k}: ${v}`);
  args.push('--', url);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      try {
        const [code, ...rest] = String(stdout || '').trim().split(' ');
        const status = Number(code);
        if (!status) return reject(new Error(`curl: ${String(stderr || (err && err.message) || 'no answer').trim().split('\n')[0]}`));
        const data = fs.existsSync(body) ? fs.readFileSync(body) : Buffer.alloc(0);
        const res = new Response(method === 'HEAD' || [204, 304].includes(status) ? null : data,
          { status, headers: parseHeaders(fs.existsSync(head) ? fs.readFileSync(head, 'latin1') : '') });
        Object.defineProperty(res, 'url', { value: rest.join(' ') || url });
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

async function webFetch(url, init = {}, opts = {}) {
  const { fetchImpl = fetch, curl = curlFetch, log = console.log } = opts;
  const method = String(init.method || 'GET').toUpperCase();
  const canFallBack = (method === 'GET' || method === 'HEAD') && !init.body;
  let res;
  let failure;
  try {
    res = await fetchImpl(url, init);
    if (!canFallBack || !BLOCK_STATUS.has(res.status)) return res;
  } catch (e) {
    if (!canFallBack || isAbort(e) || (init.signal && init.signal.aborted)) throw e;
    failure = e;
  }
  const why = res ? `HTTP ${res.status}` : String((failure.cause && failure.cause.message) || failure.message || failure);
  try {
    const viaCurl = await curl(url, init, { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS });
    if (res && BLOCK_STATUS.has(viaCurl.status)) return res; // curl refused too: keep fetch's answer
    log(`webfetch: ${hostOf(url)} refused Node's fetch (${why}); read with curl (HTTP ${viaCurl.status})`);
    return viaCurl;
  } catch (e) {
    if (res) return res;
    throw failure;
  }
}

module.exports = { webFetch, curlFetch, parseHeaders, BLOCK_STATUS };
