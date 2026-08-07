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
  const index = new EndpointIndex(segs, snapM);
  let bestChain = null;
  const leftovers = [];
  while (index.size) {
    const chain = chainOne(index);
    const len = pathLengthM(chain.coords);
    if (!bestChain || len > bestChain.len) {
      if (bestChain) leftovers.push(...bestChain.order.map(o => o.id));
      bestChain = { ...chain, len };
    } else {
      leftovers.push(...chain.order.map(o => o.id));
    }
  }
  return { coords: bestChain.coords, order: bestChain.order, gaps: bestChain.gaps, unused: leftovers };
}

/**
 * Spatial hash over segment endpoints.
 *
 * Chaining used to compare every endpoint against every other, which is fine for a handful of
 * cables and catastrophic for a real file: 1,000 disconnected segments took 64 seconds and, on a
 * single-threaded server, that blocks everything else. Bucketing endpoints by a grid the size of
 * the snap tolerance makes "what is nearest to here" a lookup of nine cells instead of a full
 * scan, which is what makes a public upload endpoint safe to offer at all.
 */
class EndpointIndex {
  constructor(segs, snapM) {
    this.snapM = snapM;
    // Cell size in degrees, from the snap distance at this latitude. Longitude degrees shrink
    // towards the poles, so use the widest (equatorward) case to be sure cells aren't too small.
    const lat = segs[0].coords[0][1] || 0;
    this.dLat = Math.max(snapM / 110574, 1e-9);
    this.dLng = Math.max(snapM / Math.max(1, Math.cos(lat * Math.PI / 180) * 111320), 1e-9);
    this.segs = new Map();
    this.cells = new Map();
    for (const s of segs) { this.segs.set(s.id, s); this._add(s); }
  }
  get size() { return this.segs.size; }
  _key(lng, lat) { return Math.floor(lng / this.dLng) + ':' + Math.floor(lat / this.dLat); }
  _add(s) {
    const ends = [s.coords[0], s.coords[s.coords.length - 1]];
    ends.forEach((c, i) => {
      const k = this._key(c[0], c[1]);
      let bucket = this.cells.get(k);
      if (!bucket) { bucket = []; this.cells.set(k, bucket); }
      bucket.push({ id: s.id, end: i, coord: c });
    });
  }
  take(id) { const s = this.segs.get(id); this.segs.delete(id); return s; }
  /** Any remaining segment id, for seeding a component. */
  any() { return this.segs.keys().next().value; }

  /**
   * Nearest remaining endpoint to `anchor` within the snap tolerance.
   * Scans the anchor's cell and its eight neighbours — beyond that nothing can be within range.
   */
  nearest(anchor) {
    const cx = Math.floor(anchor[0] / this.dLng), cy = Math.floor(anchor[1] / this.dLat);
    let best = null;
    for (let ix = -1; ix <= 1; ix++) for (let iy = -1; iy <= 1; iy++) {
      const bucket = this.cells.get((cx + ix) + ':' + (cy + iy));
      if (!bucket) continue;
      for (const e of bucket) {
        if (!this.segs.has(e.id)) continue;           // already consumed
        const d = gap(anchor, e.coord);
        if (d <= this.snapM && (!best || d < best.d)) best = { id: e.id, end: e.end, d };
      }
    }
    return best;
  }

  /**
   * A segment endpoint with no neighbour within tolerance — a true end of a run. Starting there
   * means the chain only has to grow one way. Falls back to any segment for a closed loop.
   */
  looseEnd() {
    for (const id of this.segs.keys()) {
      const s = this.segs.get(id);
      const ends = [s.coords[0], s.coords[s.coords.length - 1]];
      for (const e of ends) {
        const cx = Math.floor(e[0] / this.dLng), cy = Math.floor(e[1] / this.dLat);
        let neighbour = false;
        for (let ix = -1; ix <= 1 && !neighbour; ix++) for (let iy = -1; iy <= 1 && !neighbour; iy++) {
          const bucket = this.cells.get((cx + ix) + ':' + (cy + iy));
          if (!bucket) continue;
          for (const o of bucket) {
            if (o.id === id || !this.segs.has(o.id)) continue;
            if (gap(e, o.coord) <= this.snapM) { neighbour = true; break; }
          }
        }
        if (!neighbour) return id;
      }
    }
    return this.any();
  }
}

/** Greedy chain of one connected component, consuming segments from the index. */
function chainOne(index) {
  const first = index.take(index.looseEnd());
  let coords = first.coords.slice();
  const order = [{ id: first.id, reversed: false, gapBefore: 0 }];
  const gaps = [];

  // Forward from the tail.
  for (;;) {
    if (!index.size) break;
    const hit = index.nearest(coords[coords.length - 1]);
    if (!hit) break;
    const seg = index.take(hit.id);
    const reversed = hit.end === 1;                    // matched its far end, so flip it
    const piece = reversed ? seg.coords.slice().reverse() : seg.coords.slice();
    if (hit.d > 0.5) gaps.push({ after: order[order.length - 1].id, next: seg.id, m: Math.round(hit.d) });
    order.push({ id: seg.id, reversed, gapBefore: Math.round(hit.d) });
    coords = coords.concat(piece);
  }
  // Backward from the head, for segments that belong before the seed.
  for (;;) {
    if (!index.size) break;
    const hit = index.nearest(coords[0]);
    if (!hit) break;
    const seg = index.take(hit.id);
    // We're prepending, so the piece must END at our current head.
    const reversed = hit.end === 1;
    const piece = reversed ? seg.coords.slice() : seg.coords.slice().reverse();
    if (hit.d > 0.5) gaps.unshift({ after: seg.id, next: order[0].id, m: Math.round(hit.d) });
    order.unshift({ id: seg.id, reversed: !reversed, gapBefore: 0 });
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
