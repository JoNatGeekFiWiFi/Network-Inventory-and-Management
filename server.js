// Network Inventory & Management Platform — API + static server (testing build)
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { writeFileSync, createReadStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { db, initSchema, migrate, isEmpty, seed, backfillCustomers, UPLOADS_DIR, BACKUPS_DIR } from './db.js';
import { createSession, destroySession, userForToken, parseCookies, setSessionCookie, clearSessionCookie } from './auth.js';
import { hashPassword, verifyPassword } from './hash.js';
import { wgKeypair, nextFreeIp, serverIp, deviceConfig, serverPeerStanza, parseCidr } from './wg.js';
import https from 'node:https';
import http from 'node:http';

// HTTP(S) JSON request with a timeout; https tolerates self-signed certs (RouterOS). Returns {status, body}.
function reqJson(mod, urlStr, opts = {}) {
  const { headers = {}, method = 'GET', body = null, timeoutMs = 12000 } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const payload = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers);
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const o = { hostname: u.hostname, port: u.port || (mod === https ? 443 : 80), path: u.pathname + u.search, method, headers: h, timeout: timeoutMs };
    if (mod === https) o.rejectUnauthorized = false;
    const req = mod.request(o, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
// RouterOS REST: try HTTPS (www-ssl), fall back to HTTP (www) if the TLS port refuses.
async function restReq(addr, path, opts = {}) {
  try { return await reqJson(https, `https://${addr}${path}`, opts); }
  catch (e) {
    if (['ECONNREFUSED', 'EPROTO', 'ECONNRESET'].includes(e.code)) return await reqJson(http, `http://${addr}${path}`, opts);
    throw e;
  }
}
// Is an IPv4 address public (not private / CGNAT / loopback / link-local / multicast)?
function isPublicV4(ip) {
  const o = String(ip).split('.').map(Number);
  if (o.length !== 4 || o.some(n => isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = o;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  return true;
}
function extractIp(msg) {
  const m = String(msg).match(/from (\d{1,3}(?:\.\d{1,3}){3})/i) || String(msg).match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? m[1] : null;
}
// Read a device's log, pull failed-login source IPs into the central blocklist. Returns # IPs seen.
// Minimum failed-login hits before an auto-harvested IP is pushed to routers (manual adds always push)
const blocklistMinHits = () => {
  const v = (db.prepare("SELECT value FROM settings WHERE key='blocklist_min_hits'").get() || {}).value;
  const n = parseInt(v, 10);
  return (Number.isFinite(n) && n > 0) ? n : 1;
};
const activeBlockIps = () => {
  const min = blocklistMinHits();
  return db.prepare("SELECT ip FROM blocklist WHERE active=1 AND (source='manual' OR hits>=?) ORDER BY ip").all(min).map(r => r.ip);
};
async function harvestThreats(d) {
  const user = d.admin_username || 'admin';
  const H = { Authorization: 'Basic ' + Buffer.from(user + ':' + d.admin_password).toString('base64'), Accept: 'application/json' };
  const r = await restReq(d.mgmt_address, '/rest/log', { headers: H, timeoutMs: 7000 });
  if (r.status >= 400) return 0;
  let logs; try { logs = JSON.parse(r.body); } catch { return 0; }
  if (!Array.isArray(logs)) return 0;
  const counts = {};
  for (const e of logs) {
    const msg = e.message || '';
    if (/login failure|authentication failed|invalid user/i.test(msg)) {
      const ip = extractIp(msg);
      if (ip && isPublicV4(ip)) counts[ip] = (counts[ip] || 0) + 1;
    }
  }
  const upsert = db.prepare("INSERT INTO blocklist (ip,reason,hits,source) VALUES (?,?,?,?) ON CONFLICT(ip) DO UPDATE SET hits=MAX(hits,?), last_seen=datetime('now'), source=excluded.source");
  for (const [ip, c] of Object.entries(counts)) upsert.run(ip, 'failed login', c, d.name, c);
  return Object.keys(counts).length;
}
// Push the active blocklist to one device: reconcile its netinv-blocklist address-list + ensure an input drop rule.
async function pushBlocklistToDevice(d) {
  const user = d.admin_username || 'admin';
  const H = { Authorization: 'Basic ' + Buffer.from(user + ':' + d.admin_password).toString('base64'), Accept: 'application/json' };
  const ips = activeBlockIps();
  const want = new Set(ips);
  const cur = await restReq(d.mgmt_address, '/rest/ip/firewall/address-list', { headers: H });
  let all = []; if (cur.status < 400) { try { const a = JSON.parse(cur.body); if (Array.isArray(a)) all = a; } catch {} }
  const existing = all.filter(e => e.list === 'netinv-blocklist'); // only touch our list
  const have = new Set(existing.map(e => e.address));
  let added = 0, removed = 0, lastErr = null;
  // RouterOS REST: add = PUT (POST is for command endpoints only)
  for (const ip of ips) if (!have.has(ip)) {
    const ar = await restReq(d.mgmt_address, '/rest/ip/firewall/address-list', { headers: H, method: 'PUT', body: { list: 'netinv-blocklist', address: ip } });
    if (ar.status < 400) added++; else lastErr = ar.status + ': ' + (ar.body || '').slice(0, 120);
  }
  for (const e of existing) if (!want.has(e.address)) { await restReq(d.mgmt_address, '/rest/ip/firewall/address-list/' + encodeURIComponent(e['.id']), { headers: H, method: 'DELETE' }); removed++; }
  // ensure an input drop rule referencing the list
  let ruleAdded = false;
  const fr = await restReq(d.mgmt_address, '/rest/ip/firewall/filter', { headers: H });
  let hasRule = false; if (fr.status < 400) { try { const rules = JSON.parse(fr.body); if (Array.isArray(rules)) hasRule = rules.some(x => x['src-address-list'] === 'netinv-blocklist' && x.action === 'drop'); } catch {} }
  if (!hasRule) { const rr = await restReq(d.mgmt_address, '/rest/ip/firewall/filter', { headers: H, method: 'PUT', body: { chain: 'input', 'src-address-list': 'netinv-blocklist', action: 'drop', comment: 'netinv auto-block' } }); if (rr.status < 400) ruleAdded = true; else lastErr = lastErr || (rr.status + ': ' + (rr.body || '').slice(0, 120)); }
  return { added, removed, total: ips.length, ruleAdded, error: lastErr || undefined };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '30mb' })); // raised so base64 photo/PDF note attachments fit

// First-run: create schema + seed if empty
initSchema();
migrate();
if (isEmpty()) { seed(); console.log('Database seeded on first run.'); }
backfillCustomers();

// ---- helpers ----
const N = (v, d = null) => (v === undefined ? d : v); // null-coalesce for SQLite binding
const PRIV = new Set(['noc', 'admin']);
const role = (req) => (req.user ? req.user.role : 'support');
const isPriv = (req) => PRIV.has(role(req));
const NOC_CREDS = ['admin_password','factory_password','factory_wifi_password','acct_pin','acct_portal_username','acct_portal_password','acct_passphrase'];
const TECH_CREDS = ['tech_username','tech_password'];
const ALL_CREDS = [...NOC_CREDS, ...TECH_CREDS];

function audit(req, action, target, details='') {
  db.prepare('INSERT INTO audit_log (actor, role, action, target, details) VALUES (?,?,?,?,?)')
    .run((req.user && req.user.email) || 'system', role(req), action, target, details);
}

// ---- auth: login / logout (no session required) ----
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get((email || '').toLowerCase().trim());
  if (!u || !verifyPassword(password, u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = createSession(u.id);
  setSessionCookie(res, token);
  db.prepare('INSERT INTO audit_log (actor, role, action, target, details) VALUES (?,?,?,?,?)').run(u.email, u.role, 'login', 'user#' + u.id, '');
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).sid;
  destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- require auth for everything else under /api ----
app.use('/api', (req, res, next) => {
  const u = userForToken(parseCookies(req).sid);
  if (!u) return res.status(401).json({ error: 'auth required' });
  req.user = u;
  next();
});

const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'Admin only' });
const requireNoc = (req, res, next) => (req.user && ['noc', 'admin'].includes(req.user.role)) ? next() : res.status(403).json({ error: 'NOC/Admin only' });

app.get('/api/me', (req, res) => res.json(req.user));

// ---- users (admin only) ----
const VALID_ROLES = ['admin', 'noc', 'field', 'support'];
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all());
});
app.post('/api/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.email || !b.password) return res.status(400).json({ error: 'Email and password required' });
  if (!VALID_ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(b.email.toLowerCase().trim());
  if (exists) return res.status(409).json({ error: 'Email already in use' });
  const info = db.prepare('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,?)')
    .run(N(b.name), b.email.toLowerCase().trim(), hashPassword(b.password), b.role, b.active === 0 ? 0 : 1);
  audit(req, 'create', 'user#' + info.lastInsertRowid, b.email);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/users/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  if (b.role && !VALID_ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?')
    .run(N(b.name, ex.name), b.role || ex.role, b.active === undefined ? ex.active : (b.active ? 1 : 0), req.params.id);
  if (b.password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), req.params.id);
  audit(req, 'edit', 'user#' + req.params.id, ex.email + (b.password ? ' (password reset)' : ''));
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'user#' + req.params.id);
  res.json({ ok: true });
});

// ---- device model catalog (NOC/Admin manage) ----
app.get('/api/models', (req, res) => {
  res.json(db.prepare('SELECT * FROM device_models ORDER BY manufacturer, model').all());
});
app.post('/api/models', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.manufacturer || !b.model) return res.status(400).json({ error: 'Manufacturer and model required' });
  const info = db.prepare('INSERT INTO device_models (manufacturer, model, device_type, has_wifi, has_cellular) VALUES (?,?,?,?,?)')
    .run(N(b.manufacturer), N(b.model), N(b.device_type), b.has_wifi ? 1 : 0, b.has_cellular ? 1 : 0);
  audit(req, 'create', 'model#' + info.lastInsertRowid, b.manufacturer + ' ' + b.model);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/models/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM device_models WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE device_models SET manufacturer=?, model=?, device_type=?, has_wifi=?, has_cellular=? WHERE id=?')
    .run(N(b.manufacturer, ex.manufacturer), N(b.model, ex.model), N(b.device_type, ex.device_type), b.has_wifi ? 1 : 0, b.has_cellular ? 1 : 0, req.params.id);
  audit(req, 'edit', 'model#' + req.params.id, b.manufacturer + ' ' + b.model);
  res.json({ ok: true });
});
app.delete('/api/models/:id', requireNoc, (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE model_id=?').get(req.params.id);
  if (inUse.n > 0) return res.status(409).json({ error: `In use by ${inUse.n} device(s)` });
  db.prepare('DELETE FROM device_models WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'model#' + req.params.id);
  res.json({ ok: true });
});

// ---- management overlay settings + provisioning (NOC/Admin) ----
const getSetting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v == null ? '' : v);

