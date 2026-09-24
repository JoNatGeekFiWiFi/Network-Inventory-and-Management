// Suspending a customer ON THEIR ROUTER: what gets added, and how it is taken off again.
//
// The same idea on both platforms:
//
//   1. Traffic from the customer's LAN to the internet is rejected — except DNS, and a short
//      "walled garden" of hosts they need to pay: our own site and the card processor (Stripe).
//   2. Plain HTTP (port 80) from the LAN is redirected to this server's CAPTIVE port, over the
//      management overlay (WireGuard or ZeroTier), and masqueraded as the router's own management
//      address on the way. That is the trick that makes the page personal: the server sees the
//      request arrive FROM a router it knows, so it knows exactly which customer is asking and can
//      send them straight to their own bill — no login, no guessing by public IP (which on CGNAT
//      or LTE failover can be shared with strangers).
//      Phones and laptops probe plain-HTTP URLs to detect captive portals, so they pop the
//      "sign in to network" sheet by themselves.
//   3. HTTPS to anywhere outside the garden is simply refused. It cannot be redirected without a
//      certificate warning, which teaches people to click through warnings.
//
// Only the FORWARD path is touched. The router's own traffic — and our management connection to it
// — goes through the input/output chains and is never affected, so a suspension cannot lock us out.
// Everything we add carries one tag (RouterOS comment / OpenWrt section prefix), and lifting the
// suspension removes exactly those items and nothing else.
import { isIP } from 'node:net';
import { parseCidr, inRange } from './ipam.js';

export const TAG = 'netinv-suspend';
export const GARDEN_LIST = 'netinv-garden';

/** Hosts a suspended customer can still reach. Editable in Settings; these are the defaults. */
export const DEFAULT_GARDEN = [
  'checkout.stripe.com', 'js.stripe.com', 'api.stripe.com', 'm.stripe.network', 'm.stripe.com',
  'q.stripe.com', 'r.stripe.com', 'b.stripecdn.com', 'hooks.stripe.com', 'pay.stripe.com'
];

/** The garden: our own host first, then the configured list, de-duplicated, hostnames or IPs only. */
export function gardenHosts(publicBaseUrl, configured) {
  const list = [];
  try { if (publicBaseUrl) list.push(new URL(publicBaseUrl).hostname); } catch {}
  const extra = Array.isArray(configured) ? configured : String(configured || '').split(/[\s,]+/);
  for (const h of (extra.length && extra.some(Boolean) ? extra : DEFAULT_GARDEN)) {
    const v = String(h || '').trim().toLowerCase();
    if (v && (isIP(v) || /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v))) list.push(v);
  }
  return [...new Set(list)];
}

/**
 * Which of this server's addresses a router should send captive traffic to: the one on the same
 * overlay subnet as the router's management address. `ifaces` is os.networkInterfaces().
 */
export function captiveIpFor(mgmtAddress, ifaces, fallback = null) {
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (!a.cidr || a.internal) continue;
      try { if (parseCidr(a.cidr) && inRange(a.cidr, mgmtAddress)) return a.address; } catch {}
    }
  }
  return fallback;
}

// ---- RouterOS ------------------------------------------------------------------------------------

export function routerosPlan({ captiveIp, captivePort, garden }) {
  const lan = { 'in-interface-list': 'LAN' };
  return {
    addressList: garden.map(address => ({ list: GARDEN_LIST, address, comment: TAG })),
    filter: [
      { chain: 'forward', ...lan, 'dst-address-list': GARDEN_LIST, action: 'accept', comment: TAG },
      { chain: 'forward', ...lan, protocol: 'udp', 'dst-port': '53', action: 'accept', comment: TAG },
      { chain: 'forward', ...lan, protocol: 'tcp', 'dst-port': '53', action: 'accept', comment: TAG },
      { chain: 'forward', ...lan, protocol: 'tcp', 'dst-address': captiveIp, 'dst-port': String(captivePort), action: 'accept', comment: TAG },
      { chain: 'forward', ...lan, action: 'reject', 'reject-with': 'icmp-admin-prohibited', comment: TAG }
    ],
    // Without this, an IPv6-capable customer simply carries on over IPv6.
    filter6: [
      { chain: 'forward', ...lan, protocol: 'udp', 'dst-port': '53', action: 'accept', comment: TAG },
      { chain: 'forward', ...lan, action: 'reject', 'reject-with': 'icmp-admin-prohibited', comment: TAG }
    ],
    nat: [
      { chain: 'dstnat', ...lan, protocol: 'tcp', 'dst-port': '80', 'dst-address-list': '!' + GARDEN_LIST,
        action: 'dst-nat', 'to-addresses': captiveIp, 'to-ports': String(captivePort), comment: TAG },
      { chain: 'srcnat', protocol: 'tcp', 'dst-address': captiveIp, 'dst-port': String(captivePort), action: 'masquerade', comment: TAG }
    ]
  };
}

