// OpenWrt — including vendor builds of it, such as the Katalyst Spark.
//
// THE DESIGN DECISION THAT MAKES THIS SMALL: everything goes through ubus.
//
// OpenWrt has one internal message bus, and both ways in speak to it identically:
//
//   * over HTTP, as JSON-RPC to /ubus  (needs uhttpd-mod-ubus + rpcd, which LuCI already pulls in)
//   * over SSH,  as `ubus -S call <object> <method>`
//
// Both return the SAME JSON. So there are two transports and ONE set of parsers, rather than an
// HTTP implementation and a completely separate screen-scraper. That matters a lot for the vendor
// skins: a manufacturer who has replaced LuCI with their own web interface has usually left rpcd
// and dropbear alone underneath, and if they have disabled the HTTP endpoint the SSH path reaches
// exactly the same objects with exactly the same output. If neither works the device is genuinely
// closed, and the prober says so rather than the poller failing mysteriously every five minutes.
//
// Vendor skins are the reason nothing here assumes a value exists. A rebranded build routinely
// renames the board, strips iwinfo, omits the release block, or serves a cut-down ACL where
// `system board` succeeds and `network.device status` returns permission denied. Every parser
// tolerates absence and reports what it did get.

/** The session id that means "not logged in yet" — the only one `session login` accepts. */
export const NULL_SESSION = '00000000000000000000000000000000';

/**
 * ubus error codes, from libubus. Worth translating: the raw response to a missing ACL is the
 * integer 6, which tells a technician nothing.
 */
export const UBUS_ERRORS = {
  0: null,
  1: 'invalid command',
  2: 'invalid argument',
  3: 'method not found — that ubus object is not installed on this device',
  4: 'not found',
  5: 'no data',
  6: 'permission denied — the login is valid but its rpcd ACL does not grant this object',
  7: 'timed out',
  8: 'not supported on this device',
  9: 'unknown error',
  10: 'connection failed'
};

/** Build a ubus JSON-RPC envelope. Pure, so the request shape is testable without a router. */
export function rpcEnvelope(session, object, method, params = {}, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'call',
    params: [session || NULL_SESSION, object, method, params || {}]
  };
}

export const loginEnvelope = (username, password, id = 1) =>
  rpcEnvelope(NULL_SESSION, 'session', 'login', { username: String(username ?? ''), password: String(password ?? '') }, id);

/**
 * Unwrap a ubus JSON-RPC reply.
 *
 * The shape is awkward: success is `result: [code, payload]`, where a NON-ZERO code is still
 * delivered as an HTTP 200 with a JSON-RPC "result". Treating the presence of `result` as success —
 * the obvious reading — silently turns "permission denied" into an empty interface list, and the
 * device then appears to have no ports rather than appearing unreachable. So the code is checked.
 */
export function parseRpc(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; }
  catch { return { ok: false, error: 'The device did not return JSON (is this the ubus endpoint?)' }; }
  if (!j || typeof j !== 'object') return { ok: false, error: 'Empty response from the device' };

  if (j.error) {
    const m = j.error.message || String(j.error.code ?? 'error');
    // -32002 is rpcd's "access denied", which is what an expired or wrong session looks like.
    const expired = j.error.code === -32002;
    return { ok: false, error: expired ? 'The session was rejected (wrong password, or it expired)' : m, expired };
  }

  const r = j.result;
  if (!Array.isArray(r)) {
    // `list` and a few others answer with a bare object rather than [code, payload].
    return r && typeof r === 'object' ? { ok: true, data: r } : { ok: false, error: 'Unexpected ubus reply' };
  }
  const [code, payload] = r;
  if (code !== 0) return { ok: false, code, error: UBUS_ERRORS[code] || `ubus error ${code}` };
  return { ok: true, data: payload ?? {} };
}

/** Pull the session id out of a successful `session login`. */
export function sessionFromLogin(parsed) {
  if (!parsed || !parsed.ok) return null;
  const d = parsed.data || {};
  const sid = d.ubus_rpc_session || d.sid || null;
  return typeof sid === 'string' && /^[0-9a-f]{32}$/i.test(sid) ? sid : null;
}

// ---- parsers -----------------------------------------------------------------------------------
//
// One per ubus object, each taking the object's payload and returning our own shape. Kept pure and
// exported so they can be tested against captured output from a real device — which is how the
// vendor-skin differences will actually get handled: capture, add a case, keep the test.

/** `system board` → what the device is. */
export function parseBoard(d = {}) {
  const rel0 = d.release || {};
  // Trim every string on the way in. This build's description is literally "OpenWrt 21.02-SNAPSHOT "
  // with a trailing space, which then rides into the version column, the device list and anything
  // comparing versions — where a value that looks identical but is not is genuinely hard to see.
  const rel = {};
  for (const [k, v] of Object.entries(rel0)) rel[k] = typeof v === 'string' ? v.trim() : v;
  const t = (v) => (typeof v === 'string' ? v.trim() || null : v ?? null);

  return {
    hostname: t(d.hostname),
    model: t(d.model) || t(d.board_name),
    board: t(d.board_name),
    // A vendor build usually leaves its own name here, which is how a Katalyst identifies itself.
    distribution: rel.distribution || null,
    version: rel.version || null,
    revision: rel.revision || null,
    target: rel.target || null,
    description: rel.description || null,
    kernel: t(d.kernel),
    // The version string the rest of the app displays. Vendor first, because "Katalyst 1.4.2" is
    // more use to a technician than "OpenWrt 23.05.3" when both are true.
    osVersion: rel.description || [rel.distribution, rel.version].filter(Boolean).join(' ') || t(d.kernel)
  };
}