app.get('/api/settings', requireNoc, (req, res) => {
  res.json({
    zt_network_id: getSetting('zt_network_id') || '',
    wg_endpoint: getSetting('wg_endpoint') || '',
    wg_subnet: getSetting('wg_subnet') || '',
    wg_dns: getSetting('wg_dns') || '',
    wg_server_pub: getSetting('wg_server_pub') || '',
    backup_upload_base: getSetting('backup_upload_base') || '',
    has_zt_api_token: !!getSetting('zt_api_token'),
    has_wg_server_priv: !!getSetting('wg_server_priv')
  });
});
app.put('/api/settings', requireNoc, (req, res) => {
  const b = req.body || {};
  for (const k of ['zt_network_id', 'wg_endpoint', 'wg_subnet', 'wg_dns', 'backup_upload_base']) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  if (b.zt_api_token) setSetting('zt_api_token', String(b.zt_api_token).trim());
  if (!getSetting('wg_server_priv')) { const kp = wgKeypair(); setSetting('wg_server_priv', kp.privateKey); setSetting('wg_server_pub', kp.publicKey); }
  audit(req, 'edit', 'settings', 'overlay settings');
  res.json({ ok: true });
});
// Full hub (server) wg0.conf — includes the hub private key + all peers. Sensitive, audited.
app.get('/api/settings/wg/hub-config', requireNoc, (req, res) => {
  const subnet = getSetting('wg_subnet'), priv = getSetting('wg_server_priv');
  if (!subnet || !priv) return res.status(400).json({ error: 'Set the WireGuard subnet and save first' });
  const { mask } = parseCidr(subnet);
  const port = (getSetting('wg_endpoint') || '').split(':')[1] || '51820';
  const peers = db.prepare("SELECT name, wg_public_key, mgmt_address FROM devices WHERE mgmt_overlay='WireGuard' AND wg_public_key IS NOT NULL AND mgmt_address IS NOT NULL").all();
  let cfg = `[Interface]\nAddress = ${serverIp(subnet)}/${mask}\nListenPort = ${port}\nPrivateKey = ${priv}\n`;
  for (const p of peers) cfg += `\n# ${p.name}\n[Peer]\nPublicKey = ${p.wg_public_key}\nAllowedIPs = ${p.mgmt_address}/32\n`;
  audit(req, 'credential_read', 'settings', 'WG hub config (' + peers.length + ' peers)');
  res.json({ config: cfg, peers: peers.length });
});
app.post('/api/settings/wg/regenerate', requireNoc, (req, res) => {
  const kp = wgKeypair(); setSetting('wg_server_priv', kp.privateKey); setSetting('wg_server_pub', kp.publicKey);
  audit(req, 'edit', 'settings', 'regenerated WG server key');
  res.json({ public_key: kp.publicKey });
});

// Provision (or re-provision) a device on WireGuard: keypair + non-overlapping IP
app.post('/api/devices/:id/wireguard', requireNoc, (req, res) => {
  const dvc = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!dvc) return res.status(404).json({ error: 'not found' });
  const subnet = getSetting('wg_subnet');
  if (!subnet) return res.status(400).json({ error: 'Set a WireGuard subnet in Settings first' });
  let pub = dvc.wg_public_key, priv = dvc.wg_private_key;
  if (!pub || !priv) { const kp = wgKeypair(); pub = kp.publicKey; priv = kp.privateKey; }
  let addr = dvc.mgmt_address;
  if (!addr || dvc.mgmt_overlay !== 'WireGuard') {
    const taken = db.prepare("SELECT mgmt_address FROM devices WHERE mgmt_overlay='WireGuard' AND mgmt_address IS NOT NULL AND id<>?").all(req.params.id).map(r => r.mgmt_address);
    taken.push(serverIp(subnet));
    addr = nextFreeIp(subnet, taken);
  }
  if (!addr) return res.status(400).json({ error: 'No free IP in the WireGuard subnet' });
  db.prepare('UPDATE devices SET wg_public_key=?, wg_private_key=?, mgmt_overlay=?, mgmt_address=? WHERE id=?').run(pub, priv, 'WireGuard', addr, req.params.id);
  audit(req, 'edit', 'device#' + req.params.id, 'WireGuard provisioned ' + addr);
  res.json({ address: addr, public_key: pub });
});

// Download a device's WireGuard config (+ the server peer stanza). Contains a private key — audited.
app.get('/api/devices/:id/wireguard/config', requireNoc, (req, res) => {
  const dvc = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!dvc) return res.status(404).json({ error: 'not found' });
  if (!dvc.wg_private_key || !dvc.mgmt_address) return res.status(400).json({ error: 'Device is not provisioned on WireGuard yet' });
  const cfg = deviceConfig({
    privateKey: dvc.wg_private_key, address: dvc.mgmt_address, dns: getSetting('wg_dns'),
    serverPub: getSetting('wg_server_pub') || 'SET_WG_SERVER_KEY', endpoint: getSetting('wg_endpoint') || 'YOUR_HUB:51820',
    allowed: getSetting('wg_subnet') || '10.0.0.0/8'
  });
  const peer = serverPeerStanza({ name: dvc.name, publicKey: dvc.wg_public_key, address: dvc.mgmt_address });
  audit(req, 'credential_read', 'device#' + req.params.id, 'WireGuard config');
  res.json({ config: cfg, server_peer: peer, address: dvc.mgmt_address });
});

// Tag a device interface with a role (WAN1/WAN2/LAN/MGMT) — persists across polls
app.put('/api/devices/:id/iface-role', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.iface) return res.status(400).json({ error: 'iface required' });
  const d = db.prepare('SELECT iface_roles_json FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
  if (b.role) roles[b.iface] = b.role; else delete roles[b.iface];
  db.prepare('UPDATE devices SET iface_roles_json=? WHERE id=?').run(JSON.stringify(roles), req.params.id);
  audit(req, 'edit', 'device#' + req.params.id, `interface ${b.iface} → ${b.role || '(none)'}`);
  res.json({ ok: true });
});

// Poll a MikroTik RouterOS device over the management overlay for its live interfaces
app.post('/api/devices/:id/poll', requireNoc, async (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (!d.mgmt_address) return res.status(400).json({ error: 'No management IP — assign/provision the overlay first' });
  if (!d.admin_password) return res.status(400).json({ error: 'Add an admin password (and username) for this device first' });
  const user = d.admin_username || 'admin';
  const auth = 'Basic ' + Buffer.from(user + ':' + d.admin_password).toString('base64');
  const H = { Authorization: auth, Accept: 'application/json' };
  try {
    const r = await restReq(d.mgmt_address, '/rest/interface', { headers: H });
    if (r.status >= 400) {
      const hint = r.status === 401 ? ' (login rejected — check admin user/pass and that the REST service has access)' : '';
      return res.status(502).json({ error: `Device returned ${r.status}${hint}` });
    }
    let data;
    try { data = JSON.parse(r.body); } catch { return res.status(502).json({ error: 'Unexpected response from device (is REST enabled?)' }); }
    // Also pull IP addresses (best-effort) to show active IPs per interface + detect public IP
    let addresses = [];
    try {
      const r2 = await restReq(d.mgmt_address, '/rest/ip/address', { headers: H });
      if (r2.status < 400) { const a = JSON.parse(r2.body); if (Array.isArray(a)) addresses = a; }
    } catch {}
    const ipByIf = {};
    for (const a of addresses) { const ifn = a.interface, ip = (a.address || '').split('/')[0]; if (ifn && ip) (ipByIf[ifn] = ipByIf[ifn] || []).push(ip); }
    // Negotiated link speed via the ethernet monitor command (best-effort)
    const rateByName = {};
    try {
      const re = await restReq(d.mgmt_address, '/rest/interface/ethernet', { headers: H });
      if (re.status < 400) {
        const eth = JSON.parse(re.body);
        if (Array.isArray(eth) && eth.length) {
          const names = eth.map(e => e.name).filter(Boolean).join(',');
          const rm = await restReq(d.mgmt_address, '/rest/interface/ethernet/monitor', { headers: H, method: 'POST', body: { numbers: names, once: 'true' } });
          if (rm.status < 400) { const mon = JSON.parse(rm.body); if (Array.isArray(mon)) for (const m of mon) { if (m.name) rateByName[m.name] = m.rate || ''; } }
        }
      }
    } catch {}
    const ifaces = (Array.isArray(data) ? data : []).map(i => ({
      name: i.name, type: i.type || '',
      running: i.running === 'true' || i.running === true,
      disabled: i.disabled === 'true' || i.disabled === true,
      mac: i['mac-address'] || '', comment: i.comment || '',
      ips: ipByIf[i.name] || [], speed: rateByName[i.name] || ''
    }));
    const publicIp = addresses.map(a => (a.address || '').split('/')[0]).find(isPublicV4) || null;
    // Port-1 MAC (ether1, else first ethernet/interface with a MAC) + serial from routerboard
    const firstEth = ifaces.find(i => i.name === 'ether1') || ifaces.find(i => i.type === 'ether' && i.mac) || ifaces.find(i => i.mac);
    const macVal = firstEth ? firstEth.mac : null;
    let serialVal = null;
    try {
      const rb = await restReq(d.mgmt_address, '/rest/system/routerboard', { headers: H, timeoutMs: 7000 });
      if (rb.status < 400) { const j = JSON.parse(rb.body); const o = Array.isArray(j) ? j[0] : j; serialVal = (o && (o['serial-number'] || o['serial'])) || null; }
    } catch {}
    // WiFi presence (best-effort) — store SSIDs only, never passwords
    let wifiSummary = null;
    try {
      const wf = await readWifi(d);
      if (wf.system) wifiSummary = { system: wf.system, radios: wf.radios.map(r => ({ iface: r.iface, ssid: r.ssid, disabled: r.disabled, band: r.band, hasPassword: !!r.password })) };
    } catch {}
    const polled = new Date().toISOString();
    const sets = ['interfaces_json=?', 'wifi_json=?', 'last_polled=?']; const vals = [JSON.stringify(ifaces), wifiSummary ? JSON.stringify(wifiSummary) : null, polled];
    if (macVal) { sets.push('mac=?'); vals.push(macVal); }
    if (serialVal) { sets.push('serial=?'); vals.push(serialVal); }
    vals.push(d.id);
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    let setPublic = null, setMgmt = null, target = null;
    if (d.assigned_site_id) {           // assigned to a customer site
      if (d.mgmt_address) { db.prepare('UPDATE sites SET current_mgmt_ip=? WHERE id=?').run(d.mgmt_address, d.assigned_site_id); setMgmt = d.mgmt_address; }
      if (publicIp) { db.prepare('UPDATE sites SET current_public_ip=? WHERE id=?').run(publicIp, d.assigned_site_id); setPublic = publicIp; }
      target = 'site';
    } else if (d.assigned_pop_id) {      // assigned to a POP
      if (d.mgmt_address) { db.prepare('UPDATE pops SET current_mgmt_ip=? WHERE id=?').run(d.mgmt_address, d.assigned_pop_id); setMgmt = d.mgmt_address; }
      if (publicIp) { db.prepare('UPDATE pops SET current_public_ip=? WHERE id=?').run(publicIp, d.assigned_pop_id); setPublic = publicIp; }
      target = 'pop';
    }
    let harvested = 0; try { harvested = await harvestThreats(d); } catch {}
    audit(req, 'poll', 'device#' + d.id, `RouterOS poll: ${ifaces.length} interfaces${publicIp ? ', public ' + publicIp : ''}`);
    res.json({ count: ifaces.length, interfaces: ifaces, polled_at: polled, public_ip: publicIp, set_public: setPublic, set_mgmt: setMgmt, target, harvested, wifi: wifiSummary ? wifiSummary.radios.length : 0 });
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT' || e.message === 'timeout';
    let msg;
    if (timedOut) msg = 'Device unreachable (timed out) — is the server on the management overlay and the IP correct?';
    else if (e.code === 'ECONNREFUSED') msg = 'Device refused on ports 443 and 80 — enable the RouterOS web service (www or www-ssl) so the REST API is reachable.';
    else msg = 'Could not reach device: ' + e.message;
    res.status(502).json({ error: msg });
  }
});

