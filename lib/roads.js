// Road closures and roadworks: shared by .eleventy.js (Roads page and its map) and
// scripts/publish (road fields on pipeline items, road geometry cache).
//
// A road item is a notice with "roads": true (src/items/) or a one.network link (all
// pipeline roadworks alerts). Optional road fields, on both kinds of item:
//   start, end   YYYY-MM-DD, the works' own dates (end = last day of the works)
//   road         the road's name as on a map, e.g. "Ab Lench Road"
//   village      e.g. "Church Lench"
// Geometry for the map comes from src/_data/roadgeo.json, keyed by roadKey(road, village)
// and filled by scripts/publish/roadgeo.js (Nominatim). It is never looked up at site build:
// a road not in the cache is pinned at its village (VILLAGES) instead.
'use strict';

const isRoad = (i) =>
  !!i && (i.roads === true || /one\.network/i.test(String((i.link && i.link.url) || '')));

// "Closure" or "Roadworks", from the title and body
const roadKind = (i) =>
  /\bclos(ure|ures|ed|ing)\b/i.test(`${(i && i.title) || ''} ${(i && i.body) || ''}`) ? 'Closure' : 'Roadworks';

// The title without a "Road closure —" prefix
const roadTitle = (title) => String(title || '').replace(/^road\s*(closures?|works)\s*[—–-]\s*/i, '');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const roadKey = (road, village) => `${norm(road)}|${norm(village)}`;

// Best guess at the road from a title, for items extracted before the "road" column existed:
// "Road Closure — Ab Lench Road, Church Lench" -> "Ab Lench Road";
// "Brookdale, Harvington — water works" -> "Brookdale"; "Badgers Hill to Handgate Lane" -> "Badgers Hill".
function guessRoad(title) {
  const t = roadTitle(title).split(/\s+[—–]\s+|\s+-\s+/)[0];
  return t.split(',')[0].split(/\s+(?:to|from|between|and|junction with|jct)\s+/i)[0].trim();
}

// Village centres (approximate, WGS84 [lat, lon]): fallback pins and the map's starting frame.
// Lenches villages and Harvington checked by Jon on Google Maps, 21 Oct; the others are still estimates.
const VILLAGES = {
  'church lench': [52.1596, -1.9625],
  'rous lench': [52.1779, -1.9811],
  'ab lench': [52.1645, -1.9830],
  'atch lench': [52.1561, -1.9544],
  'sheriffs lench': [52.1404, -1.9724],
  'harvington': [52.1429, -1.9257],
  'abbots morton': [52.1883, -1.9546],
  'lenchwick': [52.1232, -1.9319],
  'radford': [52.1807, -2.0097],
  'evesham': [52.0921, -1.9467],
  'pershore': [52.1116, -2.0774],
  'inkberrow': [52.2127, -1.9785],
};
const villagePoint = (village) => VILLAGES[norm(village).replace(/\bsheriff s\b/, 'sheriffs')] || null;

// The map always shows the Lenches and Harvington: [[south, west], [north, east]]
const HOME_BOUNDS = [[52.138, -2.000], [52.178, -1.910]];
const HOME_CENTRE = VILLAGES['church lench'];

// Nominatim search box: the covered area plus the main routes into it (lon/lat order)
const SEARCH_VIEWBOX = [-2.10, 52.24, -1.85, 52.07]; // west, north, east, south

// "52.1531,-1.9771" (or "52.1531, -1.9771") -> [lat, lon], only inside the search box
function parseCoords(s) {
  const m = String(s || '').match(/(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  const [w, n, e, so] = SEARCH_VIEWBOX;
  return lat <= n && lat >= so && lon >= w && lon <= e ? [lat, lon] : null;
}

// Coordinates given in a link, e.g. ?lat=52.15&lon=-1.97, ?ll=52.15,-1.97 or /@52.15,-1.97
function coordsFromUrl(url) {
  const u = String(url || '');
  const lat = u.match(/[?&#](?:lat|latitude)=(-?\d+\.\d+)/i);
  const lon = u.match(/[?&#](?:lon|lng|long|longitude)=(-?\d+\.\d+)/i);
  if (lat && lon) return parseCoords(`${lat[1]},${lon[1]}`);
  const ll = u.match(/(?:[?&#](?:ll|q|center)=|\/@)(-?\d+\.\d+,-?\d+\.\d+)/i);
  return ll ? parseCoords(ll[1]) : null;
}

// Douglas-Peucker on [lon, lat] pairs; tolerance in degrees (0.00005 is about 5m)
function simplifyLine(points, tol = 0.00005) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  let max = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = len ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
    if (d > max) { max = d; at = i; }
  }
  if (max <= tol) return [points[0], points[points.length - 1]];
  return [...simplifyLine(points.slice(0, at + 1), tol).slice(0, -1), ...simplifyLine(points.slice(at), tol)];
}

const round5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

// Any GeoJSON geometry -> a simplified LineString/MultiLineString, or null if it has no lines
function simplifyGeometry(geom) {
  const lines = [];
  const walk = (g) => {
    if (!g) return;
    if (g.type === 'LineString') lines.push(g.coordinates);
    else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
    else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(walk);
  };
  walk(geom);
  const out = lines
    .filter((l) => Array.isArray(l) && l.length >= 2)
    .map((l) => simplifyLine(l).map(round5));
  if (!out.length) return null;
  return out.length === 1 ? { type: 'LineString', coordinates: out[0] } : { type: 'MultiLineString', coordinates: out };
}

const pointGeometry = ([lat, lon]) => ({ type: 'Point', coordinates: round5([lon, lat]) });

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '');

// One map entry per road item. fromPipeline: pipeline "expires" is the last day shown;
// a hand-written "expires" is the first day hidden. With no "end", works are shown until
// that expiry ("end date not given"), or with neither, on every day.
function mapEntry(item, roadgeo, fromPipeline) {
  const road = String(item.road || '').trim() || guessRoad(item.title);
  const village = String(item.village || '').trim();
  const start = ymd(item.start) || ymd(item.date) || null;
  const endGiven = ymd(item.end);
  let end = endGiven || null;
  if (!end && ymd(item.expires)) end = fromPipeline ? ymd(item.expires) : addDays(ymd(item.expires), -1);
  const cached = (roadgeo || {})[roadKey(road, village)];
  let geometry = cached && cached.geometry;
  let pinned = !!(cached && cached.source === 'village');
  if (!geometry) {
    const p = villagePoint(village);
    geometry = p ? pointGeometry(p) : null;
    pinned = !!p;
  }
  return {
    title: roadTitle(item.title),
    road,
    village,
    kind: roadKind(item),
    start,
    end,
    endGiven: !!endGiven,
    url: (item.link && item.link.url) || '',
    pinned,
    geometry,
  };
}

module.exports = {
  isRoad, roadKind, roadTitle, roadKey, guessRoad, norm,
  VILLAGES, villagePoint, HOME_BOUNDS, HOME_CENTRE, SEARCH_VIEWBOX,
  parseCoords, coordsFromUrl, simplifyLine, simplifyGeometry, pointGeometry, addDays, ymd, mapEntry,
};
