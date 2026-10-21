// scripts/publish/roadgeo.js
// Road geometry cache for the Roads page map: src/_data/roadgeo.json, keyed by
// roadKey(road, village) (lib/roads.js). Each road is looked up once, here in the
// publish run and never at site build, then kept:
//   { "ab lench road|church lench": { road, village, source, looked_up, geometry } }
// source: "nominatim" (a simplified GeoJSON line), "coords" (a point given in the email
// or link, no line found near it), "village" (not found: pinned at the village; logged),
// or "manual" (fixed by hand). Delete an entry to have it looked up again.
// Nominatim usage policy: at most 1 request a second, an identifying User-Agent,
// results cached; https://operations.osmfoundation.org/policies/nominatim/
'use strict';

const fs = require('fs');
const path = require('path');
const {
  roadKey, villagePoint, SEARCH_VIEWBOX, simplifyGeometry, pointGeometry, norm,
} = require('../../lib/roads');

const FILE = path.join(__dirname, '..', '..', 'src', '_data', 'roadgeo.json');
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'TheLenchesWebsite/1.0 (+https://thelenches.org.uk; website@thelenches.org.uk)';
const GAP_MS = 1100; // a little over 1 request a second
const MAX_LOOKUPS = 20; // per run; the rest wait for the next run

const londonDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Writes only if changed; returns true if it did. Keys sorted so diffs stay small.
function save(cache, file) {
  const sorted = Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]]));
  const json = `${JSON.stringify(sorted, null, 2)}\n`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (json === old) return false;
  fs.writeFileSync(file, json);
  return true;
}

let lastCall = 0;
async function search(params, fetchImpl) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const qs = new URLSearchParams({
    format: 'jsonv2', polygon_geojson: '1', dedupe: '0', limit: '10', countrycodes: 'gb',
    bounded: '1', ...params,
  });
  const res = await fetchImpl(`${ENDPOINT}?${qs}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-GB' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

// The road's line from Nominatim results: highway segments named like the road (all of
// them, merged), else the first highway result; null if none.
function lineFrom(results, road) {
  const roads = (Array.isArray(results) ? results : []).filter((r) => r && r.category === 'highway' && r.geojson);
  const named = roads.filter((r) => norm(r.name) === norm(road));
  const use = named.length ? named : roads.slice(0, 1);
  return simplifyGeometry({ type: 'GeometryCollection', geometries: use.map((r) => r.geojson) });
}

// One lookup: near the given coordinates if any, else within the covered area.
// Returns a cache entry, or throws on a network error (nothing cached; retried next run).
async function lookup({ road, village, coords }, fetchImpl) {
  const base = { road, village, looked_up: londonDate() };
  const q = [road, village, 'Worcestershire'].filter(Boolean).join(', ');
  const box = coords
    ? [coords[1] - 0.01, coords[0] + 0.007, coords[1] + 0.01, coords[0] - 0.007]
    : SEARCH_VIEWBOX;
  const line = road ? lineFrom(await search({ q, viewbox: box.join(',') }, fetchImpl), road) : null;
  if (line) return { ...base, source: 'nominatim', geometry: line };
  if (coords) return { ...base, source: 'coords', geometry: pointGeometry(coords) };
  const p = villagePoint(village);
  return p ? { ...base, source: 'village', geometry: pointGeometry(p) } : null;
}

// wanted: [{ road, village, coords? }]. Looks up the roads not yet cached and saves the cache.
// Returns { changed, failed: [messages] }. Never throws: the map falls back to village pins.
async function updateRoadGeo(wanted, { fetchImpl = globalThis.fetch, log = console.log, file = FILE } = {}) {
  const cache = load(file);
  const failed = [];
  const seen = new Set();
  let lookups = 0;
  for (const w of wanted) {
    if (!w.road && !w.coords) continue;
    const key = roadKey(w.road, w.village);
    if (cache[key] || seen.has(key)) continue;
    seen.add(key);
    if (lookups >= MAX_LOOKUPS) { log(`Road lookups capped at ${MAX_LOOKUPS}; ${key} waits for the next run.`); continue; }
    lookups++;
    try {
      const entry = await lookup(w, fetchImpl);
      if (!entry) {
        failed.push(`${w.road}, ${w.village || '(no village)'}: not found and no village to pin it to`);
        continue;
      }
      cache[key] = entry;
      if (entry.source === 'village') {
        failed.push(`${w.road}, ${w.village}: not found; pinned at the village (fix "${key}" in src/_data/roadgeo.json)`);
      } else {
        log(`Road geometry cached: ${key} (${entry.source}).`);
      }
    } catch (err) {
      failed.push(`${w.road}, ${w.village}: lookup failed (${String((err && err.message) || err)}); will retry next run`);
    }
  }
  const changed = save(cache, file);
  return { changed, failed };
}

module.exports = { updateRoadGeo, lookup, lineFrom, FILE };
