// lib/tiles.js
// Illustrated fallback tiles for events with no supplied image (Events page only).
// Decorative: aria-hidden, no viewer link, never used in the newsletter.
// Pick: e.tile (optional, whatson.json) if valid, else keywords in the title, else the body, else "village".
'use strict';

const BG = { warm: '#fdf1e3', cool: '#eef4e6' };
const G = '#3b6d11';   // line colour
const O = '#d9732b';   // accent

// Order matters: first match wins. Note "church" alone is NOT a keyword (Church Lench).
const RULES = [
  ['quiz', /\bquiz/],
  ['church', /\b(services?|evensong|communion|eucharist|mass|worship|carols?|benefice|thanksgiving|remembrance|mothers' union)\b/],
  ['theatre', /\b(theatre|amphitheatre|play|panto(mime)?|drama|glads|film|cinema|show|comedy)\b/],
  ['music', /\b(music(al)?|concert|band|choir|gig|jazz|folk|singing|sing-?along|disco|ceilidh|recital|orchestra)\b/],
  ['fete', /\b(f[eê]te|fair|fayre|festival|market|bazaar|extravaganza|bonfire|fireworks|tree of light)\b/],
  ['sport', /\b(cricket|tennis|boules|football|bowls|golf|run|race|yoga|pilates|fitness|sports?|match|tournament)\b/],
  ['walk', /\b(walks?|walking|ramble|hike|footpaths?|trail|litter pick)\b/],
  ['children', /\b(child(ren)?|kids|famil(y|ies)|toddlers?|school|youth|halloween|story ?time|open day)\b/],
  ['meeting', /\b(meetings?|agm|talk|lecture|council|committee|workshop|class|club|surgery|drop-?in)\b/],
  ['coffee', /\b(coffee|cake|tea|brunch|breakfast|lunch|supper|dinner|pub|bar|social|barbecue|bbq)\b/],
];

const DRAW = {
  quiz: `<g fill="none" stroke="${O}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M28 22h44a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8H48l-12 10v-10h-8a8 8 0 0 1-8-8V30a8 8 0 0 1 8-8z"/><path d="M44 34a6 6 0 1 1 8 6c-2 1-2 3-2 5"/></g><circle cx="50" cy="51" r="2" fill="${O}"/><path d="M88 40l4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" fill="none" stroke="${G}" stroke-width="2.5" stroke-linejoin="round"/>`,
  coffee: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M38 40h36v16a14 14 0 0 1-14 14h-8a14 14 0 0 1-14-14z"/><path d="M74 46h4a6 6 0 0 1 0 12h-5"/><path d="M32 74h52"/></g><g fill="none" stroke="${O}" stroke-width="2.5" stroke-linecap="round"><path d="M48 32c-3-4 3-6 0-10"/><path d="M58 32c-3-4 3-6 0-10"/></g>`,
  church: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M40 74V46l14-12 14 12v28z"/><path d="M68 74V54h20v20"/><path d="M54 34V18M49 23h10"/><path d="M50 74V62a4 4 0 0 1 8 0v12"/><path d="M28 74h72"/></g><circle cx="78" cy="62" r="3" fill="none" stroke="${O}" stroke-width="2.5"/>`,
  music: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M50 64V30l32-8v34"/><path d="M50 38l32-8"/></g><ellipse cx="44" cy="64" rx="7" ry="5.5" fill="${G}"/><ellipse cx="76" cy="56" rx="7" ry="5.5" fill="${G}"/><g fill="none" stroke="${O}" stroke-width="2.5" stroke-linecap="round"><path d="M28 36q4-6 8 0"/><path d="M90 66q4-6 8 0"/></g>`,
  fete: `<path d="M22 22q38 18 76 0" fill="none" stroke="${G}" stroke-width="2.5" stroke-linecap="round"/><g stroke-linejoin="round" stroke-width="2.5" fill="none"><path d="M30 26l4 10 5-8" stroke="${O}"/><path d="M47 30l4 10 5-9" stroke="${G}"/><path d="M64 30l5 9 4-10" stroke="${O}"/><path d="M81 28l5 8 4-10" stroke="${G}"/></g><g fill="none" stroke="${G}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M40 74l20-24 20 24z"/><path d="M60 50v24"/><path d="M28 74h64"/></g><path d="M60 50v-6l7 3-7 3" fill="${O}"/>`,
  sport: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linecap="round"><circle cx="64" cy="48" r="18"/><path d="M52 35q8 13 0 26"/><path d="M76 35q-8 13 0 26"/></g><g stroke="${O}" stroke-width="2.5" stroke-linecap="round"><path d="M24 40h14"/><path d="M28 48h12"/><path d="M24 56h14"/></g>`,
  walk: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 70q25-26 50-8q16-12 30-2"/><path d="M84 66V38"/><path d="M76 40h14l4 4-4 4H76z"/></g><path d="M48 76q6-10 18-14" fill="none" stroke="${O}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="4 5"/><circle cx="38" cy="30" r="6" fill="none" stroke="${O}" stroke-width="2.5"/>`,
  theatre: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M26 20h68"/><path d="M28 74h64"/><path d="M32 20v54"/><path d="M88 20v54"/></g><g fill="none" stroke="${O}" stroke-width="2.5" stroke-linecap="round"><path d="M32 22q14 18 6 50"/><path d="M88 22q-14 18-6 50"/></g><g fill="none" stroke="${G}" stroke-width="2.5" stroke-linecap="round"><circle cx="60" cy="46" r="10"/><path d="M55 49q5 5 10 0"/></g><circle cx="56.5" cy="43" r="1.6" fill="${G}"/><circle cx="63.5" cy="43" r="1.6" fill="${G}"/>`,
  meeting: `<g fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M26 24h40a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H44l-10 8v-8h-8a6 6 0 0 1-6-6V30a6 6 0 0 1 6-6z" stroke="${G}"/><path d="M78 40h10a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6h-4v8l-10-8H64a6 6 0 0 1-6-6v-4" stroke="${O}"/></g><g stroke="${G}" stroke-width="2.5" stroke-linecap="round"><path d="M32 34h28"/><path d="M32 42h18"/></g>`,
  children: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M72 16l16 20-16 22-16-22z"/><path d="M72 16v42M56 36h32"/></g><path d="M72 58q-6 8-16 6t-16 8q-6 4-12 2" fill="none" stroke="${O}" stroke-width="2.5" stroke-linecap="round"/><g fill="${O}"><path d="M60 64l3-4 2 5z"/><path d="M44 70l3-4 2 5z"/></g>`,
  village: `<g fill="none" stroke="${G}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M30 74V48l18-14 18 14v26"/><path d="M44 74V62h8v12"/><circle cx="82" cy="46" r="12"/><path d="M82 58v16"/><path d="M22 74h76"/></g><rect x="52" y="50" width="7" height="7" fill="none" stroke="${O}" stroke-width="2.5"/>`,
};
const WARM = new Set(['quiz', 'church', 'fete', 'theatre', 'children']);

function tileFor(e) {
  if (e && e.tile && DRAW[e.tile]) return e.tile;
  for (const text of [e && e.title, e && e.body]) {
    const t = String(text || '').toLowerCase();
    for (const [key, re] of RULES) if (re.test(t)) return key;
  }
  return 'village';
}

// Square tile sized by .item-thumb (96px, 72px on phones). Drawings use a 120x90 grid, shifted to centre.
function tileSvg(e) {
  const key = tileFor(e);
  const bg = WARM.has(key) ? BG.warm : BG.cool;
  return `<svg class="item-thumb tile tile-${key}" viewBox="0 0 96 96" aria-hidden="true" focusable="false" style="flex:0 0 auto"><rect width="96" height="96" fill="${bg}"/><g transform="translate(-12 3)">${DRAW[key]}</g></svg>`;
}

module.exports = { tileFor, tileSvg, KEYS: Object.keys(DRAW) };