// ---- RouterOS DHCP lease management (NOC/Admin) ----
function rosHeaders(d) {
  const user = d.admin_username || 'admin';
  return { Authorization: 'Basic ' + Buffer.from(user + ':' + d.admin_password).toString('base64'), Accept: 'application/json' };
}
function rosErr(e) {
  if (e.code === 'ETIMEDOUT' || e.message === 'timeout') return 'Device unreachable (timed out) — is the server on the management overlay and the IP correct?';
  if (e.code === 'ECONNREFUSED') return 'Device refused on ports 443 and 80 — enable the RouterOS web service (www or www-ssl).';
  return 'Could not reach device: ' + e.message;
}
function mapLease(l) {
  return {
    id: l['.id'],
    address: l.address || l['active-address'] || '',
    mac: l['mac-address'] || l['active-mac-address'] || '',
    host: l['host-name'] || '',
    server: l.server || '',
    status: l.status || '',
    dynamic: l.dynamic === 'true' || l.dynamic === true,
    blocked: l['block-access'] === 'true' || l['block-access'] === true,
    disabled: l.disabled === 'true' || l.disabled === true,
    expires: l['expires-after'] || '',
    lastSeen: l['last-seen'] || '',
    comment: l.comment || ''
  };
}
function dhcpDevice(req, res) {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) { res.status(404).json({ error: 'not found' }); return null; }
  if (!d.mgmt_address) { res.status(400).json({ error: 'No management IP — assign/provision the overlay first' }); return null; }
  if (!d.admin_password) { res.status(400).json({ error: 'Add an admin password (and username) for this device first' }); return null; }
  return d;
}

app.get('/api/devices/:id/dhcp-leases', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  try {
    const r = await restReq(d.mgmt_address, '/rest/ip/dhcp-server/lease', { headers: rosHeaders(d) });
    if (r.status >= 400) { const hint = r.status === 401 ? ' (login rejected — check admin user/pass)' : ''; return res.status(502).json({ error: `Device returned ${r.status}${hint}` }); }
    let data; try { data = JSON.parse(r.body); } catch { return res.status(502).json({ error: 'Unexpected response (is REST enabled?)' }); }
    const leases = (Array.isArray(data) ? data : []).map(mapLease)
      .sort((a, b) => String(a.address).localeCompare(String(b.address), undefined, { numeric: true }));
    res.json({ leases });
  } catch (e) { res.status(502).json({ error: rosErr(e) }); }
});

// action: make-static | block | unblock | disable | enable | remove
app.post('/api/devices/:id/dhcp-leases/action', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  const { id, mac, action } = req.body || {};
  let dynamic = (req.body || {}).dynamic === true || (req.body || {}).dynamic === 'true';
  if (!id || !action) return res.status(400).json({ error: 'id and action required' });
  const H = rosHeaders(d);
  const ros = (method, path, body) => restReq(d.mgmt_address, path, { headers: H, method, body });
  const findStaticIdByMac = async (m) => {
    const r = await ros('GET', '/rest/ip/dhcp-server/lease');
    if (r.status >= 400) return null;
    let arr = []; try { arr = JSON.parse(r.body); } catch {}
    const hit = (Array.isArray(arr) ? arr : []).find(l => (l['mac-address'] || '').toLowerCase() === String(m || '').toLowerCase() && !(l.dynamic === 'true' || l.dynamic === true));
    return hit ? hit['.id'] : null;
  };
  let curId = id;
  const ensureStatic = async () => {
    if (!dynamic) return;
    const mk = await ros('POST', '/rest/ip/dhcp-server/lease/make-static', { numbers: id });
    if (mk.status >= 400) throw Object.assign(new Error('make-static failed'), { http: mk.status });
    const sid = await findStaticIdByMac(mac); // .id changes when a dynamic lease becomes static
    if (sid) { curId = sid; dynamic = false; }
  };
  try {
    let r = null;
    const path = () => '/rest/ip/dhcp-server/lease/' + curId;
    if (action === 'make-static') { await ensureStatic(); }
    else if (action === 'block') { await ensureStatic(); r = await ros('PATCH', path(), { 'block-access': 'yes' }); }
    else if (action === 'unblock') { r = await ros('PATCH', path(), { 'block-access': 'no' }); }
    else if (action === 'disable') { await ensureStatic(); r = await ros('PATCH', path(), { disabled: 'yes' }); }
    else if (action === 'enable') { r = await ros('PATCH', path(), { disabled: 'no' }); }
    else if (action === 'remove') { r = await ros('DELETE', path()); }
    else return res.status(400).json({ error: 'unknown action' });
    if (r && r.status >= 400) return res.status(502).json({ error: `Device returned ${r.status}` });
    audit(req, 'dhcp', 'device#' + d.id, `${action} lease ${mac || id}`);
    res.json({ ok: true, action });
  } catch (e) { res.status(502).json({ error: e.http ? ('Device returned ' + e.http) : rosErr(e) }); }
});

// ---- RouterOS WiFi (legacy /interface/wireless + v7 /interface/wifi) ----
async function rosGet(d, path) {
  const r = await restReq(d.mgmt_address, path, { headers: rosHeaders(d) });
  if (r.status >= 400) return { err: r.status };
  try { return { data: JSON.parse(r.body) }; } catch { return { data: null }; }
}
// Returns { system: 'wifi'|'wireless'|null, radios:[{id,iface,ssid,password,disabled,band,profile?,profileId?,configRef?}] }
async function readWifi(d) {
  // v7 wifi (wifiwave2) first
  const w = await rosGet(d, '/rest/interface/wifi');
  if (!w.err && Array.isArray(w.data) && w.data.length) {
    const cfg = await rosGet(d, '/rest/interface/wifi/configuration');
    const cfgs = (!cfg.err && Array.isArray(cfg.data)) ? cfg.data : [];
    const byName = {}; for (const c of cfgs) if (c.name) byName[c.name] = c;
    const radios = w.data.map(i => {
      const cref = i.configuration || i['configuration.name'] || '';
      const c = cref ? byName[cref] : null;
      const ssid = i['configuration.ssid'] || (c && (c.ssid || c['ssid'])) || '';
      const password = i['security.passphrase'] || (c && c['security.passphrase']) || '';
      return { id: i['.id'], iface: i.name, ssid, password, disabled: i.disabled === 'true' || i.disabled === true, band: i['configuration.band'] || (c && c.band) || '', configRef: cref };
    });
    return { system: 'wifi', radios };
  }
  // legacy wireless
  const wl = await rosGet(d, '/rest/interface/wireless');
  if (!wl.err && Array.isArray(wl.data) && wl.data.length) {
    const sp = await rosGet(d, '/rest/interface/wireless/security-profiles');
    const sps = (!sp.err && Array.isArray(sp.data)) ? sp.data : [];
    const byName = {}; for (const s of sps) if (s.name) byName[s.name] = s;
    const radios = wl.data.map(i => {
      const prof = i['security-profile'] || 'default';
      const s = byName[prof];
      const password = s ? (s['wpa2-pre-shared-key'] || s['wpa-pre-shared-key'] || '') : '';
      return { id: i['.id'], iface: i.name, ssid: i.ssid || '', password, disabled: i.disabled === 'true' || i.disabled === true, band: i.band || '', profile: prof, profileId: s ? s['.id'] : null };
    });
    return { system: 'wireless', radios };
  }
  return { system: null, radios: [] };
}
async function writeWifi(d, b) {
  const H = rosHeaders(d);
  const ros = (method, path, body) => restReq(d.mgmt_address, path, { headers: H, method, body });
  if (b.system === 'wifi') {
    const body = {};
    if (b.ssid != null && b.ssid !== '') body['configuration.ssid'] = b.ssid;
    if (b.password != null && b.password !== '') body['security.passphrase'] = b.password;
    if (!Object.keys(body).length) return;
    const r = await ros('PATCH', '/rest/interface/wifi/' + b.id, body);
    if (r.status >= 400) throw Object.assign(new Error('set failed'), { http: r.status });
    return;
  }
  if (b.system === 'wireless') {
    if (b.ssid != null && b.ssid !== '') {
      const r = await ros('PATCH', '/rest/interface/wireless/' + b.id, { ssid: b.ssid });
      if (r.status >= 400) throw Object.assign(new Error('ssid set failed'), { http: r.status });
    }
    if (b.password != null && b.password !== '') {
      let pid = b.profileId;
      if (!pid) {
        const sp = await rosGet(d, '/rest/interface/wireless/security-profiles');
        const sps = (!sp.err && Array.isArray(sp.data)) ? sp.data : [];
        const s = sps.find(x => x.name === (b.profile || 'default'));
        pid = s ? s['.id'] : null;
      }
      if (!pid) throw Object.assign(new Error('no security profile to update'), { http: 400 });
      const r = await ros('PATCH', '/rest/interface/wireless/security-profiles/' + pid, { 'wpa2-pre-shared-key': b.password, 'wpa-pre-shared-key': b.password });
      if (r.status >= 400) throw Object.assign(new Error('passphrase set failed'), { http: r.status });
    }
    return;
  }
  throw Object.assign(new Error('unknown wifi system'), { http: 400 });
}