/** `system info` → uptime and load. */
export function parseSysinfo(d = {}) {
  const load = Array.isArray(d.load) ? d.load : [];
  return {
    uptime: Number(d.uptime) || 0,
    localtime: Number(d.localtime) || null,
    // ubus reports load fixed-point, scaled by 65536.
    load1: load.length ? +(load[0] / 65536).toFixed(2) : null,
    load5: load.length > 1 ? +(load[1] / 65536).toFixed(2) : null,
    load15: load.length > 2 ? +(load[2] / 65536).toFixed(2) : null,
    memTotal: d.memory ? Number(d.memory.total) || 0 : 0,
    memFree: d.memory ? Number(d.memory.free) || 0 : 0
  };
}

/**
 * `network.device status` → the physical ports.
 *
 * Note `up` and `carrier` mean different things and both matter: `up` is administrative (the
 * interface is enabled), `carrier` is physical (something is plugged in and linked). RouterOS calls
 * those `disabled` and `running`, and mapping them the wrong way round would show every unplugged
 * port as live.
 */
/**
 * Classify a port from its name.
 *
 * Needed because ubus's own `type` is not reliably informative: the Katalyst build reports the
 * literal string "Network device" for every physical port, radio and tunnel alike. Taking that at
 * face value tagged six radios as ordinary ethernet and made the type column useless.
 *
 * The radio names are MediaTek's, not Linux's — ra0/rax0 for the APs and apcli0/apclix0 for the
 * client (repeater) side, where a mainline build would say wlan0. A pattern list written only from
 * the OpenWrt docs misses all four.
 */
export function classifyIface(name, reported = '') {
  if (/^lo$/.test(name)) return 'loopback';
  if (/^(zt[a-z0-9]+|wg\d|tun\d|tap\d)/.test(name)) return 'overlay';
  if (/^(wlan|wl\d|ra\d|rax\d|apcli|apclix|ath\d|phy\d)/.test(name)) return 'wifi';
  if (/^(rmnet|wwan|usb\d|mhi)/.test(name)) return 'cellular';
  if (/^br-/.test(name) || reported === 'bridge') return 'bridge';
  if (/^(eth|lan|wan|swp|sfp)/.test(name)) return 'ether';
  // Fall back to what the device said, unless it said the unhelpful thing.
  return reported && reported !== 'Network device' ? reported : 'ether';
}

