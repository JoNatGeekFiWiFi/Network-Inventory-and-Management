// Linear referencing along a fiber path: "the OTDR says 4.2 km — where is that on the ground?"
//
// Three things have to happen, and each is a place the answer can quietly go wrong:
//
//  1. MERGE. A circuit rides several cables on several route segments, exported in no useful order
//     and with arbitrary direction. They have to be chained end-to-end into one path. Segments
//     rarely meet exactly, so joins snap within a tolerance — and any gap we bridge is REPORTED
//     rather than silently closed, because a 900 m gap means the merge is wrong and every distance
//     downstream is wrong with it.
//
//  2. SLACK. An OTDR measures fibre, not ground. Slack loops at splices and coils at poles mean
//     the fibre is longer than the route it follows — conventionally ~13%. Ground distance is
//     therefore fibre × (1 − slack). Slack can vary per segment (a coil-heavy aerial run differs
//     from a straight bore), so the conversion walks segment by segment rather than scaling the
//     whole path by one factor.
//
//  3. INTERPOLATE. Walk the merged path accumulating great-circle distance until the target is
//     reached, then interpolate within the final segment.
//
// Pure functions, no DB, no network.
import { haversineM, pointToSegmentM } from './geo.js';

/** Default slack allowance, matching the field tool crews already use. */
export const DEFAULT_SLACK_PCT = 13;

// Bounds for believing a slack figure derived from source data. Measured against the Arizona
// import: of 1,979 routes carrying a fibre length, 934 land in this band with a median of 11.5%
// — close enough to the 13% convention to trust. The rest must be rejected, not averaged in:
//   ratio exactly 1.000  → no fibre length in the source; the importer fell back to the geometry
//   ratio below 1.0      → fibre shorter than the route it follows, which is impossible
//   ratio above 1.6      → corrupt; the worst record claims 1467 km of fibre on 12.8 km of route
const RATIO_MIN = 1.002;   // ≥ 0.2% slack
const RATIO_MAX = 1.6;     // ≤ 37.5% slack

/**
 * Slack implied by a measured fibre length against the ground length of the same route.
 * Returns null when the pair isn't trustworthy, so the caller falls back rather than
 * confidently using a number derived from bad data.
 */
export function measuredSlackPct(fibreM, groundM) {
  if (!Number.isFinite(fibreM) || !Number.isFinite(groundM) || groundM <= 0 || fibreM <= 0) return null;
  const ratio = fibreM / groundM;
  if (ratio < RATIO_MIN || ratio > RATIO_MAX) return null;
  return (1 - 1 / ratio) * 100;
}

const endsOf = p => [p[0], p[p.length - 1]];
const gap = (a, b) => haversineM(a[1], a[0], b[1], b[0]);   // coords are [lng,lat]

/**
 * Chain segments into one ordered path.
 *
 * @param segments [{ id, coords:[[lng,lat],…], meta }]
 * @param snapM    how far apart two ends may be and still be treated as joined
 * @returns { coords, order:[{id, reversed, gapBefore}], gaps:[{after,m}], unused:[id] }
 *
 * Greedy nearest-end chaining. Starts from the segment with the most isolated endpoint (a true
 * end of the run rather than something in the middle), then extends forward and backward.
 */