app.get('/api/devices/:id/wifi', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  try {
    const wf = await readWifi(d);
    audit(req, 'credential_read', 'device#' + d.id, 'wifi (' + (wf.system || 'none') + ')');
    res.json(wf);
  } catch (e) { res.status(502).json({ error: e.http ? ('Device returned ' + e.http) : rosErr(e) }); }
});
app.post('/api/devices/:id/wifi', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  const b = req.body || {};
  if (!b.id || !b.system) return res.status(400).json({ error: 'id and system required' });
  try {
    await writeWifi(d, b);
    audit(req, 'edit', 'device#' + d.id, `wifi ${b.iface || b.id}: ssid${b.ssid ? '=' + b.ssid : ' unchanged'}${b.password ? ', password changed' : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.http ? ('Device returned ' + e.http) : rosErr(e) }); }
});
// Associated WiFi clients + signal (registration table) for diagnostics
function parseSignal(v) { if (v == null) return null; const m = String(v).match(/-?\d+/); return m ? parseInt(m[0], 10) : null; }
async function readWifiClients(d, preferred) {
  const tryWifi = async () => { const r = await rosGet(d, '/rest/interface/wifi/registration-table'); return (!r.err && Array.isArray(r.data)) ? { system: 'wifi', data: r.data } : null; };
  const tryWl = async () => { const r = await rosGet(d, '/rest/interface/wireless/registration-table'); return (!r.err && Array.isArray(r.data)) ? { system: 'wireless', data: r.data } : null; };
  const res = preferred === 'wireless' ? (await tryWl() || await tryWifi()) : (await tryWifi() || await tryWl());
  if (!res) return { system: null, clients: [] };
  const clients = res.data.map(r => ({
    iface: r.interface || '',
    ssid: r.ssid || '',
    mac: r['mac-address'] || '',
    signal: parseSignal(r.signal != null ? r.signal : r['signal-strength']),
    snr: parseSignal(r['signal-to-noise']),
    txRate: r['tx-rate'] || '',
    rxRate: r['rx-rate'] || '',
    uptime: r.uptime || '',
    lastIp: r['last-ip'] || '',
    comment: r.comment || ''
  }));
  return { system: res.system, clients };
}
app.get('/api/devices/:id/wifi-clients', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  let pref = null; try { pref = (JSON.parse(d.wifi_json || '{}')).system; } catch {}
  try { res.json(await readWifiClients(d, pref)); }
  catch (e) { res.status(502).json({ error: e.http ? ('Device returned ' + e.http) : rosErr(e) }); }
});

// ---- router config backups (RouterOS text export) ----
const backupDevices = () => db.prepare("SELECT * FROM devices WHERE management_mode='platform' AND mgmt_address IS NOT NULL AND mgmt_address<>'' AND admin_password IS NOT NULL AND admin_password<>''").all();
// Pull readable text out of whatever shape /rest/export or a file read returns
function exportText(body) {
  let text = body || ''; const t = String(text).trim();
  if (t.startsWith('[') || t.startsWith('{') || t.startsWith('"')) {
    try {
      const j = JSON.parse(t);
      if (typeof j === 'string') text = j;
      else if (Array.isArray(j)) text = j.map(x => typeof x === 'string' ? x : (x.section || x.line || x.ret || x.contents || x.output || '')).filter(Boolean).join('\n');
      else if (j && typeof j === 'object') text = j.ret || j.output || j.export || j.contents || '';
    } catch {}
  }
  return text;
}
const _sleep = ms => new Promise(r => setTimeout(r, ms));
const pendingUploads = new Map(); // token -> { resolve }
// Ask the router to POST its exported .rsc to our upload endpoint (works when REST won't return file contents)
async function fetchUploadFromRouter(d, ros, base, srcFileName) {
  const token = randomUUID();
  const url = base.replace(/\/+$/, '') + '/router-upload/' + token;
  const p = new Promise(resolve => pendingUploads.set(token, { resolve }));
  const fr = await ros('POST', '/rest/tool/fetch', { url, 'http-method': 'post', upload: 'yes', 'src-path': srcFileName, 'keep-result': 'no' });
  if (fr.status >= 400) { pendingUploads.delete(token); throw new Error('tool/fetch rejected: ' + fr.status + ' ' + String(fr.body || '').slice(0, 240)); }
  const got = await Promise.race([p, _sleep(20000).then(() => null)]);
  pendingUploads.delete(token);
  if (got == null) throw new Error('Router could not reach the backup upload URL — check Settings → backup upload URL and that the router can reach the server on the overlay');
  return got;
}
async function backupDevice(d, source) {
  const H = rosHeaders(d);
  const ros = (method, path, body) => restReq(d.mgmt_address, path, { headers: H, method, body, timeoutMs: 25000 });
  let text = '';
  // Strategy A: some RouterOS builds return the export inline in the response body
  try { const r = await ros('POST', '/rest/export', {}); if (r.status < 400) text = exportText(r.body); } catch {}
  // Strategy B: export to a .rsc file on the router, then retrieve it
  if (!text || !text.trim()) {
    const fname = 'netinv-backup';
    const ex = await ros('POST', '/rest/export', { file: fname });
    if (ex.status >= 400) throw Object.assign(new Error('export failed'), { http: ex.status });
    await _sleep(1500); // give the router a moment to write the file
    const fr = await ros('GET', '/rest/file');
    let files = []; if (fr.status < 400) { try { files = JSON.parse(fr.body); } catch {} }
    const f = (Array.isArray(files) ? files : []).find(x => (x.name || '') === fname + '.rsc' || (x.name || '').endsWith('/' + fname + '.rsc'));
    if (f) {
      // B1: try reading the file's text contents over REST (works on some builds)
      text = f.contents || '';
      if ((!text || !text.trim()) && f['.id']) { const one = await ros('GET', '/rest/file/' + f['.id']); if (one.status < 400) { try { const o = JSON.parse(one.body); const obj = Array.isArray(o) ? o[0] : o; text = obj.contents || ''; } catch {} } }
      // B2: if REST won't hand back contents, have the router push the file to us
      if (!text || !text.trim()) {
        const base = getSetting('backup_upload_base');
        if (base) { try { text = await fetchUploadFromRouter(d, ros, base, f.name); } catch (e) { if (f['.id']) { try { await ros('DELETE', '/rest/file/' + f['.id']); } catch {} } throw e; } }
      }
      if (f['.id']) { try { await ros('DELETE', '/rest/file/' + f['.id']); } catch {} } // tidy up flash
    }
  }
  if (!text || !text.trim()) throw new Error('Router won\'t return config over REST — set the backup upload URL in Settings so the router can push the file');
  const stored = 'bak-' + d.id + '-' + Date.now() + '.rsc';
  writeFileSync(join(BACKUPS_DIR, stored), text);
  const size = Buffer.byteLength(text);
  const info = db.prepare("INSERT INTO router_backups (device_id,status,size,stored_name,format,source) VALUES (?,?,?,?,?,?)").run(d.id, 'ok', size, stored, 'rsc', source || 'auto');
  return { id: info.lastInsertRowid, size };
}
function pruneOldBackups() {
  const old = db.prepare("SELECT * FROM router_backups WHERE created_at < datetime('now','-183 days')").all(); // ~6 months
  for (const b of old) { if (b.stored_name) { try { unlinkSync(join(BACKUPS_DIR, b.stored_name)); } catch {} } db.prepare('DELETE FROM router_backups WHERE id=?').run(b.id); }
  return old.length;
}
async function runWeeklyBackups(source) {
  let ok = 0, fail = 0;
  for (const d of backupDevices()) {
    try { await backupDevice(d, source); ok++; }
    catch (e) { fail++; db.prepare("INSERT INTO router_backups (device_id,status,error,format,source) VALUES (?,?,?,?,?)").run(d.id, 'error', e.http ? ('HTTP ' + e.http) : (e.message || 'error'), 'rsc', source || 'auto'); }
  }
  const pruned = pruneOldBackups();
  return { ok, fail, pruned };
}
// Receiver for RouterOS /tool/fetch uploads — token-gated (no session; the router can't auth)
app.post('/router-upload/:token', express.raw({ type: '*/*', limit: '35mb' }), (req, res) => {
  const p = pendingUploads.get(req.params.token);
  if (!p) return res.status(404).json({ error: 'unknown or expired token' });
  let text = '';
  if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8');
  else if (typeof req.body === 'string') text = req.body;
  else if (req.body && typeof req.body === 'object') text = JSON.stringify(req.body);
  p.resolve(text);
  res.json({ ok: true });
});
app.get('/api/devices/:id/backups', requireNoc, (req, res) => {
  res.json(db.prepare('SELECT id, status, error, size, format, source, created_at FROM router_backups WHERE device_id=? ORDER BY datetime(created_at) DESC').all(req.params.id));
});
app.post('/api/devices/:id/backup', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  try { const r = await backupDevice(d, 'manual'); pruneOldBackups(); audit(req, 'backup', 'device#' + d.id, 'manual export ' + r.size + 'b'); res.json({ ok: true, ...r }); }
  catch (e) {
    db.prepare("INSERT INTO router_backups (device_id,status,error,format,source) VALUES (?,?,?,?,?)").run(d.id, 'error', e.http ? ('HTTP ' + e.http) : (e.message || 'error'), 'rsc', 'manual');
    res.status(502).json({ error: e.http ? ('Device returned ' + e.http + ' — does this RouterOS expose /rest/export?') : rosErr(e) });
  }
});
// Diagnostic: run each backup step and report raw RouterOS responses
app.get('/api/devices/:id/backup-debug', requireNoc, async (req, res) => {
  const d = dhcpDevice(req, res); if (!d) return;
  const H = rosHeaders(d);
  const ros = (m, p, b) => restReq(d.mgmt_address, p, { headers: H, method: m, body: b, timeoutMs: 25000 });
  const out = { device: d.name, mgmt: d.mgmt_address, steps: [] };
  const rec = (label, r) => out.steps.push({ label, status: r && r.status, bodyLen: r && r.body ? String(r.body).length : 0, snippet: r && r.body ? String(r.body).slice(0, 500) : '' });
  try { rec('POST /rest/export {}', await ros('POST', '/rest/export', {})); } catch (e) { out.steps.push({ label: 'POST /rest/export {}', error: e.message }); }
  try { rec('POST /rest/export {file:netinv-backup}', await ros('POST', '/rest/export', { file: 'netinv-backup' })); } catch (e) { out.steps.push({ label: 'POST /rest/export {file}', error: e.message }); }
  await new Promise(r => setTimeout(r, 1500));
  try {
    const c = await ros('GET', '/rest/file');
    let files = []; try { files = JSON.parse(c.body); } catch {}
    files = Array.isArray(files) ? files : [];
    out.steps.push({ label: 'GET /rest/file', status: c.status, count: files.length });
    out.files = files.map(f => ({ name: f.name, type: f.type, size: f.size, hasContents: f.contents != null, contentsLen: f.contents ? String(f.contents).length : 0 }));
    const f = files.find(x => (x.name || '').includes('netinv-backup'));
    if (f && f['.id']) {
      out.steps.push({ label: 'matched export file', name: f.name, size: f.size, type: f.type, hasContents: f.contents != null });
      const one = await ros('GET', '/rest/file/' + f['.id']);
      let cl = 0, sn = ''; try { const o = JSON.parse(one.body); const obj = Array.isArray(o) ? o[0] : o; cl = obj.contents ? String(obj.contents).length : 0; sn = obj.contents ? String(obj.contents).slice(0, 300) : ''; } catch {}
      out.steps.push({ label: 'GET /rest/file/:id (netinv-backup)', status: one.status, fileSize: f.size, contentsLen: cl, snippet: sn });
      // alternate read: collection GET filtered by name with explicit proplist
      try { const alt = await ros('GET', '/rest/file?name=' + encodeURIComponent(f.name) + '&.proplist=name,size,contents'); let al = 0; try { const a = JSON.parse(alt.body); const o = Array.isArray(a) ? a[0] : a; al = o && o.contents ? String(o.contents).length : 0; } catch {} out.steps.push({ label: 'GET /rest/file?name=..&.proplist=contents', status: alt.status, contentsLen: al }); } catch (e) { out.steps.push({ label: 'alt read', error: e.message }); }
      // tool/fetch upload attempt — show RouterOS's raw response so we can fix params
      const base = getSetting('backup_upload_base');
      if (base) {
        const variants = [
          { label: "fetch upload (url, src-path, upload=yes, post)", body: { url: base.replace(/\/+$/, '') + '/router-upload/diag', 'http-method': 'post', upload: 'yes', 'src-path': f.name, 'keep-result': 'no' } },
          { label: "fetch upload (url, src-path, upload=yes, mode=http)", body: { url: base.replace(/\/+$/, '') + '/router-upload/diag', mode: 'http', upload: 'yes', 'src-path': f.name, 'keep-result': 'no' } },
          { label: "fetch upload (upload-file, post)", body: { url: base.replace(/\/+$/, '') + '/router-upload/diag', 'http-method': 'post', 'upload-file': f.name, 'keep-result': 'no' } }
        ];
        for (const v of variants) { try { const ff = await ros('POST', '/rest/tool/fetch', v.body); out.steps.push({ label: v.label, status: ff.status, snippet: String(ff.body || '').slice(0, 300) }); } catch (e) { out.steps.push({ label: v.label, error: e.message }); } }
      } else { out.steps.push({ label: 'tool/fetch', note: 'backup_upload_base not set in Settings' }); }
      try { await ros('DELETE', '/rest/file/' + f['.id']); } catch {}
    } else {
      out.steps.push({ label: 'find netinv-backup.rsc', note: 'not found in file list' });
    }
  } catch (e) { out.steps.push({ label: 'GET /rest/file', error: e.message }); }
  res.json(out);
});
app.get('/api/backups/:id/download', requireNoc, (req, res) => {
  const b = db.prepare('SELECT * FROM router_backups WHERE id=?').get(req.params.id);
  if (!b || !b.stored_name) return res.status(404).json({ error: 'not found' });
  const fp = join(BACKUPS_DIR, b.stored_name);
  if (!existsSync(fp)) return res.status(404).json({ error: 'file missing' });
  const dev = db.prepare('SELECT name FROM devices WHERE id=?').get(b.device_id) || {};
  const fname = ((dev.name || 'router').replace(/[^a-z0-9_-]+/gi, '_')) + '-' + b.created_at.replace(/[: ]/g, '-') + '.rsc';
  audit(req, 'backup_read', 'device#' + b.device_id, 'download backup#' + b.id);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', statSync(fp).size);
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  createReadStream(fp).pipe(res);
});
app.delete('/api/backups/:id', requireNoc, (req, res) => {
  const b = db.prepare('SELECT * FROM router_backups WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  if (b.stored_name) { try { unlinkSync(join(BACKUPS_DIR, b.stored_name)); } catch {} }
  db.prepare('DELETE FROM router_backups WHERE id=?').run(b.id);
  audit(req, 'delete', 'device#' + b.device_id, 'backup#' + b.id);
  res.json({ ok: true });
});

// Fetch from ZeroTier Central with a timeout so a slow/hung call can't stall a request
async function ztFetch(path, token, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch('https://api.zerotier.com/api/v1' + path, { headers: { Authorization: 'token ' + token }, signal: ac.signal });
  } finally { clearTimeout(t); }
}

// Live list of ZeroTier members, annotated with which device (if any) is linked
app.get('/api/zerotier/members', requireNoc, async (req, res) => {
  try {
    const nwid = getSetting('zt_network_id'), token = getSetting('zt_api_token');
    if (!nwid || !token) return res.status(400).json({ error: 'Set ZeroTier network ID and API token in Settings first' });
    const r = await ztFetch(`/network/${nwid}/member`, token);
    if (!r.ok) { const t = await r.text().catch(() => ''); return res.status(502).json({ error: `ZeroTier API ${r.status}${t ? ': ' + t.slice(0, 160) : ''}` }); }
    let members = await r.json();
    if (!Array.isArray(members)) members = (members && Array.isArray(members.data)) ? members.data : [];
    const devs = db.prepare("SELECT id, name, zt_node_id, assigned_site_id, assigned_pop_id FROM devices WHERE zt_node_id IS NOT NULL AND zt_node_id<>''").all();
    const map = {};
    for (const dv of devs) {
      let where = null;
      if (dv.assigned_site_id) { const s = db.prepare('SELECT name FROM sites WHERE id=?').get(dv.assigned_site_id); if (s) where = s.name; }
      else if (dv.assigned_pop_id) { const p = db.prepare('SELECT name FROM pops WHERE id=?').get(dv.assigned_pop_id); if (p) where = 'POP · ' + p.name; }
      map[dv.zt_node_id] = { id: dv.id, name: dv.name, site: where };
    }
    const now = Date.now();
    const out = members.map(m => {
      const nodeId = m.nodeId || (m.config && m.config.nodeId) || m.id || '';
      const ips = (m.config && Array.isArray(m.config.ipAssignments)) ? m.config.ipAssignments : [];
      const lastSeen = m.lastSeen || m.lastOnline || 0;
      const online = (m.online !== undefined) ? !!m.online : (lastSeen > 0 && (now - lastSeen) < 300000);
      return { nodeId: String(nodeId), name: m.name || '', authorized: !!(m.config && m.config.authorized), ip: ips[0] || null, lastSeen, online, device: map[nodeId] || null };
    });
    out.sort((a, b) => (Number(b.online) - Number(a.online)) || String(a.name || a.nodeId).localeCompare(String(b.name || b.nodeId)));
    res.json({ network: nwid, count: out.length, online: out.filter(m => m.online).length, members: out });
  } catch (e) {
    res.status(502).json({ error: 'ZeroTier members failed: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
});

// Pull member IPs from ZeroTier Central and update matched devices
app.post('/api/zerotier/sync', requireNoc, async (req, res) => {
  try {
    const nwid = getSetting('zt_network_id'), token = getSetting('zt_api_token');
    if (!nwid || !token) return res.status(400).json({ error: 'Set ZeroTier network ID and API token in Settings first' });
    const r = await ztFetch(`/network/${nwid}/member`, token);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const hint = r.status === 401 ? ' (token rejected — check for extra spaces and that it is a Central API token)' : '';
      return res.status(502).json({ error: `ZeroTier API ${r.status}${hint}${t ? ': ' + t.slice(0, 160) : ''}` });
    }
    let members = await r.json();
    if (!Array.isArray(members)) members = (members && Array.isArray(members.data)) ? members.data : [];
    let updated = 0;
    const devs = db.prepare("SELECT id, zt_node_id FROM devices WHERE zt_node_id IS NOT NULL AND zt_node_id<>''").all();
    for (const d of devs) {
      const m = members.find(x => (x.nodeId || (x.config && x.config.nodeId) || x.id) === d.zt_node_id);
      const ip = m && m.config && Array.isArray(m.config.ipAssignments) ? m.config.ipAssignments[0] : null;
      if (ip) { db.prepare("UPDATE devices SET mgmt_overlay='ZeroTier', mgmt_address=? WHERE id=?").run(ip, d.id); updated++; }
    }
    audit(req, 'edit', 'zerotier', `sync: ${updated} device(s) from ${members.length} member(s)`);
    res.json({ members: members.length, updated });
  } catch (e) {
    res.status(502).json({ error: 'ZeroTier sync failed: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
});

// Strip credential values from a device row, replace with has_* flags
function publicDevice(d) {
  const out = { ...d };
  for (const f of ALL_CREDS) { out['has_' + f] = !!out[f]; delete out[f]; }
  out.wg_provisioned = !!out.wg_private_key;
  delete out.wg_private_key; // only released via the audited config endpoint
  return out;
}

// ---- meta / lookups ----
app.get('/api/meta', (req, res) => {
  res.json({
    pops: db.prepare('SELECT * FROM pops ORDER BY name').all(),
    providers: db.prepare('SELECT * FROM upstream_providers ORDER BY name').all(),
    models: db.prepare('SELECT * FROM device_models ORDER BY manufacturer, model').all(),
    controllers: db.prepare('SELECT * FROM controllers ORDER BY name').all(),
    accounts: db.prepare('SELECT id, name FROM accounts ORDER BY name').all(),
    role: role(req), privileged: isPriv(req)
  });
});

// ---- address autocomplete (OpenStreetMap / Nominatim) ----
const _geoCache = new Map(); // key -> { t, results }
const GEO_TTL = 60 * 60 * 1000;
function geoFmt(a, display) {
  if (!a) return display || '';
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county;
  const region = [a.state, a.postcode].filter(Boolean).join(' ');
  const parts = [line1, city, region].filter(Boolean);
  return parts.length ? parts.join(', ') : (display || '');
}
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  const key = q.toLowerCase();
  const hit = _geoCache.get(key);
  if (hit && Date.now() - hit.t < GEO_TTL) return res.json(hit.results);
  try {
    const cc = (db.prepare("SELECT value FROM settings WHERE key='geocode_countrycodes'").get() || {}).value;
    let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=' + encodeURIComponent(q);
    if (cc !== '') url += '&countrycodes=' + encodeURIComponent(cc || 'us');
    const r = await reqJson(https, url, {
      headers: { 'User-Agent': 'NetInv/1.0 (network inventory; +https://management.geekitek.com)', 'Accept-Language': 'en' },
      timeoutMs: 8000
    });
    if (r.status !== 200) return res.status(502).json({ error: 'geocoder ' + r.status });
    let arr = [];
    try { arr = JSON.parse(r.body); } catch { arr = []; }
    const results = (Array.isArray(arr) ? arr : []).map(x => ({
      label: geoFmt(x.address, x.display_name),
      display: x.display_name,
      lat: x.lat, lon: x.lon
    })).filter(x => x.label);
    _geoCache.set(key, { t: Date.now(), results });
    if (_geoCache.size > 400) _geoCache.delete(_geoCache.keys().next().value);
    res.json(results);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- accounts ----
app.get('/api/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM sites s WHERE s.account_id=a.id) AS site_count
    FROM accounts a ORDER BY a.name`).all();
  rows.forEach(r => { delete r.pin; delete r.portal_password; delete r.security_questions; }); // never expose secrets in the list
  res.json(rows);
});

