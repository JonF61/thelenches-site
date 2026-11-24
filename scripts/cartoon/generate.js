// scripts/cartoon/generate.js
// Draws the week's newsletter cartoon with OpenAI's image API (24 Nov 2026, Jon: replaces pasting
// Kryten's prompt into ChatGPT by hand). Run by cartoon.yml on a Kryten branch:
//   reads the prompt Kryten committed in scripts/cartoon/next-prompt.md, asks for COUNT versions,
//   signs each with sign.js ("Dave", 920px Outlook-safe JPEG) and writes them to
//   scripts/cartoon/candidates/<issue>-<slug>-<a|b|c>-signed.jpg (outside sites/, so never built).
// Kryten then shows them to Jon, moves the chosen one into both sites' images/cartoons/ and
// deletes the rest (newsletter-cartoon skill). The prompt is a public gag: never personal data.
// Env: OPENAI_API_KEY (secret), CARTOON_ISSUE (YYYY-MM-DD), CARTOON_SLUG, CARTOON_COUNT (1-4),
// CARTOON_MODEL (default gpt-image-2), CARTOON_QUALITY (default medium).
'use strict';

const fs = require('fs');
const path = require('path');
const { sign } = require('./sign');

const DIR = __dirname;
const PROMPT_FILE = path.join(DIR, 'next-prompt.md');
const OUT_DIR = path.join(DIR, 'candidates');
const ENDPOINT = 'https://api.openai.com/v1/images/generations';

function settings(env = process.env) {
  const issue = String(env.CARTOON_ISSUE || '').trim();
  const slug = String(env.CARTOON_SLUG || '').trim();
  const count = Number(env.CARTOON_COUNT || 3);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue)) throw new Error('issue must be YYYY-MM-DD');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) throw new Error('slug must be short lower-case words joined by hyphens');
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('count must be 1 to 4');
  return {
    issue, slug, count,
    model: env.CARTOON_MODEL || 'gpt-image-2',
    quality: env.CARTOON_QUALITY || 'medium',
  };
}

function readPrompt(file = PROMPT_FILE) {
  if (!fs.existsSync(file)) throw new Error('No scripts/cartoon/next-prompt.md on this branch');
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text.length < 200) throw new Error('next-prompt.md looks too short to be the house-style prompt');
  if (!/Strict requirements:/.test(text)) throw new Error('next-prompt.md is missing the Strict requirements paragraph');
  return text;
}

const LETTERS = 'abcd';
function fileFor(s, i) { return `${s.issue}-${s.slug}-${LETTERS[i]}-signed.jpg`; }

// One request for all versions; fetchImpl is swappable for the offline test.
async function draw(prompt, s, key, fetchImpl = fetch) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: s.model, prompt, n: s.count, size: '1024x1024', quality: s.quality, output_format: 'png' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || `HTTP ${res.status}`;
    throw new Error(`OpenAI refused (${res.status}): ${msg}`);
  }
  const images = (body.data || []).map((d) => d.b64_json).filter(Boolean);
  if (!images.length) throw new Error('OpenAI sent no images');
  return images.map((b) => Buffer.from(b, 'base64'));
}

async function main({ env = process.env, fetchImpl = fetch, outDir = OUT_DIR, promptFile = PROMPT_FILE } = {}) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const s = settings(env);
  const prompt = readPrompt(promptFile);
  console.log(`Drawing ${s.count} version(s) for ${s.issue} with ${s.model} (${s.quality})`);
  const pictures = await draw(prompt, s, key, fetchImpl);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (let i = 0; i < pictures.length; i++) {
    const out = path.join(outDir, fileFor(s, i));
    const info = await sign(pictures[i], out);
    console.log(`Signed: ${path.basename(out)} (${info.width}x${info.height}, ${Math.round(info.size / 1024)} KB)`);
    written.push(out);
  }
  return written;
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { settings, readPrompt, draw, main, fileFor };
