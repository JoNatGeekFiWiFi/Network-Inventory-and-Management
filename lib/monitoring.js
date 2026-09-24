// Monitoring helpers, pure: router resource readings, Wi-Fi session tracking, MAC vendors, speed
// test results and CSV. Everything here takes plain values and returns plain values, so it is
// tested with captured device output and no network. domains/monitoring.js does the I/O.

// ---- resources ------------------------------------------------------------------------------------

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : null);

/** RouterOS uptime — "1w2d3h4m5s" (v7) or "2d05:04:03" (v6) — to seconds. */
export function rosUptimeSeconds(s) {
  if (s == null) return null;
  const str = String(s).trim();
  let secs = 0, matched = false;
  const unit = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const clock = str.match(/(\d+):(\d+):(\d+)$/);
  const head = clock ? str.slice(0, clock.index) : str;
  for (const m of head.matchAll(/(\d+)([wdhms])/g)) { secs += Number(m[1]) * unit[m[2]]; matched = true; }
  if (clock) { secs += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]); matched = true; }
  return matched ? secs : null;
}

/** GET /rest/system/resource → one reading. */
export function parseRosResource(o = {}) {
  const r = Array.isArray(o) ? o[0] || {} : o;
  const memTotal = Number(r['total-memory']), memFree = Number(r['free-memory']);
  const hddTotal = Number(r['total-hdd-space']), hddFree = Number(r['free-hdd-space']);
  const cpu = r['cpu-load'] != null ? Number(r['cpu-load']) : null;
  return {
    cpu: Number.isFinite(cpu) ? cpu : null,
    mem_pct: memTotal ? pct(memTotal - memFree, memTotal) : null,
    disk_pct: hddTotal ? pct(hddTotal - hddFree, hddTotal) : null,
    uptime_s: rosUptimeSeconds(r.uptime),
    cores: Number(r['cpu-count']) || null
  };
}

/** `df -k /overlay` (or /) → used percent of the writable flash. */
export function parseDf(text) {
  const lines = String(text || '').trim().split('\n').filter(l => /\d/.test(l));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = last.trim().split(/\s+/);
  // Filesystem 1K-blocks Used Available Use% Mounted — the numbers are what matter.
  const nums = m.filter(x => /^\d+$/.test(x)).map(Number);
  if (nums.length < 3) return null;
  const [total, used] = nums;
  return total ? pct(used, total) : null;
}

/**
 * OpenWrt `system info` (+ core count, + df) → one reading.
 *
 * CPU is load average over cores, the same approximation OpenWISP's agent uses: a busy single-core
 * router at load 1.0 is at 100%. Memory uses "available" where the kernel reports it, because free
 * memory on Linux is mostly cache and would make every router look nearly full.
 */
export function parseOwResource(info = {}, { cores = 1, dfText = null } = {}) {
  const load1 = Array.isArray(info.load) && info.load.length ? info.load[0] / 65536 : null;
  const mem = info.memory || {};
  const total = Number(mem.total) || 0;
  const avail = mem.available != null ? Number(mem.available) : (Number(mem.free) || 0) + (Number(mem.buffered) || 0) + (Number(mem.cached) || 0);
  let disk = null;
  if (info.root && Number(info.root.total)) disk = pct(Number(info.root.used ?? (info.root.total - info.root.free)), Number(info.root.total));
  else if (dfText) disk = parseDf(dfText);
  return {
    cpu: load1 == null ? null : Math.min(100, Math.round((load1 / Math.max(1, cores)) * 1000) / 10),
    mem_pct: total ? pct(total - avail, total) : null,
    disk_pct: disk,
    uptime_s: info.uptime != null ? Number(info.uptime) : null,
    cores
  };
}

/** Did it restart between two readings? Uptime going backwards is the tell. */
export const restarted = (prevUptime, nowUptime) => prevUptime != null && nowUptime != null && nowUptime + 60 < prevUptime;

// ---- Wi-Fi sessions -------------------------------------------------------------------------------

const normMac = (m) => String(m || '').trim().toUpperCase().replace(/-/g, ':');

/**
 * Compare who is connected now with the sessions still open.
 *   open:    [{ id, mac }]            sessions without an end
 *   clients: [{ mac, iface, ssid, signal }]
 * → { start: [client…], seen: [{ id, client }], end: [id…] }
 */
export function diffSessions(open, clients) {
  const now = new Map();
  for (const c of clients || []) { const m = normMac(c.mac); if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m)) now.set(m, { ...c, mac: m }); }
  const byMac = new Map((open || []).map(s => [normMac(s.mac), s]));
  const start = [], seen = [], end = [];
  for (const [mac, c] of now) { const s = byMac.get(mac); if (s) seen.push({ id: s.id, client: c }); else start.push(c); }
  for (const [mac, s] of byMac) if (!now.has(mac)) end.push(s.id);
  return { start, seen, end };
}

/** A locally administered MAC (second-lowest bit of the first octet) — a phone's private address. */
export const isRandomizedMac = (mac) => { const b = parseInt(normMac(mac).slice(0, 2), 16); return Number.isFinite(b) && (b & 2) === 2; };

/** IEEE oui.csv → Map('3C22FB' → 'Apple, Inc.'). */
export function parseOuiCsv(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    // Registry,Assignment,Organization Name,Organization Address — names may be quoted with commas.
    const m = line.match(/^MA-L,([0-9A-Fa-f]{6}),("([^"]*)"|[^,]*)/);
    if (m) map.set(m[1].toUpperCase(), (m[3] != null ? m[3] : m[2]).trim());
  }
  return map;
}
export function vendorOf(mac, oui) {
  if (isRandomizedMac(mac)) return 'Private (randomized address)';
  if (!oui) return null;
  return oui.get(normMac(mac).replace(/:/g, '').slice(0, 6)) || null;
}

// ---- speed test -----------------------------------------------------------------------------------

/** Mbps from bytes over seconds, to one decimal. */
export const mbps = (bytes, seconds) => (seconds > 0 ? Math.round((bytes * 8 / seconds / 1e6) * 10) / 10 : null);

/** RouterOS /tool/fetch result list → { bytes, seconds } from its last progress entry. */
export function parseRosFetch(list) {
  const arr = Array.isArray(list) ? list : [list];
  const last = [...arr].reverse().find(x => x && (x.downloaded != null || x.total != null)) || arr[arr.length - 1] || {};
  if (last.status && /fail/i.test(last.status)) throw new Error(last['.about'] || last.status);
  const kib = Number(last.downloaded ?? last.total);
  const seconds = rosUptimeSeconds(last.duration) ?? Number(last.duration);
  return { bytes: Number.isFinite(kib) ? kib * 1024 : null, seconds: Number.isFinite(seconds) ? seconds : null };
}

/** Output of the OpenWrt timing one-liner: "<bytes> <uptime before> <uptime after>". */
export function parseOwFetch(text) {
  const m = String(text || '').trim().match(/(\d+)\s+([\d.]+)\s+([\d.]+)\s*$/);
  if (!m) return { bytes: null, seconds: null };
  const seconds = Math.round((Number(m[3]) - Number(m[2])) * 100) / 100;
  return { bytes: Number(m[1]), seconds: seconds > 0 ? seconds : 0.01 };
}

// ---- CSV ------------------------------------------------------------------------------------------

/**
 * Rows → CSV text. Values that a spreadsheet would treat as a formula (=, +, -, @ at the start) are
 * prefixed with a quote mark, so an exported hostname cannot become a live formula when opened.
 */
export function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const cell = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