app.get('/api/accounts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  a.contacts = db.prepare('SELECT * FROM account_contacts WHERE account_id=?').all(a.id);
  a.previous_isps = db.prepare('SELECT * FROM previous_isps WHERE account_id=?').all(a.id);
  a.customers = db.prepare('SELECT * FROM customers WHERE account_id=? ORDER BY name').all(a.id).map(c => ({ ...c, site_count: db.prepare('SELECT COUNT(*) AS n FROM sites WHERE customer_id=?').get(c.id).n }));
  a.sites = db.prepare('SELECT * FROM sites WHERE account_id=?').all(a.id).map(withSiteSummary);
  a.device_count = a.sites.reduce((n, s) => n + s.device_total, 0);
  a.needs_attention = a.sites.filter(s => s.needs_attention).length;
  a.has_pin = !!a.pin;
  a.has_portal_password = !!a.portal_password;
  a.has_security_questions = !!a.security_questions;
  if (!isPriv(req)) { delete a.pin; delete a.portal_password; delete a.security_questions; } // sensitive: NOC/Admin only
  res.json(a);
});

app.post('/api/accounts', requireNoc, (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO accounts (name, account_number, sub_account, pin, email, portal_url, portal_password, security_questions, status, billing_address, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(N(b.name), N(b.account_number), N(b.sub_account), N(b.pin), N(b.email), N(b.portal_url), N(b.portal_password), N(b.security_questions), b.status || 'Active', N(b.billing_address), N(b.notes));
  const id = info.lastInsertRowid;
  for (const c of (b.contacts || [])) {
    db.prepare('INSERT INTO account_contacts (account_id,name,role,email,phone,is_primary,is_billing) VALUES (?,?,?,?,?,?,?)')
      .run(id, N(c.name), N(c.role), N(c.email), N(c.phone), c.is_primary ? 1 : 0, c.is_billing ? 1 : 0);
  }
  for (const p of (b.previous_isps || [])) {
    db.prepare('INSERT INTO previous_isps (account_id,provider,until_label,reason) VALUES (?,?,?,?)')
      .run(id, N(p.provider), N(p.until_label), N(p.reason));
  }
  audit(req, 'create', 'account#' + id, b.name);
  res.json({ id });
});

app.put('/api/accounts/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE accounts SET name=?, account_number=?, sub_account=?, email=?, portal_url=?, status=?, billing_address=?, notes=? WHERE id=?')
    .run(N(b.name), N(b.account_number), N(b.sub_account), N(b.email), N(b.portal_url), N(b.status, 'Active'), N(b.billing_address), N(b.notes), req.params.id);
  if (b.pin) db.prepare('UPDATE accounts SET pin=? WHERE id=?').run(b.pin, req.params.id);
  if (b.portal_password) db.prepare('UPDATE accounts SET portal_password=? WHERE id=?').run(b.portal_password, req.params.id);
  if (b.security_questions) db.prepare('UPDATE accounts SET security_questions=? WHERE id=?').run(b.security_questions, req.params.id);
  audit(req, 'edit', 'account#' + req.params.id, b.name);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', requireNoc, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'account#' + req.params.id);
  res.json({ ok: true });
});

