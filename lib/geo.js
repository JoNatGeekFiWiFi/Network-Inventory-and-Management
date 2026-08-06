// Coordinate parsing and distance maths for map search.
//
// Field techs paste coordinates from wherever they happen to be — Google Maps, a GPS handset, a
// KMZ, a work order. Those all use different notations, so the parser accepts the four that turn
// up in practice and refuses anything it can't read rather than guessing:
//
//   decimal   33.4484, -112.0740      /  33.4484 -112.0740
//   signed    N33.4484 W112.0740      /  33.4484N 112.0740W
//   DMS       33°26'54.2"N 112°04'26.4"W
//   DDM       33 26.903 N, 112 04.440 W
//
// Everything here is pure — no DB, no network — so it can be unit-tested directly.

const R_EARTH = 6371008.8;   // IUGG mean Earth radius, metres
const rad = d => d * Math.PI / 180;

/** Great-circle distance in metres. */
export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Perpendicular distance from a point to a line SEGMENT, in metres, plus the closest point on it.
 * Uses an equirectangular projection local to the query point: over the few hundred metres that
 * matter for "what's near me" the error is negligible, and it avoids the cost of a proper geodesic.
 */
export function pointToSegmentM(lat, lng, aLat, aLng, bLat, bLng) {
  const kx = Math.cos(rad(lat)) * 111320, ky = 110574;   // metres per degree at this latitude
  const px = lng * kx, py = lat * ky;
  const ax = aLng * kx, ay = aLat * ky;
  const bx = bLng * kx, by = bLat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { m: Math.hypot(px - cx, py - cy), lat: cy / ky, lng: cx / kx };
}

/**
 * Closest approach of a point to a GeoJSON LineString ([[lng,lat],…]).
 * Returns null for degenerate geometry rather than a misleading zero.
 */
export function distanceToLineM(lat, lng, coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  if (coords.length === 1) {
    const [clng, clat] = coords[0];
    return { m: haversineM(lat, lng, clat, clng), lat: clat, lng: clng };
  }
  let best = null;
  for (let i = 1; i < coords.length; i++) {
    const [alng, alat] = coords[i - 1], [blng, blat] = coords[i];
    const d = pointToSegmentM(lat, lng, alat, alng, blat, blng);
    if (!best || d.m < best.m) best = d;
  }
  return best;
}

/** Bounding box of a GeoJSON LineString, or null. */
export function bboxOf(coords) {
  if (!Array.isArray(coords) || !coords.length) return null;
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const c of coords) {
    if (!Array.isArray(c)) continue;
    const lng = +c[0], lat = +c[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
  }
  return Number.isFinite(minLat) ? { minLat, minLng, maxLat, maxLng } : null;
}

/** Degrees of latitude/longitude covering `m` metres at this latitude — for cheap SQL bbox prefilter. */
export function degBox(lat, m) {
  const dLat = m / 110574;
  const dLng = m / Math.max(1, Math.cos(rad(lat)) * 111320);
  return { dLat, dLng };
}

const valid = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// "33 26 54.2" / "33 26.903" / "33.4484" → decimal degrees. Rejects out-of-range min/sec so a
// stray third number doesn't get silently folded in as seconds.
function dmsToDeg(d, m, s) {
  const deg = Math.abs(+d);
  const min = m === undefined || m === '' ? 0 : +m;
  const sec = s === undefined || s === '' ? 0 : +s;
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return NaN;
  if (min >= 60 || min < 0 || sec >= 60 || sec < 0) return NaN;
  return deg + min / 60 + sec / 3600;
}

// One coordinate component: optional leading hemisphere, number(s), optional trailing hemisphere.
const PART = String.raw`([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*(?:[°d:]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:['m′:]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:["s″]\s*)?)?)?\s*([NSEW])?`;
const PAIR = new RegExp(`^\\s*${PART}\\s*[,;/\\s]\\s*${PART}\\s*$`, 'i');

/**
 * Parse a pasted coordinate string. Returns { lat, lng, format } or null if it isn't one.
 *
 * Hemisphere letters win over sign, and if the letters say the first component is the longitude
 * (E/W) the pair is swapped — people paste "W112 N33" more often than you'd hope.
 */