export function parseDevices(d = {}) {
  const out = [];
  for (const [name, v] of Object.entries(d || {})) {
    if (!v || typeof v !== 'object') continue;
    const type = classifyIface(name, v.type);
    // Loopback is not a port. It appears in ubus, it is on every device, and it tells nobody
    // anything — leaving it in just pushes a real port off the top of the card.
    if (type === 'loopback') continue;
    const st = v.statistics || {};
    out.push({
      name,
      type,
      running: v.carrier === true || v.carrier === 1 || (v.carrier === undefined && v.up === true),
      disabled: v.up === false,
      // `present: false` means the hardware is not there at all (an SFP cage with no module, a
      // modem that has not enumerated). That is a third state, and conflating it with "down" sends
      // someone looking for a cable fault on a port that does not physically exist.
      absent: v.present === false,
      mac: normMac(v.macaddr),
      ips: [],
      // A virtual interface's "link speed" is whatever the kernel invented for it — the ZeroTier
      // interface on this hardware claims 10 Mbit/s. Reporting that next to a real port invites
      // someone to go and fix a management overlay that is not slow.
      speed: type === 'overlay' ? '' : formatSpeed(v),
      comment: '',
      rxBytes: Number(st.rx_bytes) || 0,
      txBytes: Number(st.tx_bytes) || 0,
      rxErrors: Number(st.rx_errors) || 0,
      txErrors: Number(st.tx_errors) || 0
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Link speed, which different OpenWrt versions report three different ways. */
function formatSpeed(v = {}) {
  const dup = (x) => (x === 'full' || x === true ? '-full' : x === 'half' || x === false ? '-half' : '');
  // 2.5G, 5G and 10G ports are ordinary now — the Katalyst Spark's WAN is one — and 2500 is not a
  // whole number of gigabits. Dividing only when it divides evenly printed that port as "2500Mbps".
  const rate = (mb) => {
    if (mb < 1000) return `${mb}Mbps`;
    const g = mb / 1000;
    return `${Number.isInteger(g) ? g : +g.toFixed(1)}Gbps`;
  };
  // 23.05+: speed as a number of Mbit/s alongside a duplex flag
  if (typeof v.speed === 'number') return v.speed > 0 ? rate(v.speed) + dup(v.duplex) : '';
  // Older builds use a string like "1000F" / "100H" — and, when there is no link, "-1F".
  //
  // The minus sign is the whole point of this branch. The original pattern did not allow one, so
  // "-1F" fell through to "return it verbatim" and an unplugged 2.5G port displayed its link speed
  // as "-1F". Every ethernet port on the Katalyst reports exactly that when nothing is connected.
  if (typeof v.speed === 'string') {
    const m = v.speed.match(/^(-?\d+)([FH])?$/i);
    if (m) {
      const mb = Number(m[1]);
      if (mb <= 0) return '';          // -1 means "no link", not a speed
      return rate(mb) + (m[2] ? (m[2].toUpperCase() === 'F' ? '-full' : '-half') : '');
    }
    return v.speed;
  }
  if (v.link && typeof v.link.speed === 'number') return v.link.speed > 0 ? rate(v.link.speed) + dup(v.link.duplex) : '';
  return '';
}

/**
 * `network.interface dump` → logical interfaces, which is where the addresses live.
 *
 * OpenWrt separates the two: `lan` is a logical interface with an IP, riding on the device `br-lan`.
 * The device page wants both — the port that is plugged in, and the address it carries.
 */
export function parseInterfaceDump(d = {}) {
  const list = Array.isArray(d.interface) ? d.interface : [];
  return list.map(i => ({
    name: i.interface,
    device: i.l3_device || i.device || null,
    proto: i.proto || null,
    up: i.up === true,
    pending: i.pending === true,
    uptime: Number(i.uptime) || 0,
    ipv4: (i['ipv4-address'] || []).map(a => a.address).filter(Boolean),
    ipv6: (i['ipv6-address'] || []).map(a => a.address).filter(Boolean),
    // The default route's gateway, which identifies the WAN without guessing from the name.
    gateway: (i.route || []).filter(r => r.target === '0.0.0.0' && (r.mask === 0 || r.mask === '0'))
      .map(r => r.nexthop).filter(Boolean)[0] || null
  }));
}

/** Fold logical addresses onto the physical ports, so one list answers "what is this port doing". */
export function mergeInterfaces(devices, logical) {
  const byDev = new Map();
  for (const l of logical || []) {
    if (!l.device) continue;
    const cur = byDev.get(l.device) || { ips: [], names: [] };
    cur.ips.push(...l.ipv4);
    cur.names.push(l.name);
    byDev.set(l.device, cur);
  }
  return (devices || []).map(dev => {
    const m = byDev.get(dev.name);
    return m ? { ...dev, ips: [...new Set(m.ips)], comment: m.names.join(', ') } : dev;
  });
}

/**
 * `iwinfo info` → one radio.
 *
 * ENCRYPTION IS THE DANGEROUS FIELD HERE. The original code read "no encryption block" as "open",
 * which is a reasonable-looking assumption and wrong: this MediaTek build omits the block entirely
 * on every radio, including WPA2 ones. The device page would have told a technician that a
 * customer's WiFi was unencrypted. Absent now means UNKNOWN, and only an explicit `enabled: false`
 * means open — a gap in reporting is much safer than a confident false statement about security.
 */
export function parseIwinfo(name, d = {}) {
  let encryption;
  if (!d.encryption || typeof d.encryption.enabled !== 'boolean') encryption = null;   // not reported
  else if (!d.encryption.enabled) encryption = 'open';
  else encryption = [].concat(
      d.encryption.authentication || [],
      d.encryption.wpa ? 'wpa' + [].concat(d.encryption.wpa).join('/') : []
    ).join(' ') || 'on';

  return {
    iface: name,
    ssid: d.ssid || '',
    // Never a passphrase: iwinfo does not expose one, and this driver does not read UCI secrets.
    password: '',
    // Master is an access point; Client is the repeater/uplink side of the radio. Keeping it is
    // what lets the summary tell a real SSID from an unused client interface.
    mode: d.mode || '',
    channel: d.channel ?? null,
    band: d.frequency ? (d.frequency >= 5000 ? '5ghz' : d.frequency >= 2400 ? '2ghz' : '') : '',
    // "ax" / "HE40" — worth showing, since WiFi 6 vs WiFi 5 is a normal support question.
    standard: d.hwmode || '',
    width: d.htmode || '',
    txpower: d.txpower ?? null,
    signal: d.signal ?? null,
    noise: d.noise ?? null,
    encryption,
    disabled: false
  };
}

/** `iwinfo assoclist` → associated stations. */
export function parseAssoclist(d = {}, iface = '') {
  const rows = Array.isArray(d.results) ? d.results : [];
  return rows.map(r => ({
    iface,
    mac: normMac(r.mac),
    signal: r.signal ?? null,
    noise: r.noise ?? null,
    // ubus counts inactivity in milliseconds; seconds is what the UI shows everywhere else.
    idleSeconds: r.inactive != null ? Math.round(Number(r.inactive) / 1000) : null,
    rxRate: r.rx && r.rx.rate ? Math.round(r.rx.rate / 1000) : null,   // kbit/s → Mbit/s
    txRate: r.tx && r.tx.rate ? Math.round(r.tx.rate / 1000) : null
  }));
}

/**
 * `network.wireless status` → the CONFIGURED state of each radio.
 *
 * This is the answer to the encryption problem. iwinfo reports what the driver is doing and, on
 * MediaTek hardware, omits the encryption block entirely — leaving the platform unable to say
 * whether a customer's WiFi was protected. network.wireless reports what UCI was told to do, and
 * it states `encryption: "psk2"` outright.
 *
 * It is also where `hidden` and `isolate` live, neither of which iwinfo exposes.
 *
 * The `key` is present in this payload and is deliberately NOT read: nothing in the monitoring path
 * needs a customer's WiFi password, and a value that is never loaded cannot leak from a log, an API
 * response or a database column.
 */
export function parseWirelessStatus(d = {}) {
  const out = [];
  for (const [radio, r] of Object.entries(d || {})) {
    if (!r || typeof r !== 'object') continue;
    const rc = r.config || {};
    for (const i of r.interfaces || []) {
      const c = i.config || {};
      if (!c.ifname) continue;
      out.push({
        iface: c.ifname,
        radio,
        ssid: c.ssid || '',
        // psk2 = WPA2-PSK, sae = WPA3, psk-mixed = WPA/WPA2, none = open.
        encryption: c.encryption || null,
        mode: c.mode || '',
        hidden: c.hidden === true,
        isolate: c.isolate === true,
        network: [].concat(c.network || []),
        radioDisabled: rc.disabled === true || rc.disabled === '1',
        band: rc.band || '',
        channel: rc.channel ?? null,
        htmode: rc.htmode || ''
      });
    }
  }
  return out;
}

/** Human wording for a UCI encryption value. */
export function describeEncryption(v) {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s === 'none') return 'open';
  if (/^sae-mixed/.test(s)) return 'WPA2/WPA3';
  if (/^sae/.test(s)) return 'WPA3';
  if (/^psk2\+|^psk2$/.test(s)) return 'WPA2';
  if (/^psk-mixed|^psk\+psk2|^mixed/.test(s)) return 'WPA/WPA2';
  if (/^psk/.test(s)) return 'WPA';
  if (/^wpa3/.test(s)) return 'WPA3-Enterprise';
  if (/^wpa2/.test(s)) return 'WPA2-Enterprise';
  if (/^wpa/.test(s)) return 'WPA-Enterprise';
  if (/^wep/.test(s)) return 'WEP (insecure)';
  return String(v);
}

/**
 * DHCP leases.
 *
 * Two sources, because which one exists depends on whether LuCI is installed — and on a vendor skin
 * it often is not. `luci-rpc getDHCPLeases` when present, otherwise the raw /tmp/dhcp.leases file,
 * whose format is: `<expiry epoch> <mac> <ip> <hostname> <client-id>`.
 */
export function parseLuciLeases(d = {}) {
  const rows = [].concat(d.dhcp_leases || [], d.leases || []);
  return rows.map(l => ({
    id: l.macaddr || l.ipaddr,
    address: l.ipaddr || '',
    mac: normMac(l.macaddr),
    host: l.hostname && l.hostname !== '?' ? l.hostname : '',
    server: 'dnsmasq',
    status: 'bound',
    dynamic: true,
    expires: l.expires != null ? secondsToSpan(Number(l.expires)) : '',
    blocked: false, disabled: false, lastSeen: '', comment: ''
  }));
}

export function parseLeaseFile(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const [expiry, mac, ip, host] = p;
    if (!/^\d+$/.test(expiry) || !/^[0-9a-f:]{17}$/i.test(mac)) continue;
    const secs = Number(expiry) === 0 ? null : Number(expiry) - Math.floor(Date.now() / 1000);
    out.push({
      id: mac,
      address: ip,
      mac: normMac(mac),
      host: host && host !== '*' ? host : '',
      server: 'dnsmasq',
      status: 'bound',
      // Expiry 0 is dnsmasq's marker for a static (infinite) lease, not one that expired in 1970.
      dynamic: Number(expiry) !== 0,
      expires: secs == null ? 'static' : secs > 0 ? secondsToSpan(secs) : 'expired',
      blocked: false, disabled: false, lastSeen: '', comment: ''
    });
  }
  return out;
}

// ---- cellular signal ----------------------------------------------------------------------------
//
// On a 5G CPE fleet this is the single most useful measurement there is. "The internet is slow" and
// "RSRP fell from -95 to -108 dBm on Tuesday afternoon" are the same ticket, but only one of them
// can be acted on — and the second one distinguishes a customer who needs an antenna repositioned
// from one whose cell site is congested.
//
// The vendor object hands back a RING BUFFER, not a single reading: 181 samples at ten-second
// intervals, half an hour of history. That is finer resolution than this platform's own poll cycle,
// so the samples are ingested rather than reduced to one value — polling once a minute and keeping
// everything gives a complete ten-second trace with no gaps.

/** Thresholds from 3GPP practice. Deliberately conservative: -100 dBm RSRP is already marginal. */
const SIGNAL_GRADES = {
  rsrp: [[-80, 'excellent'], [-90, 'good'], [-100, 'fair'], [-110, 'poor'], [-Infinity, 'very poor']],
  sinr: [[20, 'excellent'], [13, 'good'], [0, 'fair'], [-Infinity, 'poor']],
  rsrq: [[-10, 'excellent'], [-15, 'good'], [-20, 'fair'], [-Infinity, 'poor']]
};

export function gradeSignal(metric, value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const table = SIGNAL_GRADES[metric];
  if (!table) return null;
  for (const [threshold, label] of table) if (Number(value) >= threshold) return label;
  return null;
}

const RANK = { excellent: 4, good: 3, fair: 2, poor: 1, 'very poor': 0 };

/**
 * `modem.signal get_signals` → normalised samples, newest first.
 *
 * Every field is optional: a build on a different modem may report RSRP without SINR, or report a
 * bare RSSI on LTE. Nothing is invented to fill a gap — a missing metric stays null, because a
 * fabricated signal reading is worse than an absent one when someone is deciding whether to roll a
 * truck.
 */
export function parseModemSignal(d = {}) {
  const raw = Array.isArray(d.signals) ? d.signals : (Array.isArray(d) ? d : []);
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  const samples = raw.map(s => ({
    ts: num(s.timestamp) ? new Date(num(s.timestamp) * 1000).toISOString() : null,
    rsrp: num(s.rsrp),
    rsrq: num(s.rsrq),
    sinr: num(s.sinr),
    rssi: num(s.rssi),
    // 0-5 bars, which is what the device's own display shows the customer — useful when a caller
    // says "it shows two bars".
    bars: num(s.strength),
    networkType: s.network_type || null,
    slot: num(s.slot)
  })).filter(s => s.ts).sort((a, b) => (a.ts < b.ts ? 1 : -1));

  if (!samples.length) return { available: false, latest: null, samples: [], summary: null };

  const latest = samples[0];
  const stat = (k) => {
    const v = samples.map(s => s[k]).filter(x => x != null);
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v), avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) };
  };

  const grades = { rsrp: gradeSignal('rsrp', latest.rsrp), sinr: gradeSignal('sinr', latest.sinr), rsrq: gradeSignal('rsrq', latest.rsrq) };
  // The overall verdict is the WORST component, not an average. A good RSRP with terrible SINR is a
  // connection that does not work, and averaging would report it as fine.
  const present = Object.values(grades).filter(Boolean);
  const overall = present.length ? present.reduce((w, g) => (RANK[g] < RANK[w] ? g : w)) : null;

  const span = samples.length > 1 ? (Date.parse(samples[0].ts) - Date.parse(samples[samples.length - 1].ts)) / 1000 : 0;

  return {
    available: true,
    latest,
    samples,
    summary: {
      count: samples.length,
      spanSeconds: Math.round(span),
      networkType: latest.networkType,
      grades,
      overall,
      rsrp: stat('rsrp'), sinr: stat('sinr'), rsrq: stat('rsrq'), rssi: stat('rssi')
    }
  };
}