// ---- sites ----
function withSiteSummary(s) {
  const devs = db.prepare('SELECT online FROM devices WHERE assigned_type=\'site\' AND assigned_site_id=?').all(s.id);
  const online = devs.filter(d => d.online).length;
  const conns = db.prepare('SELECT status FROM connections WHERE site_id=?').all(s.id);
  const anyDown = conns.some(c => c.status === 'Down');
  const onFailover = conns.length > 1 && conns.find(c => c.role === 'Primary' && c.status !== 'Up');
  const conn_status = anyDown ? 'Down' : (onFailover ? 'On failover' : 'Up');
  const account = db.prepare('SELECT name FROM accounts WHERE id=?').get(s.account_id);
  const customer = s.customer_id ? db.prepare('SELECT name FROM customers WHERE id=?').get(s.customer_id) : null;
  return {
    ...s, account_name: account ? account.name : null, customer_name: customer ? customer.name : null,
    device_online: online, device_total: devs.length,
    conn_status,
    needs_attention: anyDown || online < devs.length
  };
}

app.get('/api/sites', (req, res) => {
  const rows = db.prepare('SELECT * FROM sites ORDER BY name').all().map(withSiteSummary);
  res.json(rows);
});

app.get('/api/sites/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const out = withSiteSummary(s);
  out.account = db.prepare('SELECT id, name FROM accounts WHERE id=?').get(s.account_id);
  out.customer = s.customer_id ? db.prepare('SELECT id, name FROM customers WHERE id=?').get(s.customer_id) : null;
  out.connections = db.prepare('SELECT * FROM connections WHERE site_id=? ORDER BY priority').all(s.id).map(resolveConn);
  out.devices = db.prepare('SELECT d.*, m.manufacturer, m.model, m.device_type FROM devices d LEFT JOIN device_models m ON m.id=d.model_id WHERE d.assigned_type=\'site\' AND d.assigned_site_id=? ORDER BY d.name').all(s.id).map(publicDevice);
  out.notes = withNoteAttachments(db.prepare('SELECT * FROM site_notes WHERE site_id=? ORDER BY datetime(created_at) DESC').all(s.id));
  res.json(out);
});

function resolveConn(c) {
  let served = '';
  if (c.served_type === 'pop' && c.served_pop_id) {
    const p = db.prepare('SELECT name, lat, lng, address FROM pops WHERE id=?').get(c.served_pop_id);
    served = p ? 'POP · ' + p.name : 'POP';
    c.served_geo = p ? { lat: p.lat, lng: p.lng, address: p.address } : null;
  } else if (c.served_type === 'brokered' && c.served_provider_id) {
    const p = db.prepare('SELECT name FROM upstream_providers WHERE id=?').get(c.served_provider_id);
    served = p ? 'Brokered · ' + p.name : 'Brokered';
  }
  c.served_label = served;
  return c;
}

// a site's account always follows its customer's account
function accountForCustomer(customerId) {
  if (!customerId) return null;
  const c = db.prepare('SELECT account_id FROM customers WHERE id=?').get(customerId);
  return c ? c.account_id : null;
}
app.post('/api/sites', (req, res) => {
  const b = req.body || {};
  const accountId = accountForCustomer(b.customer_id) || b.account_id;
  if (!accountId) return res.status(400).json({ error: 'A customer (or account) is required' });
  const info = db.prepare('INSERT INTO sites (account_id,customer_id,name,service_address,lat,lng,status,current_mgmt_ip,current_public_ip,notes) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(N(accountId), N(b.customer_id || null), N(b.name), N(b.service_address), N(b.lat || null), N(b.lng || null), b.status || 'Active', N(b.current_mgmt_ip), N(b.current_public_ip), N(b.notes));
  audit(req, 'create', 'site#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/sites/:id', (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT customer_id, account_id FROM sites WHERE id=?').get(req.params.id);
  const customerId = b.customer_id !== undefined ? b.customer_id : (ex ? ex.customer_id : null);
  const accountId = accountForCustomer(customerId) || (ex ? ex.account_id : null);
  db.prepare('UPDATE sites SET account_id=?, customer_id=?, name=?, service_address=?, lat=?, lng=?, status=?, current_mgmt_ip=?, current_public_ip=?, notes=? WHERE id=?')
    .run(N(accountId), N(customerId || null), N(b.name), N(b.service_address), N(b.lat || null), N(b.lng || null), N(b.status, 'Active'), N(b.current_mgmt_ip), N(b.current_public_ip), N(b.notes), req.params.id);
  audit(req, 'edit', 'site#' + req.params.id, b.name);
  res.json({ ok: true });
});

// ---- customers (under an account; NOC/Admin manage) ----
app.get('/api/customers', (req, res) => {
  const where = req.query.account_id ? ' WHERE c.account_id=' + Number(req.query.account_id) : '';
  const rows = db.prepare(`SELECT c.*, a.name AS account_name, (SELECT COUNT(*) FROM sites s WHERE s.customer_id=c.id) AS site_count FROM customers c LEFT JOIN accounts a ON a.id=c.account_id${where} ORDER BY c.name`).all();
  res.json(rows);
});
app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.account = db.prepare('SELECT id, name FROM accounts WHERE id=?').get(c.account_id);
  c.sites = db.prepare('SELECT * FROM sites WHERE customer_id=?').all(c.id).map(withSiteSummary);
  c.device_count = c.sites.reduce((n, s) => n + s.device_total, 0);
  c.needs_attention = c.sites.filter(s => s.needs_attention).length;
  res.json(c);
});
app.post('/api/customers', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.account_id) return res.status(400).json({ error: 'Account required' });
  if (!b.name) return res.status(400).json({ error: 'Customer name required' });
  const info = db.prepare('INSERT INTO customers (account_id,name,status,notes) VALUES (?,?,?,?)').run(N(b.account_id), N(b.name), b.status || 'Active', N(b.notes));
  audit(req, 'create', 'customer#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/customers/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE customers SET name=?, status=?, notes=?, account_id=? WHERE id=?').run(N(b.name, ex.name), N(b.status, ex.status), N(b.notes), N(b.account_id, ex.account_id), req.params.id);
  // keep sites' account_id in sync with the customer's account
  db.prepare('UPDATE sites SET account_id=? WHERE customer_id=?').run(N(b.account_id, ex.account_id), req.params.id);
  audit(req, 'edit', 'customer#' + req.params.id, b.name);
  res.json({ ok: true });
});
app.delete('/api/customers/:id', requireNoc, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE customer_id=?').get(req.params.id).n;
  if (n > 0) return res.status(409).json({ error: `Has ${n} site(s)` });
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'customer#' + req.params.id);
  res.json({ ok: true });
});

app.delete('/api/sites/:id', (req, res) => {
  db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'site#' + req.params.id);
  res.json({ ok: true });
});

