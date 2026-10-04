// scripts/photos/describe.js
// One Sonnet call per new photo (on a 1024px thumbnail): draft alt text, a note
// for the editor, a people/children check that gates publishing, and a stock check.
'use strict';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

const SYSTEM = `You look at photos for The Lenches, a group of villages in Worcestershire, England, before they go on the community website.
Reply with one JSON object and nothing else:
{"alt_text": "...", "description": "...", "people": "none|distant|identifiable", "children": false, "kind": "photo|screenshot|document|graphic", "stock": "likely|possible|unlikely"}

alt_text: at most 125 characters, British English, saying what is visible for someone using a screen reader. Don't start with "Image of" or "Photo of". You may use the village name from the folder hint, but don't name a specific building, business or person unless the name is legible in the image.
description: one plain sentence for the editor, mentioning anything that matters for publishing (blur, poor light, text in the image, season, a recognisable car number plate).
people: "none" if nobody is visible; "distant" if people are visible but too small, blurred or turned away to be recognised; "identifiable" if anyone's face could be recognised.
children: true if anyone visible appears to be under 18.
kind: "screenshot" for captures of screens, maps or web pages; "document" for flyers, posters or text-heavy images; "graphic" for logos and illustrations; otherwise "photo".
stock: "likely" if there is a stock-library watermark or credit, or it looks like a generic studio or model shot rather than a real local scene, event or act; "possible" if it might be; otherwise "unlikely".`;

let clientCache;
function claude() {
  if (!clientCache) {
    const Anthropic = require('@anthropic-ai/sdk');
    clientCache = new Anthropic({ maxRetries: 2, timeout: 60000 });
  }
  return clientCache;
}

const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function describePhoto(jpeg, { village, subject }) {
  const hint = [village, subject].filter(Boolean).join(' / ') || 'none';
  const res = await claude().messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: `Folder hint: ${hint}` },
      ],
    }],
  });
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in reply');
  const d = JSON.parse(text.slice(start, end + 1));

  const people = ['none', 'distant', 'identifiable'].includes(d.people) ? d.people : 'unknown';
  return {
    alt_text: oneLine(d.alt_text, 125),
    description: oneLine(d.description, 300),
    people: d.children === true ? 'children' : people,
    kind: ['photo', 'screenshot', 'document', 'graphic'].includes(d.kind) ? d.kind : 'photo',
    stock: ['likely', 'possible', 'unlikely'].includes(d.stock) ? d.stock : 'unlikely',
  };
}

module.exports = { describePhoto };
