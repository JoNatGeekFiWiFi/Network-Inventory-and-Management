// Traffic shapes: the rhythm of real WAN traffic with everything identifying taken out, and the
// arithmetic that plays it back as believable graphs in the demo.
//
// A shape is one curve over a week, in 5-minute slots (7 × 288 = 2016), scaled so its busiest slot
// is 1000. It says "Tuesdays ramp from 7am and peak at lunch"; it cannot say whose Tuesday, how many
// megabits, or on which port. What leaves production is only:
//
//   { version, slots, profiles: [{ rx: [2016 ints 0..1000], tx: [...], jitter }] }
//
// No device ids, names, interface names, addresses or absolute rates, and the profiles are shuffled
// so their order does not line up with the order of devices either. Upload is scaled by the same
// peak as download so the ratio between them survives — that is part of what makes it look real,
// and a ratio reveals nothing about who it belongs to.
//
// Slots are keyed by UTC day-of-week and time, on both ends. Production and the demo run on the same
// clock, so a Phoenix morning peak recorded in UTC replays as a Phoenix morning peak.

export const SLOTS_PER_DAY = 288;
export const SLOTS = 7 * SLOTS_PER_DAY;
export const SCALE = 1000;
export const MAX_PROFILES = 12;
const SLOT_MS = 5 * 60 * 1000;

/** Which 5-minute slot of the (UTC) week a timestamp falls in. Sunday 00:00 is slot 0. */
export function slotOf(ms) {
  const d = new Date(ms);
  return d.getUTCDay() * SLOTS_PER_DAY + Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes()) / 5);
}

/**
 * The same slot, computed by SQLite, so production can aggregate without pulling every row into
 * memory. strftime('%w') is 0 for Sunday, matching getUTCDay(). Timestamps are stored as ISO UTC.
 */
export const SQL_SLOT = `(CAST(strftime('%w', ts) AS INTEGER) * ${SLOTS_PER_DAY} + (CAST(strftime('%H', ts) AS INTEGER) * 60 + CAST(strftime('%M', ts) AS INTEGER)) / 5)`;

/** Fill empty slots by linear interpolation around the week (it wraps: Saturday night meets Sunday). */
export function fillGaps(arr) {
  const n = arr.length, out = arr.slice();
  const known = [];
  for (let i = 0; i < n; i++) if (out[i] != null && Number.isFinite(out[i])) known.push(i);
  if (!known.length) return out.fill(0);
  if (known.length === 1) return out.fill(out[known[0]]);
  for (let k = 0; k < known.length; k++) {
    const a = known[k], b = known[(k + 1) % known.length];
    const span = (b - a + n) % n || n;
    for (let s = 1; s < span; s++) {
      const i = (a + s) % n;
      out[i] = out[a] + (out[b] - out[a]) * (s / span);
    }
  }
  return out;
}

/** Light smoothing, so four weeks of samples read as a rhythm rather than one bad afternoon. */
function smooth(arr, radius = 1) {
  const n = arr.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -radius; k <= radius; k++) { s += arr[(i + k + n) % n]; c++; }
    out[i] = s / c;
  }
  return out;
}

function shuffle(a, rand = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Build anonymised profiles from per-series slot aggregates.
 *
 * `rows` are what the SQL in shapesFromDb returns: one per (series, slot) with the average rx/tx,
 * the average of their squares (for variability) and a sample count. `series` is only used to
 * group rows here and is never copied into the output.
 */
export function buildShapes(rows, { minCoverage = 0.5, rand = Math.random } = {}) {
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series)) bySeries.set(r.series, []);
    bySeries.get(r.series).push(r);
  }
  const profiles = [];
  for (const list of bySeries.values()) {
    if (list.length < SLOTS * minCoverage) continue;          // not enough history to be a rhythm
    const rx = new Array(SLOTS).fill(null), tx = new Array(SLOTS).fill(null);
    const cvs = [];
    for (const r of list) {
      if (!(r.slot >= 0 && r.slot < SLOTS)) continue;
      rx[r.slot] = Number(r.rx) || 0;
      tx[r.slot] = Number(r.tx) || 0;
      const mean = Number(r.rx) || 0, sq = Number(r.rx2) || 0;
      if (mean > 0 && r.n > 1) cvs.push(Math.sqrt(Math.max(0, sq - mean * mean)) / mean);
    }
    const frx = smooth(fillGaps(rx)), ftx = smooth(fillGaps(tx));
    const peak = Math.max(...frx, ...ftx);
    if (!(peak > 0)) continue;                                  // an idle port has no shape to lend
    cvs.sort((a, b) => a - b);
    const jitter = cvs.length ? Math.min(0.6, Math.round(cvs[Math.floor(cvs.length / 2)] * 100) / 100) : 0.15;
    profiles.push({
      rx: frx.map(v => Math.round(v / peak * SCALE)),
      tx: ftx.map(v => Math.round(v / peak * SCALE)),
      jitter
    });
  }
  return { version: 1, slots: SLOTS, profiles: shuffle(profiles, rand).slice(0, MAX_PROFILES) };
}

/**
 * Production side: aggregate the last few weeks of WAN traffic into shapes.
 *
 * Only interfaces tagged WAN1/WAN2 on live (non-archived) devices — the WAN is what the demo graphs,
 * and it is the curve that reflects customers' working day rather than a backup job on a LAN port.
 */