/**
 * `ip -o -4 addr` → addresses straight from the kernel.
 *
 * Needed because UCI does not know everything. ZeroTier brings its own interface up and assigns its
 * own address without going through the network config, so `network.interface dump` reports the
 * `zerotier` interface with proto "none" and no address at all — and the management overlay, the
 * very address the platform is talking to the device ON, showed as blank on its own page.
 *
 * The kernel has no such gap: if the address is on the interface, it is here.
 */
export function parseIpAddr(text) {
  const by = {};
  for (const line of String(text || '').split('\n')) {
    // 2: br-lan    inet 192.168.8.1/24 brd ... scope global br-lan
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (!m) continue;
    const [, iface, ip] = m;
    if (iface === 'lo') continue;
    (by[iface] = by[iface] || []).push(ip);
  }
  return by;
}

/**
 * Round-trip time from a ping, in milliseconds.
 *
 * Two formats, because busybox and iputils disagree and OpenWrt ships busybox: the summary line
 * when there is one, otherwise the average of the individual replies. Returns null when nothing
 * answered, which is itself the useful reading — a WAN that does not respond is the fault.
 */
export function parsePingMs(text) {
  const s = String(text || '');
  const summary = s.match(/min\/avg\/max(?:\/m?dev)?\s*=\s*[\d.]+\/([\d.]+)\//);
  if (summary) return Math.round(Number(summary[1]) * 100) / 100;
  const times = [...s.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)].map(m => Number(m[1])).filter(Number.isFinite);
  if (!times.length) return null;
  return Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100;
}