export function parseCoords(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = PAIR.exec(raw);
  if (!m) return null;

  const build = (pre, d, mi, se, post) => {
    const hemi = (pre || post || '').toUpperCase();
    if (pre && post) return null;                       // "N33N" is nonsense
    const dec = dmsToDeg(d, mi, se);
    if (!Number.isFinite(dec)) return null;
    if (hemi && String(d).trim().startsWith('-')) return null;  // "-33N" contradicts itself
    const sign = hemi === 'S' || hemi === 'W' ? -1 : (String(d).trim().startsWith('-') ? -1 : 1);
    return { val: sign * dec, hemi, hasSubunits: mi !== undefined && mi !== '', hasSec: se !== undefined && se !== '' };
  };

  const a = build(m[1], m[2], m[3], m[4], m[5]);
  const b = build(m[6], m[7], m[8], m[9], m[10]);
  if (!a || !b) return null;

  // Decide which component is latitude.
  let lat = a, lng = b;
  const aIsLng = a.hemi === 'E' || a.hemi === 'W';
  const bIsLat = b.hemi === 'N' || b.hemi === 'S';
  if (aIsLng || bIsLat) { lat = b; lng = a; }
  // Contradictory labelling, e.g. both marked N.
  if ((a.hemi === 'N' || a.hemi === 'S') && (b.hemi === 'N' || b.hemi === 'S')) return null;
  if ((a.hemi === 'E' || a.hemi === 'W') && (b.hemi === 'E' || b.hemi === 'W')) return null;

  if (!valid(lat.val, lng.val)) return null;

  const format = (a.hasSec || b.hasSec) ? 'dms' : (a.hasSubunits || b.hasSubunits) ? 'ddm' : 'decimal';
  return { lat: lat.val, lng: lng.val, format };
}

/**
 * Ramer–Douglas–Peucker simplification of a [[lng,lat],…] path, tolerance in degrees.
 * Drawing a 400-vertex span at city zoom costs the browser 400 points to render something the eye
 * reads as a line, so the map asks for a tolerance matched to its zoom level. Endpoints are always
 * kept, so a simplified route still starts and ends on its structures.
 */
export function simplifyPath(coords, tol) {
  if (!Array.isArray(coords) || coords.length <= 2 || !(tol > 0)) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  // Iterative to avoid blowing the stack on very long paths.
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const [ax, ay] = coords[lo], [bx, by] = coords[hi];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, best = tol;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = coords[i];
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > best) { best = d; far = i; }
    }
    if (far !== -1) { keep[far] = 1; stack.push([lo, far], [far, hi]); }
  }
  const out = [];
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i]);
  return out;
}

/**
 * Keep only the parts of a path that are inside `box`, as one or more sub-paths.
 *
 * Filtering routes by bounding box still returns each one's ENTIRE geometry, so zooming into a
 * city block was downloading the full statewide path of every line crossing it — more data the
 * further you zoomed in. One vertex either side of each kept run is retained so the line still
 * runs to the edge of the screen instead of stopping short.
 *
 * box = { minLat, minLng, maxLat, maxLng }; coords are [lng,lat].
 */
export function clipPathToBox(coords, box) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const inside = ([lng, lat]) => lng >= box.minLng && lng <= box.maxLng && lat >= box.minLat && lat <= box.maxLat;
  const parts = [];
  let cur = null;
  for (let i = 0; i < coords.length; i++) {
    if (inside(coords[i])) {
      if (!cur) { cur = []; if (i > 0) cur.push(coords[i - 1]); }   // reach back to the edge
      cur.push(coords[i]);
    } else if (cur) {
      cur.push(coords[i]);                                          // and forward past it
      parts.push(cur); cur = null;
    }
  }
  if (cur) parts.push(cur);
  return parts.filter(p => p.length >= 2);
}

/**
 * Extent covering the bulk of a set of boxes, ignoring the far tails.
 * Real imports contain a few records with corrupt geometry — the Arizona export has spans whose
 * path jumps to another continent — and framing a map on the absolute min/max zooms out to show
 * the whole hemisphere. Returns null if there's nothing to frame.
 */
export function robustExtent(boxes, tailFraction = 0.01) {
  const rows = boxes.filter(b => b && Number.isFinite(b.minLat) && Number.isFinite(b.minLng));
  if (!rows.length) return null;
  // Index over (n-1) and round, so with 100 rows and a 1% tail we land on index 1 / 98 and
  // actually exclude one value at each end. Indexing over n would pick the outlier itself.
  const at = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * f)))];
  const lo = a => at(a.sort((x, y) => x - y), tailFraction);
  const hi = a => at(a.sort((x, y) => x - y), 1 - tailFraction);
  const ext = {
    minLat: lo(rows.map(b => b.minLat)), minLng: lo(rows.map(b => b.minLng)),
    maxLat: hi(rows.map(b => b.maxLat)), maxLng: hi(rows.map(b => b.maxLng))
  };
  const outliers = rows.filter(b =>
    b.minLat < ext.minLat || b.minLng < ext.minLng || b.maxLat > ext.maxLat || b.maxLng > ext.maxLng).length;
  return { ...ext, outliers, total: rows.length };
}

/** Human-readable distance: metres under 1 km, otherwise km to one decimal. */
export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
}