const MENUS = { filter: '/rest/ip/firewall/filter', filter6: '/rest/ipv6/firewall/filter', nat: '/rest/ip/firewall/nat', addressList: '/rest/ip/firewall/address-list' };
const parse = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const isTrue = (v) => v === true || v === 'true';

/**
 * Remove everything we ever added. `call(method, path, body)` → { status, body }.
 * Returns how many items went. Safe to run on a router that was never suspended.
 */
export async function routerosClear(call) {
  let removed = 0;
  for (const [key, path] of Object.entries(MENUS)) {
    const r = await call('GET', path);
    if (r.status === 404 && key === 'filter6') continue;          // IPv6 package off: nothing there
    if (r.status >= 400) throw new Error(`Could not read ${path} (${r.status})`);
    for (const item of (parse(r) || []).filter(x => x.comment === TAG)) {
      const d = await call('DELETE', path + '/' + encodeURIComponent(item['.id']));
      if (d.status >= 400) throw new Error(`Could not remove ${path} ${item['.id']} (${d.status})`);
      removed++;
    }
  }
  return removed;
}

/** Add rules at the TOP of a chain, in order, above the first real (non-dynamic) rule. */
async function addAtTop(call, path, rules, chainOf = (r) => r.chain) {
  const cur = parse(await call('GET', path)) || [];
  for (const rule of rules) {
    const first = cur.find(x => x.chain === chainOf(rule) && !isTrue(x.dynamic) && x.comment !== TAG);
    const body = first ? { ...rule, 'place-before': first['.id'] } : rule;
    let r = await call('PUT', path, body);
    if (r.status >= 400 && first) {
      // Older builds refuse place-before on add. Add at the bottom, then move it up.
      r = await call('PUT', path, rule);
      const made = parse(r);
      if (r.status < 400 && made && made['.id']) await call('POST', path + '/move', { numbers: made['.id'], destination: first['.id'] });
    }
    if (r.status >= 400) throw new Error(`Could not add a ${rule.chain} rule (${r.status}: ${String(r.body || '').slice(0, 120)})`);
  }
}

export async function routerosSuspend(call, plan, { protect = [] } = {}) {
  // The rules match on the LAN interface list; a router without one would have them match nothing
  // and the customer would carry on as normal while we report them suspended.
  const lists = parse(await call('GET', '/rest/interface/list')) || [];
  if (!lists.some(l => l.name === 'LAN')) throw new Error('This router has no "LAN" interface list — add one (with the LAN bridge in it) so the suspension knows which traffic is the customer\'s.');
  await routerosClear(call);
  for (const e of plan.addressList) {
    const r = await call('PUT', MENUS.addressList, e);
    if (r.status >= 400) throw new Error(`Could not add ${e.address} to the walled garden (${r.status})`);
  }
  await addAtTop(call, MENUS.filter, plan.filter);
  await addAtTop(call, MENUS.nat, plan.nat);
  const v6 = await call('GET', MENUS.filter6);
  if (v6.status < 400) await addAtTop(call, MENUS.filter6, plan.filter6);
  // Connections already open (a video call, a download) would carry on through fasttrack. Drop the
  // LAN's connections so the block takes effect now, not in twenty minutes.
  // Our own management session is in that table too — never touch anything to or from this server
  // or the router's management address, or the next REST call would be cut off mid-suspension.
  try {
    const host = (v) => String(v || '').replace(/:\d+$/, '');
    const keep = new Set(protect.filter(Boolean));
    const lan = /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./;
    const conns = parse(await call('GET', '/rest/ip/firewall/connection')) || [];
    const victims = conns.filter(c => c['.id'] && lan.test(host(c['src-address'])) && !keep.has(host(c['src-address'])) && !keep.has(host(c['dst-address'])));
    const deadline = Date.now() + 20000;
    for (const c of victims.slice(0, 1000)) {
      if (Date.now() > deadline) break;
      await call('DELETE', '/rest/ip/firewall/connection/' + encodeURIComponent(c['.id']));
    }
  } catch { /* best effort */ }
  return { applied: true };
}

