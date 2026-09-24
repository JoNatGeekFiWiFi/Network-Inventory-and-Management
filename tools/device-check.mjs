// Feature check against the REAL routers — MikroTik and OpenWrt.
//
// Read-only by default: for every managed router it asks the device the same questions each
// platform feature asks (identity, ports, traffic counters, WAN ping, DHCP, Wi-Fi, clients, log,
// firewall access, backups, and whether a suspension could be applied), and prints what works.
// Nothing on any router is changed, and the database is opened read-only.
//
//   sudo bash /opt/netinv/tools/device-check.sh                  # every managed router
//   sudo bash /opt/netinv/tools/device-check.sh --device 12      # one router (id or name)
//   sudo bash /opt/netinv/tools/device-check.sh --live-suspend 12 --yes
//
// --live-suspend actually suspends ONE router for about 20 seconds, checks the rules are on, then
// removes them and checks they are gone. The router's customers lose internet for those seconds.
// Use it on a test router, or a customer who knows. Management access is never affected (the rules
// are forward-chain only, and on OpenWrt the change rolls itself back if we lose contact).
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { promises as dnsp } from 'node:dns';
import { driverFor, platformOf, capsFor } from '../lib/drivers/index.js';
import { sshExec } from '../lib/sshexec.js';
import { gardenHosts, captiveIpFor, findOverlayZone, openwrtOurs, enforceRouterOS, enforceOpenWrt, routerosIsSuspended, openwrtIsSuspended, TAG } from '../lib/suspendrouter.js';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const DB_PATH = process.env.DB_PATH || '/opt/netinv/data.db';
const CAPTIVE_PORT = Number(process.env.CAPTIVE_PORT || 3080);
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const setting = (k) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || '';