// ---- POP sites (owned infrastructure; NOC/Admin manage) ----
function withPopSummary(p) {
  const devs = db.prepare("SELECT online FROM devices WHERE assigned_type='pop' AND assigned_pop_id=?").all(p.id);
  return { ...p, device_online: devs.filter(d => d.online).length, device_total: devs.length };
}
app.get('/api/pops', (req, res) => {
  res.json(db.prepare('SELECT * FROM pops ORDER BY name').all().map(withPopSummary));
});
app.get('/api/pops/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pops WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const out = withPopSummary(p);
  out.devices = db.prepare("SELECT d.*, m.manufacturer, m.model, m.device_type FROM devices d LEFT JOIN device_models m ON m.id=d.model_id WHERE d.assigned_type='pop' AND d.assigned_pop_id=? ORDER BY d.name").all(p.id).map(publicDevice);
  out.served_sites = db.prepare(`SELECT DISTINCT s.id, s.name FROM sites s JOIN connections c ON c.site_id=s.id WHERE c.served_type='pop' AND c.served_pop_id=? ORDER BY s.name`).all(p.id);
  out.circuits = db.prepare('SELECT * FROM pop_circuits WHERE pop_id=? ORDER BY id').all(p.id).map(withCircuitLabel);
  out.notes = withNoteAttachments(db.prepare('SELECT * FROM pop_notes WHERE pop_id=? ORDER BY datetime(created_at) DESC').all(p.id));
  res.json(out);
});
function withCircuitLabel(c) {
  let label = '—';
  if (c.source_type === 'pop' && c.source_pop_id) { const p = db.prepare('SELECT name FROM pops WHERE id=?').get(c.source_pop_id); label = p ? ('POP · ' + p.name) : 'POP'; }
  else if (c.source_type === 'account' && c.source_account_id) { const a = db.prepare('SELECT name FROM accounts WHERE id=?').get(c.source_account_id); label = a ? a.name : 'Account'; }
  return { ...c, source_label: label };
}
app.post('/api/pops/:id/circuits', requireNoc, (req, res) => {
  const b = req.body || {};
  if (b.source_type !== 'pop' && b.source_type !== 'account') return res.status(400).json({ error: 'source_type must be pop or account' });
  if (b.source_type === 'pop' && !b.source_pop_id) return res.status(400).json({ error: 'Pick a source POP' });
  if (b.source_type === 'account' && !b.source_account_id) return res.status(400).json({ error: 'Pick a source account' });
  const info = db.prepare('INSERT INTO pop_circuits (pop_id, source_type, source_pop_id, source_account_id, circuit_id, bandwidth, status, notes) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.params.id, b.source_type, b.source_type === 'pop' ? N(b.source_pop_id) : null, b.source_type === 'account' ? N(b.source_account_id) : null, N(b.circuit_id), N(b.bandwidth), b.status || 'Up', N(b.notes));
  audit(req, 'create', 'pop#' + req.params.id, 'circuit#' + info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/pops/:id/circuits/:cid', requireNoc, (req, res) => {
  const b = req.body || {};
  if (b.source_type !== 'pop' && b.source_type !== 'account') return res.status(400).json({ error: 'source_type must be pop or account' });
  db.prepare('UPDATE pop_circuits SET source_type=?, source_pop_id=?, source_account_id=?, circuit_id=?, bandwidth=?, status=?, notes=? WHERE id=? AND pop_id=?')
    .run(b.source_type, b.source_type === 'pop' ? N(b.source_pop_id) : null, b.source_type === 'account' ? N(b.source_account_id) : null, N(b.circuit_id), N(b.bandwidth), N(b.status, 'Up'), N(b.notes), req.params.cid, req.params.id);
  audit(req, 'edit', 'pop#' + req.params.id, 'circuit#' + req.params.cid);
  res.json({ ok: true });
});
app.delete('/api/pops/:id/circuits/:cid', requireNoc, (req, res) => {
  db.prepare('DELETE FROM pop_circuits WHERE id=? AND pop_id=?').run(req.params.cid, req.params.id);
  audit(req, 'delete', 'pop#' + req.params.id, 'circuit#' + req.params.cid);
  res.json({ ok: true });
});
app.post('/api/pops/:id/notes', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO pop_notes (pop_id, author, author_role, body) VALUES (?,?,?,?)').run(req.params.id, b.author || 'tester', role(req), N(b.body));
  audit(req, 'note', 'pop#' + req.params.id);
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.get('/api/pops/:id/access', requireNoc, (req, res) => {
  const r = db.prepare('SELECT body FROM pop_access WHERE pop_id=?').get(req.params.id);
  audit(req, 'access_read', 'pop#' + req.params.id, 'pop access');
  res.json({ body: r ? r.body : '' });
});
app.put('/api/pops/:id/access', requireNoc, (req, res) => {
  const b = req.body || {};
  db.prepare('INSERT INTO pop_access (pop_id, body) VALUES (?,?) ON CONFLICT(pop_id) DO UPDATE SET body=excluded.body').run(req.params.id, N(b.body));
  audit(req, 'edit', 'pop#' + req.params.id, 'pop access');
  res.json({ ok: true });
});
app.post('/api/pops', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO pops (name, code, address, lat, lng, status, current_mgmt_ip, current_public_ip) VALUES (?,?,?,?,?,?,?,?)')
    .run(N(b.name), N(b.code), N(b.address), N(b.lat || null), N(b.lng || null), b.status || 'Active', N(b.current_mgmt_ip), N(b.current_public_ip));
  audit(req, 'create', 'pop#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/pops/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE pops SET name=?, code=?, address=?, lat=?, lng=?, status=?, current_mgmt_ip=?, current_public_ip=? WHERE id=?')
    .run(N(b.name), N(b.code), N(b.address), N(b.lat || null), N(b.lng || null), N(b.status, 'Active'), N(b.current_mgmt_ip), N(b.current_public_ip), req.params.id);
  audit(req, 'edit', 'pop#' + req.params.id, b.name);
  res.json({ ok: true });
});
app.delete('/api/pops/:id', requireNoc, (req, res) => {
  const d = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE assigned_type='pop' AND assigned_pop_id=?").get(req.params.id);
  const c = db.prepare("SELECT COUNT(*) AS n FROM connections WHERE served_type='pop' AND served_pop_id=?").get(req.params.id);
  if (d.n + c.n > 0) return res.status(409).json({ error: `In use by ${d.n} device(s) and ${c.n} connection(s)` });
  db.prepare('DELETE FROM pops WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'pop#' + req.params.id);
  res.json({ ok: true });
});

// ---- note attachments (pictures + PDFs) ----
const ATT_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const ATT_MAX = 25 * 1024 * 1024; // 25 MB
function withNoteAttachments(notes) {
  const q = db.prepare('SELECT id, filename, mime, size FROM note_attachments WHERE note_id=? ORDER BY id');
  for (const n of notes) n.attachments = q.all(n.id);
  return notes;
}
app.post('/api/attachments', (req, res) => {
  const b = req.body || {};
  if (!['site', 'pop'].includes(b.parent_type) || !b.parent_id) return res.status(400).json({ error: 'parent_type and parent_id required' });
  if (!ATT_MIME[b.mime]) return res.status(400).json({ error: 'Only images (PNG/JPG/GIF/WebP) and PDF are allowed' });
  let raw = String(b.data || '');
  const comma = raw.indexOf(','); if (raw.startsWith('data:') && comma !== -1) raw = raw.slice(comma + 1); // strip data URL prefix
  let buf; try { buf = Buffer.from(raw, 'base64'); } catch { return res.status(400).json({ error: 'Bad file data' }); }
  if (!buf.length) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > ATT_MAX) return res.status(413).json({ error: 'File too large (max 25 MB)' });
  const stored = randomUUID() + ATT_MIME[b.mime];
  try { writeFileSync(join(UPLOADS_DIR, stored), buf); } catch (e) { return res.status(500).json({ error: 'Could not save file' }); }
  const info = db.prepare('INSERT INTO note_attachments (parent_type,parent_id,note_id,filename,mime,size,stored_name,author) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.parent_type, b.parent_id, N(b.note_id), N(b.filename, 'file'), b.mime, buf.length, stored, (req.user && req.user.email) || '');
  audit(req, 'attach', b.parent_type + '#' + b.parent_id, b.filename || stored);
  res.json({ id: info.lastInsertRowid, filename: b.filename, mime: b.mime, size: buf.length });
});
app.get('/api/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM note_attachments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const fp = join(UPLOADS_DIR, a.stored_name);
  if (!existsSync(fp)) return res.status(404).json({ error: 'file missing' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Length', statSync(fp).size);
  res.setHeader('Content-Disposition', `inline; filename="${(a.filename || 'file').replace(/"/g, '')}"`);
  createReadStream(fp).pipe(res);
});
app.delete('/api/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM note_attachments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!isPriv(req) && a.author !== (req.user && req.user.email)) return res.status(403).json({ error: 'Only the author or NOC/Admin can delete' });
  try { unlinkSync(join(UPLOADS_DIR, a.stored_name)); } catch {}
  db.prepare('DELETE FROM note_attachments WHERE id=?').run(a.id);
  audit(req, 'delete', a.parent_type + '#' + a.parent_id, 'attachment#' + a.id);
  res.json({ ok: true });
});

// site notes
app.post('/api/sites/:id/notes', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO site_notes (site_id,author,author_role,body) VALUES (?,?,?,?)')
    .run(req.params.id, b.author || 'tester', role(req), N(b.body));
  audit(req, 'note', 'site#' + req.params.id);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// pinned site access (sensitive — NOC/Admin only)
app.get('/api/sites/:id/access', (req, res) => {
  if (!isPriv(req)) return res.status(403).json({ error: 'NOC/Admin only' });
  const row = db.prepare('SELECT details_json FROM site_access WHERE site_id=?').get(req.params.id);
  audit(req, 'access_read', 'site#' + req.params.id, 'site access');
  res.json(row ? JSON.parse(row.details_json) : {});
});

// connections
app.post('/api/sites/:id/connections', (req, res) => {
  const b = req.body || {};
  const info = db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_pop_id,served_provider_id,circuit_id,wan_port,ip_type,static_ip,current_ip,bandwidth,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.params.id, b.role||'Primary', b.priority||1, N(b.served_type), N(b.served_pop_id), N(b.served_provider_id), N(b.circuit_id), N(b.wan_port), b.ip_type||'Static', N(b.static_ip), N(b.current_ip), N(b.bandwidth), b.status||'Up');
  audit(req, 'create', 'connection#' + info.lastInsertRowid, 'site#' + req.params.id);
  res.json({ id: info.lastInsertRowid });
});

// ---- devices ----
app.get('/api/devices', (req, res) => {
  const rows = db.prepare('SELECT d.*, m.manufacturer, m.model, m.device_type FROM devices d LEFT JOIN device_models m ON m.id=d.model_id ORDER BY d.name').all().map(publicDevice);
  res.json(rows);
});

app.get('/api/devices/:id', (req, res) => {
  const d = db.prepare('SELECT d.*, m.manufacturer, m.model, m.device_type, m.has_wifi, m.has_cellular FROM devices d LEFT JOIN device_models m ON m.id=d.model_id WHERE d.id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  // resolve assignment label
  if (d.assigned_type === 'site' && d.assigned_site_id) d.assigned_label = (db.prepare('SELECT name FROM sites WHERE id=?').get(d.assigned_site_id)||{}).name;
  if (d.assigned_type === 'pop' && d.assigned_pop_id) d.assigned_label = 'POP · ' + ((db.prepare('SELECT name FROM pops WHERE id=?').get(d.assigned_pop_id)||{}).name||'');
  res.json(publicDevice(d));
});

// reveal credentials (role-gated, audited)
app.post('/api/devices/:id/reveal', (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const out = {};
  const fields = isPriv(req) ? ALL_CREDS : TECH_CREDS;
  for (const f of fields) if (d[f]) out[f] = d[f];
  audit(req, 'credential_read', 'device#' + d.id, fields.join(','));
  res.json({ role: role(req), privileged: isPriv(req), credentials: out });
});

app.post('/api/devices', (req, res) => {
  const b = req.body || {};
  const cols = ['name','model_id','serial','mac','status','online','assigned_type','assigned_site_id','assigned_pop_id','management_mode','mgmt_overlay','mgmt_address','controller_id','ownership','owner_org','account_number','owner_account','owner_sub_account','account_status','hfc_mac','purchased_from','associated_connection_id','cell_carrier','cell_phone','cell_imei','cell_sim','cell_sku','factory_password','admin_password','tech_username','tech_password','factory_wifi_ssid','factory_wifi_password','acct_pin','acct_portal_username','acct_portal_password','acct_passphrase','zt_node_id','admin_username'];
  const vals = cols.map(c => b[c] === undefined ? null : b[c]);
  const info = db.prepare(`INSERT INTO devices (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...vals);
  audit(req, 'create', 'device#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/devices/:id', (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const cols = ['name','model_id','serial','mac','status','online','assigned_type','assigned_site_id','assigned_pop_id','management_mode','mgmt_overlay','mgmt_address','controller_id','ownership','owner_org','account_number','owner_account','owner_sub_account','account_status','hfc_mac','purchased_from','associated_connection_id','cell_carrier','cell_phone','cell_imei','cell_sim','cell_sku','factory_wifi_ssid','tech_username','zt_node_id','admin_username'];
  // credentials only overwritten if provided (non-empty)
  const credCols = ['factory_password','admin_password','tech_password','factory_wifi_password','acct_pin','acct_portal_username','acct_portal_password','acct_passphrase'];
  const sets = [], vals = [];
  for (const c of cols) { sets.push(`${c}=?`); vals.push(b[c] === undefined ? existing[c] : b[c]); }
  for (const c of credCols) { if (b[c]) { sets.push(`${c}=?`); vals.push(b[c]); } }
  vals.push(req.params.id);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  audit(req, 'edit', 'device#' + req.params.id, b.name || existing.name);
  res.json({ ok: true });
});

app.delete('/api/devices/:id', (req, res) => {
  db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'device#' + req.params.id);
  res.json({ ok: true });
});

// ---- audit ----
app.get('/api/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

// ---- telemetry: per-port traffic + device latency ----
const RANGE_SEC = { '1h': 3600, '24h': 86400, '7d': 604800, '60d': 5184000 };
function sinceIso(range) { return new Date(Date.now() - (RANGE_SEC[range] || 3600) * 1000).toISOString(); }

app.get('/api/devices/:id/traffic', (req, res) => {
  const iface = req.query.iface, range = req.query.range || '1h';
  if (!iface) return res.status(400).json({ error: 'iface required' });
  const rows = db.prepare('SELECT ts, rx_bps, tx_bps FROM iface_traffic WHERE device_id=? AND iface=? AND ts>=? ORDER BY ts').all(req.params.id, iface, sinceIso(range));
  res.json(rows);
});
app.get('/api/devices/:id/latency', (req, res) => {
  const range = req.query.range || '1h';
  const rows = db.prepare('SELECT ts, ms FROM dev_latency WHERE device_id=? AND ts>=? ORDER BY ts').all(req.params.id, sinceIso(range));
  res.json(rows);
});
// Aggregated traffic across interfaces tagged WAN1/WAN2
app.get('/api/devices/:id/wan-traffic', (req, res) => {
  const range = req.query.range || '1h';
  const d = db.prepare('SELECT iface_roles_json FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
  const wan = Object.keys(roles).filter(k => roles[k] === 'WAN1' || roles[k] === 'WAN2');
  if (!wan.length) return res.json([]);
  const ph = wan.map(() => '?').join(',');
  const rows = db.prepare(`SELECT ts, SUM(rx_bps) AS rx_bps, SUM(tx_bps) AS tx_bps FROM iface_traffic WHERE device_id=? AND iface IN (${ph}) AND ts>=? GROUP BY ts ORDER BY ts`).all(req.params.id, ...wan, sinceIso(range));
  res.json(rows);
});

// RTT string -> ms (RouterOS ping 'time' like "12ms", "1ms200us")
function parseRtt(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const str = String(s); let ms = 0, matched = false;
  const m = str.match(/(\d+(?:\.\d+)?)ms/); if (m) { ms += parseFloat(m[1]); matched = true; }
  const u = str.match(/(\d+(?:\.\d+)?)us/); if (u) { ms += parseFloat(u[1]) / 1000; matched = true; }
  const sec = str.match(/(\d+(?:\.\d+)?)s(?![a-z])/); if (sec) { ms += parseFloat(sec[1]) * 1000; matched = true; }
  return matched ? Math.round(ms * 100) / 100 : null;
}

const _lastCtr = new Map(); // device:iface -> {rx,tx,t}
async function sampleDevice(d) {
  const user = d.admin_username || 'admin';
  const H = { Authorization: 'Basic ' + Buffer.from(user + ':' + d.admin_password).toString('base64'), Accept: 'application/json' };
  const now = Date.now(), ts = new Date(now).toISOString();
  // traffic from interface byte counters
  const r = await restReq(d.mgmt_address, '/rest/interface', { headers: H, timeoutMs: 7000 });
  if (r.status < 400) {
    let arr; try { arr = JSON.parse(r.body); } catch { arr = null; }
    if (Array.isArray(arr)) for (const i of arr) {
      const rx = Number(i['rx-byte'] ?? i['rx-bytes']), tx = Number(i['tx-byte'] ?? i['tx-bytes']);
      if (!isFinite(rx) || !isFinite(tx)) continue;
      const key = d.id + ':' + i.name, prev = _lastCtr.get(key);
      _lastCtr.set(key, { rx, tx, t: now });
      if (prev) { const dt = (now - prev.t) / 1000; if (dt > 0 && rx >= prev.rx && tx >= prev.tx) {
        db.prepare('INSERT INTO iface_traffic (device_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?)')
          .run(d.id, i.name, ts, Math.round((rx - prev.rx) * 8 / dt), Math.round((tx - prev.tx) * 8 / dt));
      } }
    }
  }
  // WAN latency via router ping
  try {
    const rp = await restReq(d.mgmt_address, '/rest/ping', { headers: H, method: 'POST', body: { address: '8.8.8.8', count: '3' }, timeoutMs: 7000 });
    if (rp.status < 400) {
      const p = JSON.parse(rp.body);
      const times = (Array.isArray(p) ? p : []).map(x => parseRtt(x.time)).filter(v => v != null);
      if (times.length) db.prepare('INSERT INTO dev_latency (device_id,ts,ms) VALUES (?,?,?)').run(d.id, ts, Math.round(times.reduce((a, b) => a + b, 0) / times.length * 100) / 100);
    }
  } catch {}
}
let _sampling = false, _tickN = 0, _lastPushedSig = null;
const blocklistSig = () => activeBlockIps().join(',');
async function sampleTick() {
  if (_sampling) return; _sampling = true; _tickN++;
  try {
    const devs = db.prepare("SELECT * FROM devices WHERE management_mode='platform' AND mgmt_address IS NOT NULL AND mgmt_address<>'' AND admin_password IS NOT NULL AND admin_password<>''").all();
    // every minute: sample traffic/latency + harvest failed-login IPs
    for (const d of devs) { try { await sampleDevice(d); await harvestThreats(d); } catch {} }
    // auto-push the blocklist when it changed (or every 10 min to repair drift)
    if (process.env.AUTO_PUSH !== 'off') {
      const sig = blocklistSig();
      if (sig && (sig !== _lastPushedSig || _tickN % 10 === 0)) {
        for (const d of devs) { try { await pushBlocklistToDevice(d); } catch {} }
        _lastPushedSig = sig;
      }
    }
    const cutoff = new Date(Date.now() - 5184000 * 1000).toISOString();
    db.prepare('DELETE FROM iface_traffic WHERE ts<?').run(cutoff);
    db.prepare('DELETE FROM dev_latency WHERE ts<?').run(cutoff);
    // weekly router config backups (kept 6 months) — guarded by a persisted timestamp
    if (process.env.BACKUPS !== 'off') {
      const last = (db.prepare("SELECT value FROM settings WHERE key='last_backup_run'").get() || {}).value;
      if (!last || (Date.now() - Date.parse(last)) > 7 * 24 * 3600 * 1000) {
        try { await runWeeklyBackups('auto'); } catch {}
        db.prepare("INSERT INTO settings (key,value) VALUES ('last_backup_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
      }
    }
  } finally { _sampling = false; }
}
if (process.env.SAMPLER !== 'off') {
  setInterval(() => { sampleTick().catch(() => {}); }, 60000);
  console.log('Sampler enabled every 60s: traffic, latency, threat harvest + blocklist auto-push + weekly router backups (SAMPLER=off / AUTO_PUSH=off / BACKUPS=off to disable)');
}

// ---- threat blocklist ----
app.get('/api/blocklist', requireNoc, (req, res) => {
  res.json({
    min_hits: blocklistMinHits(),
    list: db.prepare('SELECT * FROM blocklist ORDER BY active DESC, hits DESC, datetime(last_seen) DESC').all()
  });
});
app.put('/api/blocklist/settings', requireNoc, (req, res) => {
  const n = parseInt((req.body || {}).min_hits, 10);
  if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'min_hits must be a whole number ≥ 1' });
  db.prepare("INSERT INTO settings (key,value) VALUES ('blocklist_min_hits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
  audit(req, 'edit', 'blocklist', 'min_hits=' + n);
  res.json({ ok: true, min_hits: n });
});
app.post('/api/blocklist', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.ip) return res.status(400).json({ error: 'IP required' });
  db.prepare("INSERT INTO blocklist (ip,reason,hits,source,active) VALUES (?,?,?,?,1) ON CONFLICT(ip) DO UPDATE SET active=1, reason=excluded.reason").run(String(b.ip).trim(), N(b.reason, 'manual'), 1, 'manual');
  audit(req, 'create', 'blocklist', b.ip);
  res.json({ ok: true });
});
app.put('/api/blocklist/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE blocklist SET active=? WHERE id=?').run(b.active ? 1 : 0, req.params.id);
  audit(req, 'edit', 'blocklist#' + req.params.id, b.active ? 'active' : 'inactive');
  res.json({ ok: true });
});
app.delete('/api/blocklist/:id', requireNoc, (req, res) => {
  db.prepare('DELETE FROM blocklist WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'blocklist#' + req.params.id);
  res.json({ ok: true });
});
app.post('/api/blocklist/scan', requireNoc, async (req, res) => {
  const devs = db.prepare("SELECT * FROM devices WHERE management_mode='platform' AND mgmt_address IS NOT NULL AND mgmt_address<>'' AND admin_password IS NOT NULL AND admin_password<>''").all();
  let scanned = 0, found = 0;
  for (const d of devs) { try { found += await harvestThreats(d); scanned++; } catch {} }
  audit(req, 'edit', 'blocklist', `scanned ${scanned} device(s)`);
  res.json({ scanned, found, total: db.prepare('SELECT COUNT(*) AS n FROM blocklist').get().n });
});
app.post('/api/blocklist/push', requireNoc, async (req, res) => {
  const b = req.body || {};
  const devs = b.device_id
    ? db.prepare('SELECT * FROM devices WHERE id=?').all(b.device_id)
    : db.prepare("SELECT * FROM devices WHERE management_mode='platform' AND mgmt_address IS NOT NULL AND mgmt_address<>'' AND admin_password IS NOT NULL AND admin_password<>''").all();
  const results = [];
  for (const d of devs) { try { const r = await pushBlocklistToDevice(d); results.push({ device: d.name, ...r }); } catch (e) { results.push({ device: d.name, error: e.code || e.message }); } }
  audit(req, 'config_push', 'blocklist', `pushed to ${results.length} device(s)`);
  res.json({ results });
});

// ---- static frontend ----
app.use(express.static(join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Network Inventory Platform running on http://localhost:${PORT}`));
