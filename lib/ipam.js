// CIDR arithmetic, for putting WireGuard alongside ZeroTier without them colliding.
//
// The whole point of this file is one question: given the range ZeroTier already manages, which
// range can WireGuard safely use so that devices on both can reach each other? The instinct is to
// put them in the SAME subnet — but two independent L3 overlays sharing a subnet do not
// interconnect, they fight. A ZeroTier member treats a WireGuard address as on-link, ARPs for it
// into the ZeroTier fabric, and never routes to it; meanwhile the hub has two interfaces claiming
// the same prefix and picks one arbitrarily.
//
// What works is a shared SUPERNET split into two non-overlapping halves, with the hub routing
// between them. Each side sees the other as "somewhere in 10.147/16, reachable via the hub", which
// is what people actually mean when they say "same subnet".
//
// Every function here is pure, because an off-by-one in a netmask produces an overlap that looks
// fine until two devices silently share an address.

const MAX_U32 = 0xFFFFFFFF;

export const ipToInt = (ip) => {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
};

export const intToIp = (n) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

/** Parse "10.147.20.0/24" into its numeric parts. Returns null for anything malformed. */
export function parseCidr(cidr) {
  const m = String(cidr || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const addr = ipToInt(m[1]);
  if (addr === null) return null;
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (bits < 0 || bits > 32) return null;
  // A /0 mask cannot be produced by shifting 32 places — JavaScript shifts modulo 32, so
  // `0xffffffff << 32` is 0xffffffff, not 0. That would silently turn 0.0.0.0/0 into a /32.
  const maskInt = bits === 0 ? 0 : ((MAX_U32 << (32 - bits)) >>> 0);
  const network = (addr & maskInt) >>> 0;
  const broadcast = (network | (~maskInt >>> 0)) >>> 0;
  return { network, broadcast, bits, mask: maskInt, size: 2 ** (32 - bits) };
}

export const formatCidr = (network, bits) => `${intToIp(network)}/${bits}`;

/** Do these two ranges share any address at all? */
export function overlaps(a, b) {
  const x = parseCidr(a), y = parseCidr(b);
  if (!x || !y) return false;
  return x.network <= y.broadcast && y.network <= x.broadcast;
}

/** Is `inner` entirely inside `outer`? */
export function contains(outer, inner) {
  const o = parseCidr(outer), i = parseCidr(inner);
  if (!o || !i) return false;
  return i.network >= o.network && i.broadcast <= o.broadcast;
}

/** Is this address inside this range? */
export function inRange(cidr, ip) {
  const c = parseCidr(cidr), n = ipToInt(ip);
  if (!c || n === null) return false;
  return n >= c.network && n <= c.broadcast;
}

/**
 * The smallest single CIDR containing every range given.
 *
 * Used to describe the supernet both overlays live in, which is what goes in `AllowedIPs` on the
 * peers and in the route ZeroTier advertises.
 */
export function supernetOf(cidrs) {
  const parsed = (cidrs || []).map(parseCidr).filter(Boolean);
  if (!parsed.length) return null;
  const lo = parsed.reduce((m, p) => Math.min(m, p.network), MAX_U32) >>> 0;
  const hi = parsed.reduce((m, p) => Math.max(m, p.broadcast), 0) >>> 0;
  // Walk the prefix outward until one block covers both ends.
  for (let bits = 32; bits >= 0; bits--) {
    const mask = bits === 0 ? 0 : ((MAX_U32 << (32 - bits)) >>> 0);
    if (((lo & mask) >>> 0) === ((hi & mask) >>> 0)) return formatCidr((lo & mask) >>> 0, bits);
  }
  return '0.0.0.0/0';
}

/** Private ranges, so a plan can warn when a proposal strays outside RFC 1918. */
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
export const isPrivate = (cidr) => PRIVATE.some(p => contains(p, cidr));

/**
 * Choose a range of `bits` size that sits beside `taken` inside `within`, overlapping nothing.
 *
 * Scans on the natural boundary for the requested size, so the result is a well-formed subnet
 * rather than an arbitrary offset — anything else confuses both humans and routers.
 */
export function carveRange(within, taken = [], bits = 24) {
  const outer = parseCidr(within);
  if (!outer || bits < outer.bits || bits > 30) return null;
  const step = 2 ** (32 - bits);
  const busy = (taken || []).map(parseCidr).filter(Boolean);
  for (let net = outer.network; net <= outer.broadcast; net += step) {
    const candidate = formatCidr(net >>> 0, bits);
    const c = parseCidr(candidate);
    if (c.broadcast > outer.broadcast) break;
    if (!busy.some(b => c.network <= b.broadcast && b.network <= c.broadcast)) return candidate;
  }
  return null;
}

/**
 * Work out where WireGuard should live, given what ZeroTier already manages.
 *
 * Returns the proposal AND its reasoning, because this is a decision someone has to agree with
 * before it is applied to a live network — and because "why did it pick that?" is the first
 * question anyone sensible asks.
 *
 * @param ztRanges  ranges ZeroTier manages (its assignment pools and routes)
 * @param opts.preferBits  size of the WireGuard range (default /24 — 254 devices)
 */
export function planOverlay(ztRanges = [], { preferBits = 24, existingWg = null } = {}) {
  const zt = (ztRanges || []).map(r => String(r).trim()).filter(r => parseCidr(r));
  const notes = [];

  if (!zt.length) {
    // Nothing to avoid: pick a quiet corner of RFC 1918 and describe it plainly.
    const wg = existingWg && parseCidr(existingWg) ? existingWg : '10.147.21.0/24';
    const supernet = supernetOf([wg]) === wg ? '10.147.0.0/16' : supernetOf([wg]);
    notes.push('No ZeroTier ranges were found, so this is a standalone plan. Re-run it once ZeroTier is reachable and the ranges will be checked for overlap.');
    return { ok: true, zt_ranges: [], wg_range: wg, supernet, notes, standalone: true };
  }

  // If WireGuard is already configured and does not clash, leave it alone. Renumbering a live
  // overlay is disruptive and is never the right default.
  if (existingWg && parseCidr(existingWg) && !zt.some(r => overlaps(r, existingWg))) {
    const supernet = supernetOf([...zt, existingWg]);
    notes.push('The existing WireGuard range does not overlap ZeroTier, so it has been kept.');
    if (parseCidr(supernet).bits < 8) notes.push('The two ranges are far apart, so the supernet covering both is very large. Moving WireGuard next to ZeroTier would keep routing tidier.');
    return { ok: true, zt_ranges: zt, wg_range: existingWg, supernet, notes, kept: true };
  }
  if (existingWg && zt.some(r => overlaps(r, existingWg)))
    notes.push(`The current WireGuard range ${existingWg} overlaps ZeroTier, which is why it is being moved. Devices already issued an address from it must be re-provisioned.`);

  // Prefer a range immediately beside ZeroTier inside a supernet one step larger, so both sit in
  // one tidy block that is easy to route and easy to read.
  const ztSuper = supernetOf(zt);
  const s = parseCidr(ztSuper);
  for (let bits = Math.max(8, s.bits - 1); bits >= 8; bits--) {
    const container = formatCidr((s.network & (bits === 0 ? 0 : (MAX_U32 << (32 - bits)) >>> 0)) >>> 0, bits);
    const wg = carveRange(container, zt, preferBits);
    if (wg) {
      notes.push(`ZeroTier manages ${zt.join(', ')}. WireGuard takes ${wg}, which does not overlap it.`);
      notes.push(`Both sit inside ${container}. Put that in AllowedIPs on the WireGuard peers and advertise it from ZeroTier, and the two sides can reach each other through this server.`);
      if (!isPrivate(container)) notes.push('Warning: this range is outside RFC 1918 private space. Check it is really yours to use.');
      return { ok: true, zt_ranges: zt, wg_range: wg, supernet: container, notes };
    }
  }
  return { ok: false, zt_ranges: zt, wg_range: null, supernet: null,
    notes: ['Could not find a free range beside ZeroTier. Choose the WireGuard range by hand.'] };
}

/**
 * The next unused host address in a range.
 *
 * Skips the network address, the hub's own address, and anything already handed out. The broadcast
 * address is skipped too: WireGuard itself would not care, but plenty of equipment refuses to
 * accept it and it costs nothing to avoid.
 */
export function nextFreeAddress(cidr, taken = [], { reserve = [] } = {}) {
  const c = parseCidr(cidr);
  if (!c) return null;
  const used = new Set();
  for (const t of [...(taken || []), ...(reserve || [])]) {
    const n = ipToInt(String(t).split('/')[0]);
    if (n !== null) used.add(n);
  }
  const first = (c.network + 1) >>> 0;
  const last = c.bits >= 31 ? c.broadcast : (c.broadcast - 1) >>> 0;
  for (let n = first; n <= last; n++) if (!used.has(n)) return intToIp(n);
  return null;
}

/** The hub's own address in a range, .1 by convention. */
export function hubAddress(cidr) {
  const c = parseCidr(cidr);
  return c ? intToIp((c.network + 1) >>> 0) : null;
}

/** How many usable host addresses a range holds, and how many are still free. */
export function capacity(cidr, taken = []) {
  const c = parseCidr(cidr);
  if (!c) return null;
  const total = Math.max(0, c.size - 2);              // network + broadcast
  const used = new Set((taken || []).map(t => ipToInt(String(t).split('/')[0])).filter(n => n !== null && n > c.network && n < c.broadcast));
  return { total, used: used.size, free: Math.max(0, total - used.size) };
}