// ---- a REST helper, the same shape as the app's (HTTPS first, HTTP if refused; self-signed ok) ----
function once(mod, url, { method = 'GET', headers = {}, body, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = mod.request(url, { method, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function rest(d, path, opts = {}) {
  const headers = { Authorization: 'Basic ' + Buffer.from((d.admin_username || 'admin') + ':' + d.admin_password).toString('base64'), Accept: 'application/json' };
  try { return await once(https, `https://${d.mgmt_address}${path}`, { ...opts, headers }); }
  catch (e) { if (['ECONNREFUSED', 'EPROTO', 'ECONNRESET'].includes(e.code)) return await once(http, `http://${d.mgmt_address}${path}`, { ...opts, headers }); throw e; }
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const tcpOpen = (host, port, ms = 4000) => new Promise(res => { const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); res(false); }, ms); s.on('connect', () => { clearTimeout(t); s.destroy(); res(true); }); s.on('error', () => { clearTimeout(t); res(false); }); });

// ---- printing ----
const results = [];
function row(dev, feature, status, detail = '') {
  results.push({ dev, feature, status });
  const mark = status === 'ok' ? '✔' : status === 'fail' ? '✘' : status === 'warn' ? '!' : '–';
  console.log(`  ${mark} ${feature.padEnd(26)} ${detail}`);
}
async function probe(dev, feature, fn) {
  try {
    const r = await fn();
    if (r === undefined || r === true) return row(dev, feature, 'ok');
    if (r && typeof r === 'object' && r.status) return row(dev, feature, r.status, r.detail || '');
    return row(dev, feature, 'ok', String(r));
  } catch (e) { row(dev, feature, 'fail', String(e && e.message || e).slice(0, 140)); }
}

// ---- the server's side of the features ----
async function serverChecks() {
  console.log('\n== this server ==');
  const base = setting('public_base_url');
  row('server', 'public URL', base ? 'ok' : 'fail', base || 'NOT SET — suspended customers have no payment page to land on (Settings → Public URL)');
  row('server', 'Stripe (Pay buttons)', setting('stripe_secret') ? 'ok' : 'warn', setting('stripe_secret') ? 'configured' : 'not configured — the Pay button will not take cards');
  row('server', 'captive listener :' + CAPTIVE_PORT, (await tcpOpen('127.0.0.1', CAPTIVE_PORT)) ? 'ok' : 'fail', 'where suspended routers send web traffic');
  const auto = setting('suspend_auto') === '1';
  row('server', 'automatic suspension', auto ? 'ok' : 'warn', auto ? 'on' : 'off (switch on under Suspensions → Policy once the Late list looks right)');
  const recent = db.prepare("SELECT COUNT(DISTINCT device_id) n FROM metric_state WHERE observed_at > ?").get(new Date(Date.now() - 10 * 60000).toISOString()).n;
  row('server', 'health checks running', recent ? 'ok' : 'warn', recent ? `${recent} device(s) checked in the last 10 min` : 'no device checked in the last 10 min (is the sampler on?)');
  const firing = db.prepare('SELECT COUNT(*) n FROM metric_state WHERE firing=1').get().n;
  row('server', 'alerts firing now', firing ? 'warn' : 'ok', String(firing));
  const ifs = Object.entries(os.networkInterfaces()).flatMap(([n, l]) => (l || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => `${n} ${a.cidr}`));
  console.log('  · overlay addresses: ' + ifs.join(', '));
}

// ---- RouterOS ----
async function checkRouterOS(d) {
  const name = d.name;
  let reachable = false;
  await probe(name, 'reach + REST login', async () => {
    const r = await rest(d, '/rest/system/resource', { timeoutMs: 7000 });
    if (r.status === 401) throw new Error('login rejected — check the admin username/password on the device record');
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' — is the www-ssl or www service enabled?');
    const x = [].concat(json(r))[0] || {}; reachable = true;
    return `RouterOS ${x.version || '?'} · ${x['board-name'] || '?'} · CPU ${x['cpu-load'] ?? '?'}% · up ${x.uptime || '?'}`;
  });
  if (!reachable) return;
  const need = async (path) => { const r = await rest(d, path); if (r.status >= 400) throw new Error(`HTTP ${r.status} on ${path}`); return json(r); };
  await probe(name, 'identity (model/serial)', async () => { const b = [].concat(await need('/rest/system/routerboard'))[0] || {}; return `${b.model || '?'} · SN ${b['serial-number'] || '?'} · fw ${b['current-firmware'] || '?'}`; });
  await probe(name, 'ports / interfaces', async () => { const l = await need('/rest/interface'); return `${l.length} interfaces`; });
  await probe(name, 'traffic counters', async () => { const l = await need('/rest/interface'); if (!l.some(i => i['rx-byte'] != null)) throw new Error('no byte counters in the interface list'); return 'rx/tx bytes present'; });
  let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
  const wan = Object.keys(roles).filter(k => /^WAN/.test(roles[k]));
  row(name, 'WAN ports tagged', wan.length ? 'ok' : 'warn', wan.length ? wan.join(', ') : 'none — tag WAN1/WAN2 on the device page or the WAN graph stays empty');
  await probe(name, 'WAN ping (health)', async () => {
    const r = await rest(d, '/rest/ping', { method: 'POST', body: { address: '8.8.8.8', count: '2' }, timeoutMs: 9000 });
    if (r.status >= 400) throw new Error(`HTTP ${r.status} — the admin user may lack the "test" policy needed to ping`);
    const t = [].concat(json(r)).map(x => x.time).filter(Boolean);
    if (!t.length) return { status: 'warn', detail: 'ping ran but got no replies — the internet check would report DOWN' };
    return 'replies: ' + t.join(', ');
  });
  await probe(name, 'DHCP leases', async () => `${(await need('/rest/ip/dhcp-server/lease')).length} leases`);
  await probe(name, 'Wi-Fi', async () => {
    const w = await rest(d, '/rest/interface/wifi'); const wl = await rest(d, '/rest/interface/wireless');
    const a = w.status < 400 ? json(w) : null, b = wl.status < 400 ? json(wl) : null;
    if (a && a.length) return `${a.length} radio(s) (wifi / v7)`;
    if (b && b.length) return `${b.length} radio(s) (legacy wireless)`;
    return { status: 'skip', detail: 'no radios on this router' };
  });
  await probe(name, 'Wi-Fi clients', async () => {
    for (const p of ['/rest/interface/wifi/registration-table', '/rest/interface/wireless/registration-table']) { const r = await rest(d, p); if (r.status < 400) return `${(json(r) || []).length} connected`; }
    return { status: 'skip', detail: 'no radios' };
  });
  await probe(name, 'log (threat harvest)', async () => `${(await need('/rest/log')).length} lines`);
  await probe(name, 'firewall read', async () => {
    const f = await need('/rest/ip/firewall/filter');
    const bl = f.some(x => x['src-address-list'] === 'netinv-blocklist');
    return { status: bl ? 'ok' : 'warn', detail: `${f.length} rules · blocklist rule ${bl ? 'present' : 'NOT present (pushed on next change)'}` };
  });
  await probe(name, 'WireGuard support', async () => { const r = await rest(d, '/rest/interface/wireguard'); if (r.status >= 400) throw new Error('no WireGuard menu (RouterOS 6?)'); return `${(json(r) || []).length} interface(s)`; });
  await probe(name, 'backups (SSH/FTP)', async () => {
    const ssh = await tcpOpen(d.mgmt_address, 22); const ftp = await tcpOpen(d.mgmt_address, 21);
    if (!ssh && !ftp) throw new Error('neither SSH (22) nor FTP (21) answers — backups cannot pull the config');
    return (ssh ? 'SSH open' : '') + (ssh && ftp ? ' · ' : '') + (ftp ? 'FTP open' : '');
  });
  await probe(name, 'firmware/packages read', async () => `${(await need('/rest/system/package')).length} packages`);
  // Suspension readiness
  await probe(name, 'suspend: LAN list', async () => { const l = await need('/rest/interface/list'); if (!l.some(x => x.name === 'LAN')) throw new Error('no "LAN" interface list — suspension would be refused'); return 'LAN list present'; });
  await probe(name, 'suspend: route to server', async () => {
    const ip = captiveIpFor(d.mgmt_address, os.networkInterfaces(), setting('captive_redirect_ip') || null);
    if (!ip) throw new Error(`this server has no address on ${d.mgmt_address}'s overlay subnet — set Captive redirect IP in Suspensions → Policy`);
    return `web traffic would go to ${ip}:${CAPTIVE_PORT}`;
  });
  await probe(name, 'suspend: IPv6 firewall', async () => { const r = await rest(d, '/rest/ipv6/firewall/filter'); return r.status < 400 ? 'present (IPv6 blocked too)' : { status: 'skip', detail: 'IPv6 package off — nothing to block' }; });
  await probe(name, 'suspend: current state', async () => (await routerosIsSuspended((m, p, b) => rest(d, p, { method: m, body: b }))) ? { status: 'warn', detail: 'SUSPENDED rules are on this router now' } : 'not suspended');
}

// ---- OpenWrt ----
async function checkOpenWrt(d) {
  const name = d.name;
  const drv = await driverFor(d, { sshExec });
  let ok = false;
  await probe(name, 'reach + login', async () => { const i = await drv.identity(); ok = true; return `${i.distribution || 'OpenWrt'} ${i.osVersion || i.version || ''} · ${i.model || '?'}${drv.transport ? ' · via ' + drv.transport : ''}`; });
  if (!ok) return;
  let ifs = null;
  await probe(name, 'ports / interfaces', async () => { ifs = await drv.interfaces(); return `${ifs.interfaces.length} devices, ${ifs.logical.length} networks`; });
  await probe(name, 'traffic counters', async () => { const c = await drv.counters(); if (!c.length) throw new Error('no counters'); return `${c.length} interfaces`; });
  let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
  const wan = Object.keys(roles).filter(k => /^WAN/.test(roles[k]));
  row(name, 'WAN ports tagged', wan.length ? 'ok' : 'warn', wan.length ? wan.join(', ') : 'none — tag WAN1/WAN2 on the device page or the WAN graph stays empty');
  await probe(name, 'WAN ping (health)', async () => { const m = await drv.latency(); return m == null ? { status: 'warn', detail: 'ping ran, no replies — the internet check would report DOWN' } : `${m} ms`; });
  await probe(name, 'DHCP leases', async () => `${(await drv.dhcpLeases()).length} leases`);
  await probe(name, 'Wi-Fi', async () => { const w = await drv.wifi(); return w && w.radios && w.radios.length ? `${w.radios.length} radio(s)` : { status: 'skip', detail: 'no radios' }; });
  await probe(name, 'Wi-Fi clients', async () => `${(await drv.wifiClients()).length} connected`);
  await probe(name, 'log', async () => `${(await drv.log({ lines: 20 })).length} lines`);
  if (drv.signal) await probe(name, 'cellular signal', async () => { const s = await drv.signal(); if (!s || s.available === false) return { status: 'skip', detail: 'no modem' }; const l = s.latest || {}; return Object.entries(l).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 5).map(([k, v]) => `${k} ${v}`).join(' · ') || 'available'; });
  await probe(name, 'packages read', async () => `${Object.keys(await drv.packages()).length} packages`);
  await probe(name, 'UCI read (settings)', async () => { const r = await drv.uciGetAll('firewall'); if (!r.ok) throw new Error(r.error + ' — the login may lack UCI access (rpcd ACL)'); return `${Object.keys(r.values).length} firewall sections`; });
  await probe(name, 'no half-made changes', async () => { const c = await drv.uciChanges(); return c.length ? { status: 'warn', detail: `${c.length} unsaved change(s) on the router — Wi-Fi edits and suspension will refuse until they are applied or reverted` } : 'clean'; });
  await probe(name, 'DHCP edit (UCI dhcp)', async () => { const r = await drv.uciGetAll('dhcp'); if (!r.ok) throw new Error(r.error); const hosts = Object.values(r.values).filter(x => x['.type'] === 'host'); return `readable · ${hosts.length} reservation(s)`; });
  await probe(name, 'blocklist push', async () => {
    const r = await drv.uciGetAll('firewall'); if (!r.ok) throw new Error(r.error);
    const set = r.values.netinv_blocklist;
    return set ? `pushed · ${[].concat(set.entry || []).length} address(es)` : { status: 'warn', detail: 'not pushed yet (happens on the next blocklist change, or Blocklist → Push now)' };
  });
  await probe(name, 'shell (SSH) for firmware/packages', async () => {
    const t = await sshExec({ host: d.mgmt_address, username: d.admin_username || 'root', password: d.admin_password, argv: ['true'], timeoutMs: 8000 });
    if (!t.ok) throw new Error(t.error + ' — firmware upgrades, packages and backups need SSH');
    return 'SSH login works';
  });
  await probe(name, 'firmware upgrade path', async () => {
    const fw = await drv.firmware();
    const ls = await sshExec({ host: d.mgmt_address, username: d.admin_username || 'root', password: d.admin_password, argv: ['which', 'sysupgrade'], timeoutMs: 8000 });
    if (!ls.ok) throw new Error('sysupgrade not found on the router');
    return `running ${fw.running || '?'} · sysupgrade available`;
  });
  await probe(name, 'WireGuard support', async () => {
    const r = await sshExec({ host: d.mgmt_address, username: d.admin_username || 'root', password: d.admin_password, argv: ['ubus', 'call', 'network', 'get_proto_handlers'], timeoutMs: 8000 });
    if (!r.ok) throw new Error(r.error);
    return /"wireguard"/.test(r.stdout) ? 'wireguard protocol installed' : { status: 'warn', detail: 'not installed — opkg install kmod-wireguard wireguard-tools luci-proto-wireguard (from the Maintenance card)' };
  });
  await probe(name, 'reboot', async () => { const r = await sshExec({ host: d.mgmt_address, username: d.admin_username || 'root', password: d.admin_password, argv: ['ubus', '-v', 'list', 'system'], timeoutMs: 8000 }); if (!r.ok) throw new Error(r.error); return /reboot/.test(r.stdout) ? 'system.reboot available (not called)' : { status: 'warn', detail: 'no system.reboot method' }; });
  await probe(name, 'suspend: overlay zone', async () => {
    const fw = await drv.uciGetAll('firewall');
    const z = findOverlayZone({ interfaces: ifs || await drv.interfaces(), firewall: fw.values, mgmtAddress: d.mgmt_address });
    if (!z) throw new Error(`no firewall zone holds the network with ${d.mgmt_address} — suspension would be refused`);
    return `management network is in zone "${z}"`;
  });
  await probe(name, 'suspend: route to server', async () => {
    const ip = captiveIpFor(d.mgmt_address, os.networkInterfaces(), setting('captive_redirect_ip') || null);
    if (!ip) throw new Error(`this server has no address on ${d.mgmt_address}'s overlay subnet — set Captive redirect IP in Suspensions → Policy`);
    return `web traffic would go to ${ip}:${CAPTIVE_PORT}`;
  });
  await probe(name, 'suspend: current state', async () => (await openwrtIsSuspended(drv)) ? { status: 'warn', detail: 'SUSPENDED sections are on this router now' } : 'not suspended');
  row(name, 'suspend: UCI write', 'skip', 'only provable by doing it — run with --live-suspend on a test router');
}