/** Failed-login sources from `logread`, matching what harvestThreats does for RouterOS. */
export function parseLogLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    out.push({ message: line.trim() });
  }
  return out;
}

// ---- small shared helpers ----------------------------------------------------------------------

function normMac(m) {
  const s = String(m || '').trim().toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(s) ? s : (s || '');
}

/** Seconds → RouterOS-style span ("2d3h4m"), so both platforms read alike in the same table. */
export function secondsToSpan(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s % 60}s`;
  return `${s}s`;
}

// ---- transports --------------------------------------------------------------------------------

/**
 * ubus over HTTP.
 *
 * Logs in once and reuses the session; rpcd sessions expire (300s by default) and the retry on a
 * rejected session is what stops a five-minute poll cycle from failing every other run.
 */
export function httpTransport({ host, username, password, port = null, https = false, fetchImpl = fetch, timeoutMs = 8000 }) {
  let session = null;
  const base = `${https ? 'https' : 'http'}://${host}${port ? ':' + port : ''}/ubus`;

  async function post(payload) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal
      });
      return parseRpc(await r.text());
    } catch (e) {
      const why = e.name === 'AbortError' ? `no response within ${timeoutMs / 1000}s` : e.message;
      return { ok: false, error: `Could not reach ${base}: ${why}`, unreachable: true };
    } finally { clearTimeout(timer); }
  }

  async function login() {
    const p = await post(loginEnvelope(username, password));
    if (!p.ok) return { ok: false, error: p.unreachable ? p.error : `Login refused: ${p.error}` };
    const sid = sessionFromLogin(p);
    if (!sid) return { ok: false, error: 'Login succeeded but returned no session — is this really a ubus endpoint?' };
    session = sid;
    return { ok: true };
  }

  return {
    kind: 'http',
    endpoint: base,
    async call(object, method, params = {}) {
      if (!session) { const l = await login(); if (!l.ok) return l; }
      let r = await post(rpcEnvelope(session, object, method, params));
      // One retry, and only for an expired session — not for permission denied, which would just
      // log in again and be denied again.
      if (!r.ok && r.expired) {
        session = null;
        const l = await login();
        if (!l.ok) return l;
        r = await post(rpcEnvelope(session, object, method, params));
      }
      return r;
    }
  };
}