export function mergeSegments(segments, snapM = 50) {
  const segs = (segments || []).filter(s => Array.isArray(s.coords) && s.coords.length >= 2);
  if (!segs.length) return { coords: [], order: [], gaps: [], unused: [] };
  if (segs.length === 1) return { coords: segs[0].coords.slice(), order: [{ id: segs[0].id, reversed: false, gapBefore: 0 }], gaps: [], unused: [] };

  // Plant is often in disconnected pieces — a circuit's cables may not all touch, or one stray
  // segment sits kilometres away. Chain every component, then keep the longest and report the
  // rest as unused. Seeding once and stopping would happily return the stray and discard the
  // actual route.
  let pool = segs.slice(), bestChain = null;
  const leftovers = [];
  while (pool.length) {
    const chain = chainOne(pool, snapM);
    const len = pathLengthM(chain.coords);
    if (!bestChain || len > bestChain.len) {
      if (bestChain) leftovers.push(...bestChain.order.map(o => o.id));
      bestChain = { ...chain, len };
    } else {
      leftovers.push(...chain.order.map(o => o.id));
    }
    const consumed = new Set(chain.order.map(o => o.id));
    pool = pool.filter(s => !consumed.has(s.id));
  }
  return { coords: bestChain.coords, order: bestChain.order, gaps: bestChain.gaps, unused: leftovers };
}

/** Greedy chain of one connected component, starting from its most isolated endpoint. */
function chainOne(segs, snapM) {
  const remaining = new Map(segs.map(s => [s.id, s]));

  // Pick a starting segment: the one whose endpoint is furthest from every other endpoint, i.e.
  // a loose end. Starting mid-run would force the chain to double back on itself.
  let startId = segs[0].id, startBest = -1;
  for (const s of segs) {
    for (const e of endsOf(s.coords)) {
      let nearest = Infinity;
      for (const o of segs) {
        if (o.id === s.id) continue;
        for (const oe of endsOf(o.coords)) nearest = Math.min(nearest, gap(e, oe));
      }
      if (nearest > startBest) { startBest = nearest; startId = s.id; }
    }
  }

  const first = remaining.get(startId); remaining.delete(startId);
  let coords = first.coords.slice();
  const order = [{ id: first.id, reversed: false, gapBefore: 0 }];
  const gaps = [];

  // Attach whatever is nearest to `end`, flipping it if needed. Returns the joined gap or null.
  const takeNearest = (anchor) => {
    let best = null;
    for (const s of remaining.values()) {
      const [a, b] = endsOf(s.coords);
      const da = gap(anchor, a), db = gap(anchor, b);
      const d = Math.min(da, db);
      if (!best || d < best.d) best = { s, d, reversed: db < da };
    }
    return best;
  };

  // Forward from the tail.
  for (;;) {
    if (!remaining.size) break;
    const best = takeNearest(coords[coords.length - 1]);
    if (!best || best.d > snapM) break;
    remaining.delete(best.s.id);
    const piece = best.reversed ? best.s.coords.slice().reverse() : best.s.coords.slice();
    if (best.d > 0.5) gaps.push({ after: order[order.length - 1].id, next: best.s.id, m: Math.round(best.d) });
    order.push({ id: best.s.id, reversed: best.reversed, gapBefore: Math.round(best.d) });
    coords = coords.concat(piece);
  }
  // Backward from the head, for segments that belong before the seed.
  for (;;) {
    if (!remaining.size) break;
    const best = takeNearest(coords[0]);
    if (!best || best.d > snapM) break;
    remaining.delete(best.s.id);
    // We're prepending, so the piece must END at our current head.
    const piece = best.reversed ? best.s.coords.slice() : best.s.coords.slice().reverse();
    if (best.d > 0.5) gaps.unshift({ after: best.s.id, next: order[0].id, m: Math.round(best.d) });
    order.unshift({ id: best.s.id, reversed: !best.reversed, gapBefore: 0 });
    coords = piece.concat(coords);
  }

  return { coords, order, gaps };
}

/** Running ground distance in metres at each vertex; last entry is the total. */
export function cumulative(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++)
    out.push(out[i - 1] + haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  return out;
}

/** Total ground length in metres. */
export function pathLengthM(coords) {
  const c = cumulative(coords);
  return c.length ? c[c.length - 1] : 0;
}

/**
 * The point `metres` of GROUND distance along the path.
 * Clamps to the ends rather than extrapolating — a distance past the end of the route means the
 * input was wrong, and inventing a position beyond the plant would be worse than pinning the end.
 */