export async function routerosIsSuspended(call) {
  const r = await call('GET', MENUS.filter);
  if (r.status >= 400) throw new Error(`Could not read the firewall (${r.status})`);
  return (parse(r) || []).some(x => x.comment === TAG && x.action === 'reject');
}

// ---- OpenWrt -------------------------------------------------------------------------------------

export const OW_PREFIX = 'netinv_susp_';

/**
 * The firewall zone holding the management overlay, found from what the router reports.
 *
 * interfaces: driver.interfaces() → { interfaces: [{ name, ips }], logical: [{ name, device, ipv4 }] }
 * firewall:   `uci get firewall` values → { sectionName: { '.type': 'zone', name, network } }
 */
export function findOverlayZone({ interfaces, firewall, mgmtAddress }) {
  const logical = (interfaces && interfaces.logical) || [];
  const devs = (interfaces && interfaces.interfaces) || [];
  const nets = new Set();
  for (const l of logical) if ((l.ipv4 || []).includes(mgmtAddress)) nets.add(l.name);
  const dev = devs.find(d => (d.ips || []).includes(mgmtAddress));
  if (dev) for (const l of logical) if (l.device === dev.name) nets.add(l.name);
  if (!nets.size) return null;
  for (const s of Object.values(firewall || {})) {
    if (s['.type'] !== 'zone') continue;
    const zn = Array.isArray(s.network) ? s.network : String(s.network || '').split(/\s+/).filter(Boolean);
    if (zn.some(n => nets.has(n))) return s.name;
  }
  return null;
}

/** UCI sections to add, in order. Named, so adding twice cannot duplicate and removing is exact. */
export function openwrtPlan({ captiveIp, captivePort, gardenIps, overlayZone, lanZone = 'lan' }) {
  const port = String(captivePort);
  const sections = [];
  if (gardenIps.length) sections.push({ type: 'rule', name: OW_PREFIX + 'garden', values: {
    name: 'netinv suspended: payment sites', src: lanZone, dest: '*', proto: 'tcp', dest_port: '80 443', dest_ip: gardenIps, family: 'ipv4', target: 'ACCEPT' } });
  sections.push(
    { type: 'rule', name: OW_PREFIX + 'dns', values: { name: 'netinv suspended: DNS', src: lanZone, dest: '*', proto: 'tcp udp', dest_port: '53', target: 'ACCEPT' } },
    { type: 'rule', name: OW_PREFIX + 'portal', values: { name: 'netinv suspended: payment page', src: lanZone, dest: '*', proto: 'tcp', dest_ip: captiveIp, dest_port: port, target: 'ACCEPT' } },
    { type: 'rule', name: OW_PREFIX + 'block', values: { name: 'netinv suspended: everything else', src: lanZone, dest: '*', target: 'REJECT' } },
    { type: 'redirect', name: OW_PREFIX + 'http', values: { name: 'netinv suspended: web to payment page', src: lanZone, proto: 'tcp', src_dport: '80',
      dest: overlayZone, dest_ip: captiveIp, dest_port: port, target: 'DNAT' } },
    { type: 'nat', name: OW_PREFIX + 'snat', values: { name: 'netinv suspended: as the router', src: overlayZone, proto: 'tcp', dest_ip: captiveIp, dest_port: port, target: 'MASQUERADE' } }
  );
  return sections;
}

/** Section names of ours currently present in `uci get firewall`. */
export const openwrtOurs = (firewall) => Object.keys(firewall || {}).filter(k => k.startsWith(OW_PREFIX));