/**
 * ubus over SSH — the fallback for devices whose vendor has disabled the HTTP endpoint.
 *
 * `ubus -S` emits the same JSON the HTTP endpoint returns as its payload, minus the [code, payload]
 * wrapper, so the parsers above are reused verbatim. Arguments are passed as an argv array and the
 * object and method names are validated, because this is a shell on the far end.
 */
const UBUS_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

export function sshTransport({ host, username, password, port = 22, timeoutMs = 12000, sshExec }) {
  return {
    kind: 'ssh',
    endpoint: `ssh://${username}@${host}:${port}`,
    async call(object, method, params = {}) {
      if (!UBUS_NAME.test(object) || !UBUS_NAME.test(method))
        return { ok: false, error: 'Refusing to run an unrecognised ubus object name' };
      const argv = ['ubus', '-S', 'call', object, method];
      if (params && Object.keys(params).length) argv.push(JSON.stringify(params));
      const r = await sshExec({ host, username, password, port, timeoutMs, argv });
      if (!r.ok) return { ok: false, error: r.error, unreachable: r.unreachable };
      const text = String(r.stdout || '').trim();
      if (!text) return { ok: true, data: {} };       // ubus prints nothing for an empty result
      try { return { ok: true, data: JSON.parse(text) }; }
      catch { return { ok: false, error: `ubus returned unparseable output: ${text.slice(0, 120)}` }; }
    },
    /**
     * For things with no ubus object, like logread and ping.
     *
     * stdout is returned even when the command exited non-zero, because plenty of useful commands
     * do both: busybox `ping` exits 1 if a single packet is lost while still printing a perfectly
     * good round-trip time. Discarding the output on a non-zero exit threw away the measurement
     * precisely when the link was degraded — the case worth measuring.
     */
    async run(argv) {
      const r = await sshExec({ host, username, password, port, timeoutMs, argv });
      return { ok: r.ok, data: String(r.stdout || ''), error: r.ok ? null : r.error };
    }
  };
}

/**
 * Try HTTP, fall back to SSH, then stay where it landed.
 *
 * Only for devices that have not been probed. The important detail is that it decides ONCE per
 * driver instance rather than per call — retrying a dead HTTP endpoint for every ubus object in a
 * poll would turn one 8-second timeout into a dozen.
 *
 * The fallback is deliberately narrow: it happens when the transport itself failed (nothing
 * listening, not ubus, login refused), never when ubus answered with an error. A permission denied
 * over HTTP will be permission denied over SSH too, and masking it behind a second attempt would
 * hide the real cause.
 */
export function autoTransport(mk) {
  let chosen = null;
  return {
    get kind() { return chosen ? chosen.kind : 'auto'; },
    get endpoint() { return chosen ? chosen.endpoint : '(not yet determined)'; },
    async call(object, method, params) {
      if (chosen) return chosen.call(object, method, params);
      const http = mk.http();
      const r = await http.call(object, method, params);
      if (r.ok || (typeof r.code === 'number')) { chosen = http; return r; }
      const ssh = mk.ssh();
      const s = await ssh.call(object, method, params);
      if (s.ok) { chosen = ssh; return s; }
      // Both failed. Report the HTTP error, which is the one that names the endpoint.
      return { ...r, error: `${r.error} (SSH also failed: ${s.error})` };
    },
    async run(argv) {
      const t = chosen && chosen.run ? chosen : mk.ssh();
      return t.run ? t.run(argv) : { ok: false, error: 'no shell available on this transport' };
    }
  };
}