// ---- live suspension test ----
async function liveSuspend(d) {
  console.log(`\n== LIVE suspension test on ${d.name} (${d.mgmt_address}) ==`);
  const key = platformOf(d);
  const captiveIp = captiveIpFor(d.mgmt_address, os.networkInterfaces(), setting('captive_redirect_ip') || null);
  if (!captiveIp) { console.log('  ✘ no server address on this router\'s overlay — cannot test'); return; }
  const garden = gardenHosts(setting('public_base_url'), setting('suspend_garden'));
  const call = (m, p, b) => rest(d, p, { method: m, body: b, timeoutMs: 15000 });
  const drv = key === 'openwrt' ? await driverFor(d, { sshExec }) : null;
  const apply = async (suspend) => key === 'routeros'
    ? enforceRouterOS(call, { suspend, captiveIp, captivePort: CAPTIVE_PORT, garden, protect: [captiveIp, d.mgmt_address] })
    : enforceOpenWrt(drv, { suspend, mgmtAddress: d.mgmt_address, captiveIp, captivePort: CAPTIVE_PORT,
        gardenIps: suspend ? [...new Set((await Promise.all(garden.map(h => /^\d/.test(h) ? [h] : dnsp.resolve4(h).catch(() => [])))).flat())] : [] });
  const isOn = () => (key === 'routeros' ? routerosIsSuspended(call) : openwrtIsSuspended(drv));
  try {
    row(d.name, 'apply suspension', 'ok', await apply(true));
    row(d.name, 'rules on router', (await isOn()) ? 'ok' : 'fail');
    // A real API call, not a port knock: the thing being protected is our ability to manage it.
    let back = false;
    try { back = key === 'routeros' ? (await rest(d, '/rest/system/resource')).status < 400 : !!(await drv.identity()); } catch {}
    row(d.name, 'management still works', back ? 'ok' : 'fail', back ? 'API still answers while suspended' : 'could not reach the API while suspended');
    console.log('  … holding 20 s — try a phone on this router now: it should get the payment page');
    await new Promise(r => setTimeout(r, 20000));
  } catch (e) { row(d.name, 'apply suspension', 'fail', e.message); }
  try {
    row(d.name, 'remove suspension', 'ok', await apply(false));
    row(d.name, 'rules gone', (await isOn()) ? 'fail' : 'ok');
  } catch (e) { row(d.name, 'remove suspension', 'fail', e.message + ' — CHECK THIS ROUTER BY HAND'); }
}