export function pointAtDistance(coords, metres, cum) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  if (coords.length === 1) return { lat: coords[0][1], lng: coords[0][0], index: 0, clamped: true };
  const c = cum || cumulative(coords);
  const total = c[c.length - 1];
  const clamped = metres < 0 || metres > total;
  const d = Math.max(0, Math.min(metres, total));
  let i = 1;
  while (i < c.length - 1 && c[i] < d) i++;
  const segLen = c[i] - c[i - 1];
  const t = segLen === 0 ? 0 : (d - c[i - 1]) / segLen;
  const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
  return { lat: y1 + (y2 - y1) * t, lng: x1 + (x2 - x1) * t, index: i - 1, along_m: d, clamped };
}

/**
 * Project a point onto the path: how far along is the closest place on the line?
 * The reverse lookup — a crew finds damage at a location and needs to tell the OTDR tech where
 * on the trace to look. `offset_m` is how far the point sits off the route, which is the honest
 * signal for "you clicked somewhere this path doesn't go".
 */
export function distanceAlong(coords, lat, lng, cum) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const c = cum || cumulative(coords);
  let best = null;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
    const p = pointToSegmentM(lat, lng, y1, x1, y2, x2);
    if (!best || p.m < best.offset_m) {
      const segLen = c[i] - c[i - 1];
      const frac = segLen === 0 ? 0 : haversineM(y1, x1, p.lat, p.lng) / segLen;
      best = { offset_m: p.m, along_m: c[i - 1] + Math.min(segLen, segLen * frac), lat: p.lat, lng: p.lng, index: i - 1 };
    }
  }
  return best;
}

/**
 * Ground metres for a given FIBRE distance, honouring a different slack factor per segment.
 *
 * `spans` are [{ endGround_m, slackPct }] in path order — the ground distance at which each
 * segment ends, and the slack that applies within it. A flat factor is just one span.
 * Fibre within a segment = ground / (1 − slack), so we consume fibre span by span.
 */
export function fibreToGround(fibreM, spans, defaultPct = DEFAULT_SLACK_PCT) {
  if (!spans || !spans.length) return fibreM * (1 - defaultPct / 100);
  let prevGround = 0, fibreLeft = fibreM;
  for (const s of spans) {
    const groundLen = Math.max(0, s.endGround_m - prevGround);
    const k = 1 - (s.slackPct == null ? defaultPct : s.slackPct) / 100;
    const fibreLen = k > 0 ? groundLen / k : groundLen;
    if (fibreLeft <= fibreLen) return prevGround + fibreLeft * k;
    fibreLeft -= fibreLen;
    prevGround = s.endGround_m;
  }
  // Past the end: extend at the last segment's rate rather than pretending it stops.
  const last = spans[spans.length - 1];
  const k = 1 - (last.slackPct == null ? defaultPct : last.slackPct) / 100;
  return prevGround + fibreLeft * k;
}

/** Inverse of fibreToGround: the fibre distance corresponding to a ground distance. */
export function groundToFibre(groundM, spans, defaultPct = DEFAULT_SLACK_PCT) {
  if (!spans || !spans.length) {
    const k = 1 - defaultPct / 100;
    return k > 0 ? groundM / k : groundM;
  }
  let prevGround = 0, fibre = 0;
  for (const s of spans) {
    const k = 1 - (s.slackPct == null ? defaultPct : s.slackPct) / 100;
    const segGround = Math.max(0, s.endGround_m - prevGround);
    if (groundM <= s.endGround_m) return fibre + (k > 0 ? (groundM - prevGround) / k : groundM - prevGround);
    fibre += k > 0 ? segGround / k : segGround;
    prevGround = s.endGround_m;
  }
  const last = spans[spans.length - 1];
  const k = 1 - (last.slackPct == null ? defaultPct : last.slackPct) / 100;
  return fibre + (k > 0 ? (groundM - prevGround) / k : groundM - prevGround);
}
