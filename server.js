// Network Inventory & Management Platform — API + static server (testing build)
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, initSchema, migrate, isEmpty, seed } from './db.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// First-run: create schema + seed if empty
initSchema();
migrate();
if (isEmpty()) { seed(); console.log('Database seeded on first run.'); }

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
    has_zt_api_token: !!getSetting('zt_api_token'),
    has_wg_server_priv: !!getSetting('wg_server_priv')
  });
});
app.put('/api/settings', requireNoc, (req, res) => {
  const b = req.body || {};
  for (const k of ['zt_network_id', 'wg_endpoint', 'wg_subnet', 'wg_dns']) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
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
    const polled = new Date().toISOString();
    const sets = ['interfaces_json=?', 'last_polled=?']; const vals = [JSON.stringify(ifaces), polled];
    if (macVal) { sets.push('mac=?'); vals.push(macVal); }
    if (serialVal) { sets.push('serial=?'); vals.push(serialVal); }
    vals.push(d.id);
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    let setPublic = null;
    if (d.assigned_type === 'site' && d.assigned_site_id) {
      if (d.mgmt_address) db.prepare('UPDATE sites SET current_mgmt_ip=? WHERE id=?').run(d.mgmt_address, d.assigned_site_id);
      if (publicIp) { db.prepare('UPDATE sites SET current_public_ip=? WHERE id=?').run(publicIp, d.assigned_site_id); setPublic = publicIp; }
    } else if (d.assigned_type === 'pop' && d.assigned_pop_id) {
      if (d.mgmt_address) db.prepare('UPDATE pops SET current_mgmt_ip=? WHERE id=?').run(d.mgmt_address, d.assigned_pop_id);
      if (publicIp) { db.prepare('UPDATE pops SET current_public_ip=? WHERE id=?').run(publicIp, d.assigned_pop_id); setPublic = publicIp; }
    }
    audit(req, 'poll', 'device#' + d.id, `RouterOS poll: ${ifaces.length} interfaces${publicIp ? ', public ' + publicIp : ''}`);
    res.json({ count: ifaces.length, interfaces: ifaces, polled_at: polled, public_ip: publicIp, set_public: setPublic });
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT' || e.message === 'timeout';
    let msg;
    if (timedOut) msg = 'Device unreachable (timed out) — is the server on the management overlay and the IP correct?';
    else if (e.code === 'ECONNREFUSED') msg = 'Device refused on ports 443 and 80 — enable the RouterOS web service (www or www-ssl) so the REST API is reachable.';
    else msg = 'Could not reach device: ' + e.message;
    res.status(502).json({ error: msg });
  }
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
    const devs = db.prepare("SELECT id, name, zt_node_id FROM devices WHERE zt_node_id IS NOT NULL AND zt_node_id<>''").all();
    const map = {}; devs.forEach(d => { map[d.zt_node_id] = { id: d.id, name: d.name }; });
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

// ---- accounts ----
app.get('/api/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM sites s WHERE s.account_id=a.id) AS site_count
    FROM accounts a ORDER BY a.name`).all();
  rows.forEach(r => delete r.pin); // never expose PIN in the list
  res.json(rows);
});

app.get('/api/accounts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  a.contacts = db.prepare('SELECT * FROM account_contacts WHERE account_id=?').all(a.id);
  a.previous_isps = db.prepare('SELECT * FROM previous_isps WHERE account_id=?').all(a.id);
  a.sites = db.prepare('SELECT * FROM sites WHERE account_id=?').all(a.id).map(withSiteSummary);
  a.device_count = a.sites.reduce((n, s) => n + s.device_total, 0);
  a.needs_attention = a.sites.filter(s => s.needs_attention).length;
  a.has_pin = !!a.pin;
  if (!isPriv(req)) delete a.pin; // PIN visible to NOC/Admin only
  res.json(a);
});

app.post('/api/accounts', requireNoc, (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO accounts (name, account_number, sub_account, pin, status, billing_address, notes) VALUES (?,?,?,?,?,?,?)')
    .run(N(b.name), N(b.account_number), N(b.sub_account), N(b.pin), b.status || 'Active', N(b.billing_address), N(b.notes));
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
  db.prepare('UPDATE accounts SET name=?, account_number=?, sub_account=?, status=?, billing_address=?, notes=? WHERE id=?')
    .run(N(b.name), N(b.account_number), N(b.sub_account), N(b.status, 'Active'), N(b.billing_address), N(b.notes), req.params.id);
  if (b.pin) db.prepare('UPDATE accounts SET pin=? WHERE id=?').run(b.pin, req.params.id);
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
  return {
    ...s, account_name: account ? account.name : null,
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
  out.connections = db.prepare('SELECT * FROM connections WHERE site_id=? ORDER BY priority').all(s.id).map(resolveConn);
  out.devices = db.prepare('SELECT d.*, m.manufacturer, m.model, m.device_type FROM devices d LEFT JOIN device_models m ON m.id=d.model_id WHERE d.assigned_type=\'site\' AND d.assigned_site_id=? ORDER BY d.name').all(s.id).map(publicDevice);
  out.notes = db.prepare('SELECT * FROM site_notes WHERE site_id=? ORDER BY datetime(created_at) DESC').all(s.id);
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

app.post('/api/sites', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO sites (account_id,name,service_address,lat,lng,status,current_mgmt_ip,current_public_ip,notes) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(N(b.account_id), N(b.name), N(b.service_address), N(b.lat || null), N(b.lng || null), b.status || 'Active', N(b.current_mgmt_ip), N(b.current_public_ip), N(b.notes));
  audit(req, 'create', 'site#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/sites/:id', (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE sites SET name=?, service_address=?, lat=?, lng=?, status=?, current_mgmt_ip=?, current_public_ip=?, notes=? WHERE id=?')
    .run(N(b.name), N(b.service_address), N(b.lat || null), N(b.lng || null), N(b.status, 'Active'), N(b.current_mgmt_ip), N(b.current_public_ip), N(b.notes), req.params.id);
  audit(req, 'edit', 'site#' + req.params.id, b.name);
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
  out.notes = db.prepare('SELECT * FROM pop_notes WHERE pop_id=? ORDER BY datetime(created_at) DESC').all(p.id);
  res.json(out);
});
app.post('/api/pops/:id/notes', (req, res) => {
  const b = req.body || {};
  db.prepare('INSERT INTO pop_notes (pop_id, author, author_role, body) VALUES (?,?,?,?)').run(req.params.id, b.author || 'tester', role(req), N(b.body));
  audit(req, 'note', 'pop#' + req.params.id);
  res.json({ ok: true });
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

// site notes
app.post('/api/sites/:id/notes', (req, res) => {
  const b = req.body || {};
  db.prepare('INSERT INTO site_notes (site_id,author,author_role,body) VALUES (?,?,?,?)')
    .run(req.params.id, b.author || 'tester', role(req), N(b.body));
  audit(req, 'note', 'site#' + req.params.id);
  res.json({ ok: true });
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
let _sampling = false;
async function sampleTick() {
  if (_sampling) return; _sampling = true;
  try {
    const devs = db.prepare("SELECT * FROM devices WHERE management_mode='platform' AND mgmt_address IS NOT NULL AND mgmt_address<>'' AND admin_password IS NOT NULL AND admin_password<>''").all();
    for (const d of devs) { try { await sampleDevice(d); } catch {} }
    const cutoff = new Date(Date.now() - 5184000 * 1000).toISOString();
    db.prepare('DELETE FROM iface_traffic WHERE ts<?').run(cutoff);
    db.prepare('DELETE FROM dev_latency WHERE ts<?').run(cutoff);
  } finally { _sampling = false; }
}
if (process.env.SAMPLER !== 'off') {
  setInterval(() => { sampleTick().catch(() => {}); }, 60000);
  console.log('Telemetry sampler enabled (every 60s; set SAMPLER=off to disable)');
}

// ---- static frontend ----
app.use(express.static(join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Network Inventory Platform running on http://localhost:${PORT}`));