// ---- main ----
const pick = arg('--device') || arg('--live-suspend');
let devices = db.prepare(`SELECT * FROM devices WHERE archived_at IS NULL AND status='Deployed' AND management_mode='platform'
  AND COALESCE(mgmt_address,'')<>'' AND COALESCE(admin_password,'')<>''`).all().filter(d => ['routeros', 'openwrt'].includes(platformOf(d)));
if (pick) devices = devices.filter(d => String(d.id) === pick || d.name.toLowerCase() === pick.toLowerCase());
console.log(`netinv device check — ${new Date().toISOString()} — ${devices.length} router(s)${args.includes('--live-suspend') ? '' : ' — read-only, nothing is changed'}`);

if (args.includes('--live-suspend')) {
  if (devices.length !== 1) { console.log('Name exactly one router: --live-suspend <id>'); process.exit(1); }
  if (!args.includes('--yes')) { console.log(`This suspends ${devices[0].name} for ~20 seconds (its customers lose internet). Re-run with --yes to go ahead.`); process.exit(1); }
  await liveSuspend(devices[0]);
} else {
  await serverChecks();
  for (const d of devices) {
    const key = platformOf(d);
    console.log(`\n== ${d.name} · #${d.id} · ${key} · ${d.mgmt_address} (${d.mgmt_overlay || 'overlay?'}) · claims: ${capsFor(d).join(', ')}`);
    try { key === 'routeros' ? await checkRouterOS(d) : await checkOpenWrt(d); }
    catch (e) { row(d.name, 'check', 'fail', e.message); }
  }
}

const count = (s) => results.filter(r => r.status === s).length;
console.log(`\nsummary: ${count('ok')} ok · ${count('warn')} warnings · ${count('fail')} failed · ${count('skip')} not applicable`);
console.log('done — ' + (args.includes('--live-suspend') ? 'test finished.' : 'nothing was changed.'));
process.exit(0);