export function shapesFromDb(db, { days = 28, now = Date.now(), rand } = {}) {
  const devs = db.prepare("SELECT id, iface_roles_json FROM devices WHERE archived_at IS NULL AND iface_roles_json IS NOT NULL").all();
  const pairs = [];
  for (const d of devs) {
    let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
    for (const [iface, role] of Object.entries(roles)) if (role === 'WAN1' || role === 'WAN2') pairs.push([d.id, iface]);
  }
  if (!pairs.length) return { version: 1, slots: SLOTS, profiles: [] };
  const since = new Date(now - days * 86400000).toISOString();
  const q = db.prepare(`SELECT ${SQL_SLOT} AS slot, AVG(rx_bps) AS rx, AVG(tx_bps) AS tx, AVG(rx_bps * 1.0 * rx_bps) AS rx2, COUNT(*) AS n
    FROM iface_traffic WHERE device_id=? AND iface=? AND ts>=? GROUP BY slot`);
  const rows = [];
  pairs.forEach(([id, iface], i) => { for (const r of q.all(id, iface, since)) rows.push({ ...r, series: i }); });
  return buildShapes(rows, { rand });
}

/** Keep only what a shape is allowed to contain. Anything else in a response is dropped, not trusted. */
export function sanitizeShapes(obj) {
  const ok = (a) => Array.isArray(a) && a.length === SLOTS && a.every(v => Number.isFinite(v) && v >= 0 && v <= SCALE);
  const profiles = (obj && Array.isArray(obj.profiles) ? obj.profiles : [])
    .filter(p => p && ok(p.rx) && ok(p.tx))
    .slice(0, MAX_PROFILES)
    .map(p => ({ rx: p.rx.map(Math.round), tx: p.tx.map(Math.round), jitter: Math.min(0.6, Math.max(0, Number(p.jitter) || 0.15)) }));
  return { version: 1, slots: SLOTS, profiles };
}

// ---- playback ----

/** A small, fast, seedable PRNG, so a demo reset produces the same fleet for the same seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from two uniforms. */
function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Stand-in shapes for when production has none to lend (a fresh install, or the demo started before
 * production was reachable). A business curve and a residential one, so the fleet is not uniform.
 */
export function syntheticShapes() {
  const mk = (fn, upRatio, jitter) => {
    const rx = [], tx = [];
    for (let s = 0; s < SLOTS; s++) {
      const day = Math.floor(s / SLOTS_PER_DAY), h = (s % SLOTS_PER_DAY) / 12;
      const v = fn(day, h);
      rx.push(Math.round(v * SCALE));
      tx.push(Math.round(v * upRatio * SCALE));
    }
    return { rx, tx, jitter };
  };
  const bell = (h, mu, sd) => Math.exp(-((h - mu) ** 2) / (2 * sd * sd));
  // UTC hours; Phoenix is UTC−7, so a 9am–5pm working day is 16:00–24:00 UTC.
  const business = (day, h) => {
    const weekend = day === 0 || day === 6;
    const local = (h - 7 + 24) % 24;
    const work = local >= 7 && local <= 18 ? 0.55 + 0.45 * bell(local, 12, 3) : 0.08 + 0.04 * bell(local, 2, 1); // 2am backups
    return weekend ? 0.1 + 0.08 * bell(local, 13, 4) : work;
  };
  const residential = (day, h) => {
    const local = (h - 7 + 24) % 24;
    const weekend = day === 0 || day === 6;
    return 0.06 + 0.25 * bell(local, 12, 3) * (weekend ? 1.6 : 0.8) + 0.7 * bell(local, 21, 2.2);
  };
  return { version: 1, slots: SLOTS, profiles: [mk(business, 0.35, 0.18), mk(residential, 0.12, 0.25), mk(business, 0.6, 0.12)] };
}

/**
 * One sample: the shape at this moment, scaled to this port's peak, with noise.
 *
 * Interpolates between slots so a 1-minute graph is a line, not a staircase. The noise is applied
 * multiplicatively and clipped, so a quiet 3am stays quiet and nothing ever goes negative.
 */
export function sampleAt(profile, ms, peakBps, rand = Math.random) {
  const f = slotOf(ms) + (ms % SLOT_MS) / SLOT_MS;
  const i = Math.floor(f) % SLOTS, j = (i + 1) % SLOTS, w = f - Math.floor(f);
  const at = (arr) => (arr[i] * (1 - w) + arr[j] * w) / SCALE;
  const jit = profile.jitter ?? 0.15;
  const noise = () => Math.max(0.2, 1 + gauss(rand) * jit);
  // A floor of ~1% of peak: even an idle office has something talking.
  const rx = Math.max(peakBps * 0.01, at(profile.rx) * peakBps * noise());
  const tx = Math.max(peakBps * 0.004, at(profile.tx) * peakBps * noise());
  return { rx_bps: Math.round(rx), tx_bps: Math.round(tx), load: at(profile.rx) };
}

/** Latency that rises a little with load, with the occasional spike a real link has. */
export function latencyAt(baseMs, load, rand = Math.random) {
  const spike = rand() < 0.01 ? 20 + rand() * 60 : 0;
  return Math.round((baseMs * (1 + 0.35 * load) + Math.abs(gauss(rand)) * baseMs * 0.12 + spike) * 100) / 100;
}

/**
 * The timestamps to backfill: hourly beyond a week, 5-minutely beyond a day, every minute for the
 * last day. Matches what the graphs can show at each range without a quarter-million rows per port.
 */
export function backfillTimes(now, { days = 60 } = {}) {
  const out = [];
  const minute = 60000, start = now - days * 86400000;
  let t = Math.ceil(start / 3600000) * 3600000;
  for (; t < now - 7 * 86400000; t += 3600000) out.push(t);
  t = Math.ceil(t / (5 * minute)) * 5 * minute;
  for (; t < now - 86400000; t += 5 * minute) out.push(t);
  t = Math.ceil(t / minute) * minute;
  for (; t <= now; t += minute) out.push(t);
  return out;
}