// ---- the driver --------------------------------------------------------------------------------

/**
 * @param device  a row from `devices`
 * @param deps    { sshExec, fetchImpl, transport } — transport is injectable so tests drive the
 *                real parsers with captured device output and no network.
 */
export function createDriver(device, deps = {}) {
  const host = device.mgmt_address;
  const username = device.admin_username || 'root';       // OpenWrt's admin account is root
  const password = device.admin_password || '';

  const mk = {
    http: () => httpTransport({ host, username, password, fetchImpl: deps.fetchImpl || fetch, timeoutMs: deps.timeoutMs || 8000 }),
    ssh: () => sshTransport({ host, username, password, timeoutMs: deps.timeoutMs || 12000, sshExec: deps.sshExec })
  };

  // Which way in to use.
  //
  // 'auto' is correct but expensive when the answer is SSH: the HTTP attempt has to time out first,
  // on every poll, for the life of the device. So the probe records what worked and it is stored on
  // the device; 'auto' remains for devices nobody has probed yet.
  const pref = String(device.mgmt_transport || 'auto').toLowerCase();
  const transport = deps.transport || (pref === 'ssh' ? mk.ssh() : pref === 'http' ? mk.http() : autoTransport(mk));

  const need = (r) => {
    if (r.ok) return r.data;
    throw Object.assign(new Error(r.error || 'The device refused the request'), { http: r.unreachable ? 502 : 502 });
  };

  return {
    platform: 'openwrt',
    transport: transport.kind,
    endpoint: transport.endpoint,

    async identity() {
      const b = parseBoard(need(await transport.call('system', 'board')));
      // Best-effort: a stripped build may not expose system info, and that is not a failure.
      let sys = {};
      try { const r = await transport.call('system', 'info'); if (r.ok) sys = parseSysinfo(r.data); } catch {}
      return { ...b, ...sys };
    },

    /** Ports with link state and addresses — the same shape pollDeviceCore already stores. */
    async interfaces() {
      const devs = parseDevices(need(await transport.call('network.device', 'status')));
      let logical = [];
      const dump = await transport.call('network.interface', 'dump');
      if (dump.ok) logical = parseInterfaceDump(dump.data);
      const merged = mergeInterfaces(devs, logical);

      // Then fill the gaps from the kernel. UCI only knows the addresses UCI configured, and
      // ZeroTier configures its own — which left the management overlay interface showing no
      // address on the page of a device reached through that very address.
      if (transport.run) {
        try {
          const r = await transport.run(['ip', '-o', '-4', 'addr']);
          if (r.ok) {
            const kernel = parseIpAddr(r.data);
            for (const iface of merged) {
              const extra = (kernel[iface.name] || []).filter(ip => !iface.ips.includes(ip));
              if (extra.length) {
                iface.ips = [...iface.ips, ...extra];
                // Recorded so the page can say where an address came from, and so a UCI/kernel
                // disagreement is visible rather than silently merged.
                iface.ipsFromKernel = extra;
              }
            }
          }
        } catch { /* best effort: the UCI addresses are still correct as far as they go */ }
      }
      return { interfaces: merged, logical };
    },

    /**
     * Byte counters for the telemetry sampler.
     *
     * Same source as the port list, and deliberately a separate method: the sampler runs every
     * minute against the whole fleet and has no use for radios, leases or addresses.
     */
    async counters() {
      const devs = parseDevices(need(await transport.call('network.device', 'status')));
      return devs.map(i => ({ name: i.name, rxBytes: i.rxBytes, txBytes: i.txBytes }));
    },

    /**
     * Round-trip time from the DEVICE to a target — not from the server.
     *
     * The distinction is the whole point: this measures the customer's WAN, which is what a "the
     * internet is slow" ticket is about. Pinging the device from here would measure the overlay.
     */
    async latency(target = '8.8.8.8') {
      if (!/^[0-9a-zA-Z.:-]{1,64}$/.test(String(target))) return null;
      if (transport.run) {
        const r = await transport.run(['ping', '-c', '3', '-W', '2', String(target)]);
        // The OUTPUT is parsed regardless of the exit status, because busybox ping exits non-zero
        // when any packet is lost while still printing a perfectly good round-trip time. Reading
        // r.error on failure — as this first did — parsed the words "exited 1" and found no
        // latency exactly when the link was degraded enough to drop a packet.
        return parsePingMs(r.data || r.error || '');
      }
      const r = await transport.call('file', 'exec', { command: 'ping', params: ['-c', '3', '-W', '2', String(target)] });
      return r.ok && typeof r.data.stdout === 'string' ? parsePingMs(r.data.stdout) : null;
    },

    /**
     * The radios.
     *
     * This hardware exposes six: ra0/rax0 carry the customer's SSID on 2.4 and 5 GHz, ra1/rax1 are
     * unconfigured extra APs, and apcli0/apclix0 are the client side of the repeater function with
     * no SSID at all. Listing all six unfiltered puts four rows of noise — two of them blank — in
     * front of whoever is trying to answer "what is this customer's WiFi called".
     *
     * So a radio that is broadcasting nothing is dropped, and everything else is kept.
     */
    async wifi() {
      const r = await transport.call('iwinfo', 'devices');
      if (!r.ok) return { system: null, radios: [] };
      const names = Array.isArray(r.data.devices) ? r.data.devices : [];
      const all = [];
      for (const n of names) {
        const info = await transport.call('iwinfo', 'info', { device: n });
        if (info.ok) all.push(parseIwinfo(n, info.data));
      }

      // Two sources, because neither is complete on its own: iwinfo has the live radio state
      // (channel, signal, txpower) and network.wireless has the configuration (encryption, hidden).
      // On this hardware iwinfo omits encryption entirely, so without this merge the platform can
      // only say "unknown" about whether a customer's WiFi is protected.
      let configured = [];
      const ws = await transport.call('network.wireless', 'status');
      if (ws.ok) configured = parseWirelessStatus(ws.data);
      const byIface = new Map(configured.map(c => [c.iface, c]));

      for (const radio of all) {
        const c = byIface.get(radio.iface);
        if (!c) continue;
        if (radio.encryption === null && c.encryption != null) {
          radio.encryption = describeEncryption(c.encryption);
          radio.encryptionSource = 'uci';
        }
        radio.hiddenSsid = c.hidden;
        radio.isolated = c.isolate;
        if (!radio.ssid && c.ssid) radio.ssid = c.ssid;
        if (c.radioDisabled) radio.disabled = true;
      }

      const radios = all.filter(x => x.ssid || /master/i.test(x.mode));
      return {
        system: radios.length ? 'iwinfo' : null,
        radios,
        // Reported rather than silently discarded, so "six radios, two shown" is never a mystery.
        hidden: all.length - radios.length
      };
    },

    async wifiClients() {
      const r = await transport.call('iwinfo', 'devices');
      if (!r.ok) return [];
      const names = Array.isArray(r.data.devices) ? r.data.devices : [];
      const out = [];
      for (const n of names) {
        const a = await transport.call('iwinfo', 'assoclist', { device: n });
        if (a.ok) out.push(...parseAssoclist(a.data, n));
      }
      return out;
    },

    async dhcpLeases() {
      // LuCI's helper when it exists...
      const l = await transport.call('luci-rpc', 'getDHCPLeases');
      if (l.ok) {
        const rows = parseLuciLeases(l.data);
        if (rows.length) return rows;
      }
      // ...otherwise the file dnsmasq actually writes.
      const f = await transport.call('file', 'read', { path: '/tmp/dhcp.leases' });
      if (f.ok && typeof f.data.data === 'string') return parseLeaseFile(f.data.data);
      if (transport.run) {
        const r = await transport.run(['cat', '/tmp/dhcp.leases']);
        if (r.ok) return parseLeaseFile(r.data);
      }
      return [];
    },

    async log({ lines = 200 } = {}) {
      const r = await transport.call('file', 'exec', { command: 'logread', params: ['-l', String(lines)] });
      if (r.ok && typeof r.data.stdout === 'string') return parseLogLines(r.data.stdout);
      if (transport.run) {
        const s = await transport.run(['logread', '-l', String(lines)]);
        if (s.ok) return parseLogLines(s.data);
      }
      return [];
    },

    /**
     * Cellular signal, on hardware that has a modem.
     *
     * Vendor-specific by nature — `modem.signal` is GL.iNet's, not OpenWrt's — so absence is normal
     * and is reported as `available: false` rather than as a failure.
     */
    async signal() {
      const r = await transport.call('modem.signal', 'get_signals');
      if (!r.ok) return { available: false, reason: r.error, latest: null, samples: [], summary: null };
      return parseModemSignal(r.data);
    },

    /** Everything the poller stores, in one pass. */
    async poll() {
      const id = await this.identity();
      const { interfaces } = await this.interfaces();
      let wifi = { system: null, radios: [] };
      try { wifi = await this.wifi(); } catch {}
      // Only asked for when the hardware has a cellular interface — there is no point paying for a
      // round trip to a vendor object that is not installed on every poll of every device.
      let signal = { available: false, latest: null, samples: [], summary: null };
      if (interfaces.some(i => i.type === 'cellular')) {
        try { signal = await this.signal(); } catch {}
      }
      return {
        signal,
        interfaces,
        osVersion: id.osVersion,
        model: id.model,
        hostname: id.hostname,
        uptime: id.uptime,
        // OpenWrt has no board serial in ubus; inventory keeps the one scanned off the label.
        serial: null,
        firmware: { current: id.version || null, upgrade: null },
        wifi
      };
    }
  };
}
