// Network Inventory & Management Platform — API + static server (testing build)
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { writeFileSync, createReadStream, existsSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { db, initSchema, migrate, isEmpty, seed, backfillCustomers, backfillAccountCustomers, UPLOADS_DIR, BACKUPS_DIR, PACKAGES_DIR } from './db.js';
import { importModelCatalog } from './model-catalog.js';
import { createSession, destroySession, userForToken, parseCookies, setSessionCookie, clearSessionCookie } from './auth.js';
import { hashPassword, verifyPassword } from './hash.js';
import { wgKeypair, nextFreeIp, serverIp, deviceConfig, serverPeerStanza, parseCidr } from './wg.js';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import nodemailer from 'nodemailer';

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
// Stripe webhook needs the RAW body for signature verification, so it registers before the JSON parser
app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => stripeWebhook(req, res));
app.use(express.json({ limit: '60mb' })); // raised so base64 note attachments + .npk package uploads fit

// First-run: create schema + seed if empty
initSchema();
migrate();
if (isEmpty()) { seed(); console.log('Database seeded on first run.'); }
backfillCustomers();
backfillAccountCustomers();
{ const n = importModelCatalog(db); if (n) console.log(`Model catalog: added ${n} device model(s).`); }

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
// Send email via the configured SMTP server (no-op if not configured). Never throws to the caller.
async function sendMail({ to, subject, text, html }) {
  const host = getSetting('smtp_host'), from = getSetting('mail_from');
  if (!host || !from || !to) return false;
  const tx = nodemailer.createTransport({
    host, port: parseInt(getSetting('smtp_port'), 10) || 587, secure: getSetting('smtp_secure') === '1',
    auth: getSetting('smtp_user') ? { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') || '' } : undefined
  });
  await tx.sendMail({ from, to, subject, text, html });
  return true;
}
const mailSafe = (opts) => { sendMail(opts).catch(e => console.warn('email send failed:', e.message)); };

app.get('/api/settings', requireNoc, (req, res) => {
  res.json({
    zt_network_id: getSetting('zt_network_id') || '',
    wg_endpoint: getSetting('wg_endpoint') || '',
    wg_subnet: getSetting('wg_subnet') || '',
    wg_dns: getSetting('wg_dns') || '',
    wg_server_pub: getSetting('wg_server_pub') || '',
    backup_upload_base: getSetting('backup_upload_base') || '',
    public_base_url: getSetting('public_base_url') || '',
    allow_auto_enroll: getSetting('allow_auto_enroll') === '1',
    prov_wifi_ssid: getSetting('prov_wifi_ssid') || '',
    smtp_host: getSetting('smtp_host') || '',
    smtp_port: getSetting('smtp_port') || '',
    smtp_secure: getSetting('smtp_secure') === '1',
    smtp_user: getSetting('smtp_user') || '',
    mail_from: getSetting('mail_from') || '',
    access_notify_email: getSetting('access_notify_email') || '',
    auto_checkout_at: getSetting('auto_checkout_at') || '',
    invoice_terms: getSetting('invoice_terms') || '',
    recurring_invoice_terms: getSetting('recurring_invoice_terms') || '',
    has_smtp_pass: !!getSetting('smtp_pass'),
    has_provision_token: !!getSetting('provision_token'),
    has_prov_admin_password: !!getSetting('prov_admin_password'),
    has_prov_wifi_password: !!getSetting('prov_wifi_password'),
    has_zt_api_token: !!getSetting('zt_api_token'),
    has_wg_server_priv: !!getSetting('wg_server_priv'),
    has_stripe_secret: !!getSetting('stripe_secret'),
    has_stripe_webhook_secret: !!getSetting('stripe_webhook_secret'),
    bill_company: getSetting('bill_company') || '',
    bill_prefix: getSetting('bill_prefix') || 'INV-',
    bill_next: getSetting('bill_next') || '1001',
    quote_prefix: getSetting('quote_prefix') || 'QUO-',
    quote_next: getSetting('quote_next') || '1001'
  });
});
app.put('/api/settings', requireNoc, (req, res) => {
  const b = req.body || {};
  for (const k of ['zt_network_id', 'wg_endpoint', 'wg_subnet', 'wg_dns', 'backup_upload_base', 'public_base_url', 'prov_wifi_ssid', 'smtp_host', 'smtp_port', 'smtp_user', 'mail_from', 'access_notify_email', 'auto_checkout_at']) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  for (const k of ['invoice_terms', 'recurring_invoice_terms']) if (b[k] !== undefined) setSetting(k, String(b[k])); // multi-line, don't trim internal formatting
  if (b.smtp_secure !== undefined) setSetting('smtp_secure', b.smtp_secure ? '1' : '0');
  if (b.smtp_pass) setSetting('smtp_pass', String(b.smtp_pass));
  if (b.zt_api_token) setSetting('zt_api_token', String(b.zt_api_token).trim());
  if (b.bill_company !== undefined) setSetting('bill_company', String(b.bill_company).trim());
  if (b.bill_prefix !== undefined) setSetting('bill_prefix', String(b.bill_prefix).trim() || 'INV-');
  if (b.bill_next !== undefined && parseInt(b.bill_next, 10) > 0) setSetting('bill_next', String(parseInt(b.bill_next, 10)));
  if (b.quote_prefix !== undefined) setSetting('quote_prefix', String(b.quote_prefix).trim() || 'QUO-');
  if (b.quote_next !== undefined && parseInt(b.quote_next, 10) > 0) setSetting('quote_next', String(parseInt(b.quote_next, 10)));
  if (b.stripe_secret) setSetting('stripe_secret', String(b.stripe_secret).trim());
  if (b.stripe_webhook_secret) setSetting('stripe_webhook_secret', String(b.stripe_webhook_secret).trim());
  if (b.allow_auto_enroll !== undefined) setSetting('allow_auto_enroll', b.allow_auto_enroll ? '1' : '0');
  if (b.prov_admin_password) setSetting('prov_admin_password', String(b.prov_admin_password));
  if (b.prov_wifi_password) setSetting('prov_wifi_password', String(b.prov_wifi_password));
  if (!getSetting('provision_token')) setSetting('provision_token', randomUUID().replace(/-/g, '')); // shared secret for phone-home restore
  if (!getSetting('wg_server_priv')) { const kp = wgKeypair(); setSetting('wg_server_priv', kp.privateKey); setSetting('wg_server_pub', kp.publicKey); }
  audit(req, 'edit', 'settings', 'overlay settings');
  res.json({ ok: true });
});
// Send a test email to verify SMTP config (awaits + returns the real error)
app.post('/api/settings/mail-test', requireNoc, async (req, res) => {
  const to = ((req.body || {}).to || '').trim() || getSetting('access_notify_email') || getSetting('mail_from');
  if (!getSetting('smtp_host') || !getSetting('mail_from')) return res.status(400).json({ error: 'Set the SMTP host and From address first' });
  if (!to) return res.status(400).json({ error: 'No recipient — set the notify address or enter one' });
  try {
    await sendMail({ to, subject: 'NetInv test email', text: 'This is a test email from your Network Inventory platform. SMTP is working.', html: '<p>This is a <b>test email</b> from your Network Inventory platform. SMTP is working.</p>' });
    audit(req, 'edit', 'settings', 'sent test email to ' + to);
    res.json({ ok: true, to });
  } catch (e) { res.status(502).json({ error: e.message }); }
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

// Poll a MikroTik RouterOS device over the overlay — reusable core (throws on error; updates DB)
async function pollDeviceCore(d) {
  if (!d.mgmt_address) throw Object.assign(new Error('No management IP — assign/provision the overlay first'), { http: 400 });
  if (!d.admin_password) throw Object.assign(new Error('Add an admin password (and username) for this device first'), { http: 400 });
  const H = rosHeaders(d);
  {
    const r = await restReq(d.mgmt_address, '/rest/interface', { headers: H });
    if (r.status >= 400) throw Object.assign(new Error(`Device returned ${r.status}${r.status === 401 ? ' (login rejected — check admin user/pass)' : ''}`), { http: 502 });
    let data;
    try { data = JSON.parse(r.body); } catch { throw Object.assign(new Error('Unexpected response from device (is REST enabled?)'), { http: 502 }); }
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
    let serialVal = null, fwCur = null, fwUpg = null, rosVer = null;
    try {
      const rb = await restReq(d.mgmt_address, '/rest/system/routerboard', { headers: H, timeoutMs: 7000 });
      if (rb.status < 400) { const j = JSON.parse(rb.body); const o = Array.isArray(j) ? j[0] : j; serialVal = (o && (o['serial-number'] || o['serial'])) || null; fwCur = (o && o['current-firmware']) || null; fwUpg = (o && o['upgrade-firmware']) || null; }
    } catch {}
    try {
      const rr = await restReq(d.mgmt_address, '/rest/system/resource', { headers: H, timeoutMs: 7000 });
      if (rr.status < 400) { const j = JSON.parse(rr.body); const o = Array.isArray(j) ? j[0] : j; rosVer = (o && o.version) || null; }
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
    if (rosVer) { sets.push('ros_version=?'); vals.push(rosVer); }
    if (fwCur) { sets.push('fw_version=?'); vals.push(fwCur); }
    if (fwUpg) { sets.push('fw_upgrade=?'); vals.push(fwUpg); }
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
    return { count: ifaces.length, interfaces: ifaces, polled_at: polled, public_ip: publicIp, set_public: setPublic, set_mgmt: setMgmt, target, harvested, wifi: wifiSummary ? wifiSummary.radios.length : 0, ros_version: rosVer, fw_version: fwCur, fw_upgrade: fwUpg };
  }
}
app.post('/api/devices/:id/poll', requireNoc, async (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  try { const out = await pollDeviceCore(d); audit(req, 'poll', 'device#' + d.id, `RouterOS poll: ${out.count} interfaces${out.public_ip ? ', public ' + out.public_ip : ''}`); res.json(out); }
  catch (e) { res.status(e.http === 400 ? 400 : 502).json({ error: e.http ? e.message : rosErr(e) }); }
});
// Poll every reachable platform router (refresh versions/info) — limited concurrency
app.post('/api/devices/poll-all', requireNoc, async (req, res) => {
  const devs = db.prepare("SELECT * FROM devices WHERE management_mode='platform' AND mgmt_address IS NOT NULL AND mgmt_address<>'' AND admin_password IS NOT NULL AND admin_password<>''").all();
  let ok = 0, fail = 0, idx = 0;
  const worker = async () => { while (idx < devs.length) { const d = devs[idx++]; try { await pollDeviceCore(d); ok++; } catch { fail++; } } };
  await Promise.all(Array.from({ length: Math.min(5, devs.length) }, worker));
  audit(req, 'poll', 'devices', `poll-all: ${ok} ok, ${fail} fail of ${devs.length}`);
  res.json({ total: devs.length, ok, fail });
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
const pendingUploads = new Map(); // token -> { resolve }  (legacy upload receiver; FTP pull is primary)
// Minimal FTP client (PASV + RETR) over node:net — RouterOS won't return file contents over REST,
// and only [s]ftp support fetch-upload, so we pull the exported .rsc directly from the router.
function ftpRetrieve(host, user, pass, filename, { port = 21, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ctrl = net.connect({ host, port });
    ctrl.setTimeout(timeoutMs);
    let buf = '', stage = 0, dataChunks = [], dataEnded = false, retrOk = false, finished = false;
    const fail = e => { if (finished) return; finished = true; try { ctrl.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    const done = t => { if (finished) return; finished = true; try { ctrl.write('QUIT\r\n'); ctrl.end(); } catch {} resolve(t); };
    const send = c => ctrl.write(c + '\r\n');
    const maybeFinish = () => { if (retrOk && dataEnded) done(Buffer.concat(dataChunks).toString('utf8')); };
    ctrl.on('timeout', () => fail(new Error('FTP timeout')));
    ctrl.on('error', fail);
    ctrl.on('data', chunk => {
      buf += chunk.toString('binary'); let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); handle(line); }
    });
    function handle(line) {
      if (line[3] === '-') return; // multiline continuation
      const code = parseInt(line.slice(0, 3), 10);
      if (stage === 0) { if (code === 220) { send('USER ' + user); stage = 1; } else fail(new Error('FTP greeting: ' + line)); }
      else if (stage === 1) { if (code === 230) { send('TYPE I'); stage = 3; } else if (code === 331) { send('PASS ' + pass); stage = 2; } else fail(new Error('FTP user: ' + line)); }
      else if (stage === 2) { if (code === 230) { send('TYPE I'); stage = 3; } else fail(new Error('FTP login failed (check admin user/pass + IP>Services>ftp): ' + line)); }
      else if (stage === 3) { if (code === 200) { send('PASV'); stage = 4; } else fail(new Error('FTP type: ' + line)); }
      else if (stage === 4) { if (code === 227) openData(line); else fail(new Error('FTP pasv: ' + line)); }
      else if (stage === 5) { if (code === 150 || code === 125) {} else if (code === 226 || code === 250) { retrOk = true; maybeFinish(); } else if (code >= 400) fail(new Error('FTP retr: ' + line)); }
    }
    function openData(line) {
      const m = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
      if (!m) return fail(new Error('FTP pasv parse: ' + line));
      const dport = (+m[5]) * 256 + (+m[6]);
      const dsock = net.connect({ host, port: dport }); // use control host (overlay-reachable), not advertised PASV IP
      dsock.setTimeout(timeoutMs);
      dsock.on('data', c => dataChunks.push(c));
      dsock.on('end', () => { dataEnded = true; maybeFinish(); });
      dsock.on('error', fail);
      dsock.on('timeout', () => fail(new Error('FTP data timeout')));
      stage = 5; send('RETR ' + filename);
    }
  });
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
      // B2: if REST won't hand back contents, pull the .rsc from the router via FTP over the overlay
      if (!text || !text.trim()) {
        try { text = await ftpRetrieve(d.mgmt_address, d.admin_username || 'admin', d.admin_password, f.name); }
        catch (e) { if (f['.id']) { try { await ros('DELETE', '/rest/file/' + f['.id']); } catch {} } throw new Error('REST gave no config and FTP pull failed: ' + e.message); }
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
      // FTP pull attempt (the actual backup retrieval path) — report success length or error
      try { const t = await ftpRetrieve(d.mgmt_address, d.admin_username || 'admin', d.admin_password, f.name, { timeoutMs: 15000 }); out.steps.push({ label: 'FTP RETR ' + f.name, ok: true, bytes: Buffer.byteLength(t), snippet: t.slice(0, 120) }); }
      catch (e) { out.steps.push({ label: 'FTP RETR ' + f.name, error: e.message }); }
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

// ---- zero-touch provisioning: default config + phone-home restore ----
app.post('/api/settings/provision/regenerate', requireNoc, (req, res) => {
  setSetting('provision_token', randomUUID().replace(/-/g, ''));
  audit(req, 'edit', 'settings', 'regenerated provision token');
  res.json({ ok: true });
});
// Phone-home restore: a freshly-reset router fetches its saved config by serial (token-gated, no session)
app.get('/provision/:serial', (req, res) => {
  const token = getSetting('provision_token');
  if (!token || req.query.token !== token) return res.status(403).type('text/plain').send('# forbidden');
  const serial = String(req.params.serial || '').replace(/\.rsc$/i, '').trim();
  const dev = db.prepare('SELECT id, name FROM devices WHERE serial=? COLLATE NOCASE').get(serial);
  if (!dev) { try { audit({ user: { email: 'router:' + serial } }, 'provision_miss', 'serial#' + serial, 'no device'); } catch {} return res.status(404).type('text/plain').send('# no device for serial ' + serial); }
  const bak = db.prepare("SELECT * FROM router_backups WHERE device_id=? AND status='ok' AND stored_name IS NOT NULL ORDER BY datetime(created_at) DESC LIMIT 1").get(dev.id);
  if (!bak) return res.status(404).type('text/plain').send('# no backup on file for ' + dev.name);
  const fp = join(BACKUPS_DIR, bak.stored_name);
  if (!existsSync(fp)) return res.status(404).type('text/plain').send('# backup file missing');
  try { audit({ user: { email: 'router:' + serial } }, 'provision_restore', 'device#' + dev.id, 'served backup#' + bak.id); } catch {}
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', statSync(fp).size);
  createReadStream(fp).pipe(res);
});
// Build the Netinstall default-config .rsc for a device (NOC)
function renderDefaultConfig(d) {
  const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
  const token = getSetting('provision_token') || '';
  const q = s => String(s == null ? '' : s).replace(/"/g, '');
  const L = [];
  L.push('# ============================================================');
  L.push('# NetInv default configuration for ' + q(d.name));
  L.push('# Load this as the DEFAULT CONFIG via Netinstall so it survives the reset button.');
  L.push('# On boot it phones home by serial number and restores the latest saved backup.');
  L.push('# Generated ' + new Date().toISOString());
  L.push('# ============================================================');
  L.push('/system identity set name="' + q(d.name) + '"');
  L.push('');
  L.push('# --- WAN + LAN + NAT (minimal connectivity so the unit can phone home; full config arrives via restore) ---');
  L.push('/ip dhcp-client add interface=ether1 disabled=no comment="WAN"');
  L.push('/interface bridge add name=bridge-lan');
  L.push(':foreach i in=[/interface ethernet find where name!="ether1"] do={ /interface bridge port add bridge=bridge-lan interface=$i }');
  L.push('/ip address add address=192.168.88.1/24 interface=bridge-lan');
  L.push('/ip pool add name=lan-pool ranges=192.168.88.10-192.168.88.254');
  L.push('/ip dhcp-server add name=lan-dhcp interface=bridge-lan address-pool=lan-pool disabled=no');
  L.push('/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=1.1.1.1,8.8.8.8');
  L.push('/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 comment="netinv default NAT"');
  L.push('');
  L.push('# --- WiFi (wifiwave2 — applies to all radios; e.g. hAP ax2) ---');
  if (d.factory_wifi_ssid && d.factory_wifi_password) {
    L.push(':do {');
    L.push('  :foreach w in=[/interface/wifi find] do={');
    L.push('    /interface/wifi set $w disabled=no configuration.mode=ap configuration.ssid="' + q(d.factory_wifi_ssid) + '" security.authentication-types=wpa2-psk,wpa3-psk security.passphrase="' + q(d.factory_wifi_password) + '"');
    L.push('    /interface/bridge/port add bridge=bridge-lan interface=$w');
    L.push('  }');
    L.push('} on-error={}');
  } else {
    L.push('# (set the device\'s Factory WiFi SSID + password to include WiFi here)');
  }
  L.push('');
  L.push('# --- users ---');
  if (d.admin_password) L.push('/user set [find name=admin] password="' + q(d.admin_password) + '"');
  if (d.admin_username && d.admin_username !== 'admin' && d.admin_password) L.push('/user add name="' + q(d.admin_username) + '" password="' + q(d.admin_password) + '" group=full');
  if (d.tech_username && d.tech_password) L.push('/user add name="' + q(d.tech_username) + '" password="' + q(d.tech_password) + '" group=read');
  L.push('');
  L.push('# --- firewall baseline + netinv blocklist ---');
  L.push('/ip firewall filter add chain=input action=accept connection-state=established,related comment="netinv base"');
  L.push('/ip firewall filter add chain=input action=drop connection-state=invalid');
  L.push('/ip firewall filter add chain=input action=drop src-address-list=netinv-blocklist comment="netinv auto-block"');
  L.push('/ip firewall filter add chain=input action=accept protocol=icmp');
  L.push('/ip firewall filter add chain=input action=accept in-interface=bridge-lan comment="allow LAN"');
  if (d.mgmt_overlay === 'WireGuard') L.push('/ip firewall filter add chain=input action=accept in-interface=wg-mgmt comment="allow mgmt overlay"');
  L.push('/ip firewall filter add chain=input action=drop in-interface=ether1 comment="drop other WAN input"');
  L.push('');
  // WireGuard management overlay (only if provisioned) — optional; AX2 manages over WAN/HTTPS instead
  if (d.mgmt_overlay === 'WireGuard' && d.wg_private_key && d.mgmt_address) {
    const hubPub = getSetting('wg_server_pub') || '';
    const ep = getSetting('wg_endpoint') || '';
    const epHost = ep.split(':')[0] || '';
    const epPort = ep.split(':')[1] || '51820';
    L.push('# --- WireGuard management overlay ---');
    L.push('/interface wireguard add name=wg-mgmt private-key="' + q(d.wg_private_key) + '"');
    if (hubPub && epHost) L.push('/interface wireguard peers add interface=wg-mgmt public-key="' + q(hubPub) + '" endpoint-address=' + q(epHost) + ' endpoint-port=' + q(epPort) + ' allowed-address=0.0.0.0/0 persistent-keepalive=25s');
    L.push('/ip address add address=' + q(d.mgmt_address) + '/32 interface=wg-mgmt');
    L.push('');
  }
  // Phone-home: install assigned packages, then restore latest backup — by serial, over WAN/HTTPS (no overlay needed)
  const pkgs = db.prepare('SELECT p.* FROM device_packages dp JOIN packages p ON p.id=dp.package_id WHERE dp.device_id=? ORDER BY p.name').all(d.id);
  if (pub && token) {
    L.push('# --- phone-home: packages + config restore (by serial number, survives resets) ---');
    L.push('/system script add name=netinv-init owner=admin dont-require-permissions=no source={');
    L.push('    :local n 0');
    L.push('    :while ($n < 30 && [:len [/ip route find where dst-address="0.0.0.0/0" active=yes]] = 0) do={ :delay 2s; :set n ($n + 1) }');
    L.push('    :local serial [/system routerboard get serial-number]');
    if (pkgs.length) {
      L.push('    # install assigned packages not already present, then reboot to apply');
      L.push('    :local need false');
      for (const p of pkgs) {
        const pname = q(p.name || (p.filename || '').replace(/\.npk$/i, '').split('-')[0]);
        const fn = q(p.filename || (pname + '.npk'));
        const purl = pub + '/provision/pkg/' + p.id + '?token=' + token;
        L.push('    :if ([:len [/system package find where name="' + pname + '"]] = 0) do={ :do { /tool fetch url="' + purl + '" mode=https dst-path="' + fn + '"; :set need true } on-error={} }');
      }
      L.push('    :if ($need) do={ :delay 2s; /system reboot }');
    }
    L.push('    # restore the latest saved backup for this serial (if any)');
    L.push('    :local url ("' + pub + '/provision/" . $serial . "?token=' + token + '")');
    L.push('    :do {');
    L.push('        /tool fetch url=$url mode=https dst-path=netinv-restore.rsc');
    L.push('        :delay 3s');
    L.push('        :if ([:len [/file find where name="netinv-restore.rsc"]] > 0) do={');
    L.push('            :if ([/file get [find name="netinv-restore.rsc"] size] > 40) do={');
    L.push('                /import file-name=netinv-restore.rsc');
    L.push('                /system scheduler remove [find where name="netinv-init"]');
    L.push('            }');
    L.push('            /file remove [find where name="netinv-restore.rsc"]');
    L.push('        }');
    L.push('    } on-error={}');
    L.push('}');
    L.push('/system scheduler add name=netinv-init start-time=startup interval=0 on-event="/system script run netinv-init" comment="netinv phone-home: packages + restore"');
  } else {
    L.push('# NOTE: set Settings -> Zero-touch provisioning (public URL + token) to embed the phone-home script.');
  }
  L.push('');
  return L.join('\n');
}
app.get('/api/devices/:id/default-config', requireNoc, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (!getSetting('public_base_url') || !getSetting('provision_token')) return res.status(400).json({ error: 'Set Settings → Provisioning (public URL) and save first' });
  const text = renderDefaultConfig(d);
  audit(req, 'config_read', 'device#' + d.id, 'default-config .rsc');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${(d.name || 'router').replace(/[^a-z0-9_-]+/gi, '_')}-default.rsc"`);
  res.send(text);
});

// ---- RouterOS package library (.npk) + per-device assignment ----
app.get('/api/packages', requireNoc, (req, res) => {
  res.json(db.prepare('SELECT id, name, filename, arch, version, size, notes, created_at FROM packages ORDER BY arch, name').all());
});
app.post('/api/packages', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.data) return res.status(400).json({ error: 'filename and file data required' });
  if (!/\.npk$/i.test(b.filename)) return res.status(400).json({ error: 'file must be a RouterOS .npk package' });
  let raw = String(b.data); const c = raw.indexOf(','); if (raw.startsWith('data:') && c !== -1) raw = raw.slice(c + 1);
  let buf; try { buf = Buffer.from(raw, 'base64'); } catch { return res.status(400).json({ error: 'bad file data' }); }
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  // derive a default package name from the filename (e.g. wifiwave2-7.15-arm.npk -> wifiwave2)
  const base = b.filename.replace(/\.npk$/i, '');
  const name = b.name || base.split('-')[0];
  const stored = randomUUID() + '.npk';
  try { writeFileSync(join(PACKAGES_DIR, stored), buf); } catch { return res.status(500).json({ error: 'could not save file' }); }
  const info = db.prepare('INSERT INTO packages (name, filename, arch, version, size, stored_name, notes) VALUES (?,?,?,?,?,?,?)')
    .run(name, b.filename, N(b.arch), N(b.version), buf.length, stored, N(b.notes));
  audit(req, 'create', 'package#' + info.lastInsertRowid, b.filename);
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/packages/:id', requireNoc, (req, res) => {
  const p = db.prepare('SELECT * FROM packages WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.stored_name) { try { unlinkSync(join(PACKAGES_DIR, p.stored_name)); } catch {} }
  db.prepare('DELETE FROM device_packages WHERE package_id=?').run(p.id);
  db.prepare('DELETE FROM packages WHERE id=?').run(p.id);
  audit(req, 'delete', 'package#' + p.id, p.filename);
  res.json({ ok: true });
});
app.get('/api/devices/:id/packages', requireNoc, (req, res) => {
  const assigned = db.prepare('SELECT package_id FROM device_packages WHERE device_id=?').all(req.params.id).map(r => r.package_id);
  res.json({ assigned, available: db.prepare('SELECT id, name, filename, arch, version, size FROM packages ORDER BY arch, name').all() });
});
app.put('/api/devices/:id/packages', requireNoc, (req, res) => {
  const ids = ((req.body || {}).package_ids || []).map(Number).filter(Boolean);
  db.prepare('DELETE FROM device_packages WHERE device_id=?').run(req.params.id);
  const ins = db.prepare('INSERT OR IGNORE INTO device_packages (device_id, package_id) VALUES (?,?)');
  for (const pid of ids) ins.run(req.params.id, pid);
  audit(req, 'edit', 'device#' + req.params.id, 'packages: ' + ids.length);
  res.json({ ok: true });
});
// Serve a package to a phoning-home router (token-gated, no session)
app.get('/provision/pkg/:id', (req, res) => {
  const token = getSetting('provision_token');
  if (!token || req.query.token !== token) return res.status(403).type('text/plain').send('# forbidden');
  const p = db.prepare('SELECT * FROM packages WHERE id=?').get(req.params.id);
  if (!p || !p.stored_name) return res.status(404).type('text/plain').send('# not found');
  const fp = join(PACKAGES_DIR, p.stored_name);
  if (!existsSync(fp)) return res.status(404).type('text/plain').send('# file missing');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', statSync(fp).size);
  res.setHeader('Content-Disposition', `attachment; filename="${(p.filename || 'package.npk').replace(/"/g, '')}"`);
  createReadStream(fp).pipe(res);
});

// ---- provisioning bench nodes + auto-enroll ----
// A request is "provisioning-authorized" if it carries the global provision token or a registered node token.
function provAuth(req) {
  const t = req.query.token || (req.body && req.body.token);
  if (!t) return null;
  if (getSetting('provision_token') && t === getSetting('provision_token')) return { kind: 'global' };
  const node = db.prepare('SELECT * FROM prov_nodes WHERE token=?').get(t);
  if (node) { db.prepare("UPDATE prov_nodes SET last_seen=datetime('now') WHERE id=?").run(node.id); return { kind: 'node', node }; }
  return null;
}
app.get('/api/nodes', requireNoc, (req, res) => {
  res.json(db.prepare('SELECT id, name, location, last_seen, created_at FROM prov_nodes ORDER BY name').all());
});
app.post('/api/nodes', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name required' });
  const token = 'node_' + randomUUID().replace(/-/g, '');
  const info = db.prepare('INSERT INTO prov_nodes (name, token, location) VALUES (?,?,?)').run(b.name, token, N(b.location));
  audit(req, 'create', 'node#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid, token }); // token shown once
});
app.delete('/api/nodes/:id', requireNoc, (req, res) => {
  db.prepare('DELETE FROM prov_nodes WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'node#' + req.params.id);
  res.json({ ok: true });
});
// Pending enrollments: auto-enrolled devices a tech still needs to finish setting up
app.get('/api/enrollments', requireNoc, (req, res) => {
  res.json(db.prepare(`SELECT d.id, d.name, d.serial, d.mac, d.status, d.enrolled_at, m.manufacturer, m.model
    FROM devices d LEFT JOIN device_models m ON m.id=d.model_id
    WHERE d.enroll_pending=1 ORDER BY datetime(d.enrolled_at) DESC`).all());
});
app.post('/api/devices/:id/enroll-clear', requireNoc, (req, res) => {
  db.prepare('UPDATE devices SET enroll_pending=0 WHERE id=?').run(req.params.id);
  audit(req, 'edit', 'device#' + req.params.id, 'cleared pending enrollment');
  res.json({ ok: true });
});
// Auto-enroll: a freshly netinstalled router (or a node) registers a device by serial. GET or POST, token-gated.
app.all('/enroll', express.urlencoded({ extended: false }), (req, res) => {
  if (!provAuth(req)) return res.status(403).type('text/plain').send('# forbidden');
  const g = k => String((req.query[k] != null ? req.query[k] : (req.body && req.body[k]) || '')).trim();
  const serial = g('serial');
  if (!serial) return res.status(400).type('text/plain').send('# serial required');
  const model = g('model'), mac = g('mac'), identity = g('identity');
  const existing = db.prepare('SELECT id FROM devices WHERE serial=? COLLATE NOCASE').get(serial);
  if (existing) {
    if (mac) db.prepare('UPDATE devices SET mac=COALESCE(NULLIF(mac,?),?) WHERE id=?').run('', mac, existing.id);
    return res.type('text/plain').send('# ok existing ' + existing.id);
  }
  if (getSetting('allow_auto_enroll') !== '1') return res.status(403).type('text/plain').send('# auto-enroll disabled');
  const mid = (db.prepare('SELECT id FROM device_models WHERE model=? COLLATE NOCASE OR (manufacturer||\' \'||model)=? COLLATE NOCASE').get(model, model) || {}).id || null;
  const name = identity || model || ('Router ' + serial);
  const info = db.prepare("INSERT INTO devices (name, model_id, serial, mac, status, management_mode, online, enroll_pending, enrolled_at) VALUES (?,?,?,?,?,?,0,1,datetime('now'))")
    .run(name, mid, serial, N(mac), 'In stock', 'platform');
  db.prepare('INSERT INTO audit_log (actor, role, action, target, details) VALUES (?,?,?,?,?)').run('provision', 'system', 'enroll', 'device#' + info.lastInsertRowid, serial + ' ' + (model || ''));
  res.type('text/plain').send('# ok created ' + info.lastInsertRowid);
});
// Node-facing: list packages for an architecture (the base .npk set to netinstall)
app.get('/node/packages', (req, res) => {
  if (!provAuth(req)) return res.status(403).json({ error: 'forbidden' });
  const arch = String(req.query.arch || '').trim();
  const base = (getSetting('public_base_url') || '').replace(/\/+$/, '');
  const tok = req.query.token;
  const rows = db.prepare(arch ? 'SELECT * FROM packages WHERE arch=? COLLATE NOCASE ORDER BY name' : 'SELECT * FROM packages ORDER BY name').all(...(arch ? [arch] : []));
  res.json(rows.map(p => ({ id: p.id, filename: p.filename, name: p.name, arch: p.arch, size: p.size, url: base + '/provision/pkg/' + p.id + '?token=' + tok })));
});
// Node-facing: generic default config to apply during netinstall (no specific device; unit self-enrolls by serial on boot)
app.get('/node/default-config', (req, res) => {
  if (!provAuth(req)) return res.status(403).type('text/plain').send('# forbidden');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(renderGenericConfig());
});
function renderGenericConfig() {
  const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
  const token = getSetting('provision_token') || '';
  const q = s => String(s == null ? '' : s).replace(/"/g, '');
  const adminPw = getSetting('prov_admin_password') || '';
  const ssid = getSetting('prov_wifi_ssid') || '';
  const wpw = getSetting('prov_wifi_password') || '';
  const L = [];
  L.push('# NetInv generic provisioning config (applied during Netinstall; unit self-enrolls by serial on boot)');
  L.push('# Generated ' + new Date().toISOString());
  L.push('/ip dhcp-client add interface=ether1 disabled=no comment="WAN"');
  L.push('/interface bridge add name=bridge-lan');
  L.push(':foreach i in=[/interface ethernet find where name!="ether1"] do={ /interface bridge port add bridge=bridge-lan interface=$i }');
  L.push('/ip address add address=192.168.88.1/24 interface=bridge-lan');
  L.push('/ip pool add name=lan-pool ranges=192.168.88.10-192.168.88.254');
  L.push('/ip dhcp-server add name=lan-dhcp interface=bridge-lan address-pool=lan-pool disabled=no');
  L.push('/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=1.1.1.1,8.8.8.8');
  L.push('/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 comment="netinv default NAT"');
  if (ssid && wpw) {
    L.push(':do { :foreach w in=[/interface/wifi find] do={ /interface/wifi set $w disabled=no configuration.mode=ap configuration.ssid="' + q(ssid) + '" security.authentication-types=wpa2-psk,wpa3-psk security.passphrase="' + q(wpw) + '"; /interface/bridge/port add bridge=bridge-lan interface=$w } } on-error={}');
  }
  if (adminPw) L.push('/user set [find name=admin] password="' + q(adminPw) + '"');
  L.push('/ip firewall filter add chain=input action=accept connection-state=established,related');
  L.push('/ip firewall filter add chain=input action=drop connection-state=invalid');
  L.push('/ip firewall filter add chain=input action=drop src-address-list=netinv-blocklist comment="netinv auto-block"');
  L.push('/ip firewall filter add chain=input action=accept protocol=icmp');
  L.push('/ip firewall filter add chain=input action=accept in-interface=bridge-lan comment="allow LAN"');
  L.push('/ip firewall filter add chain=input action=drop in-interface=ether1 comment="drop other WAN input"');
  if (pub && token) {
    L.push('/system script add name=netinv-init owner=admin dont-require-permissions=no source={');
    L.push('    :local n 0');
    L.push('    :while ($n < 30 && [:len [/ip route find where dst-address="0.0.0.0/0" active=yes]] = 0) do={ :delay 2s; :set n ($n + 1) }');
    L.push('    :local serial [/system routerboard get serial-number]');
    L.push('    :local board [/system resource get board-name]');
    L.push('    :local mac ""');
    L.push('    :do { :set mac [/interface ethernet get [find default-name=ether1] mac-address] } on-error={}');
    L.push('    # self-enroll into inventory by serial');
    L.push('    :do { /tool fetch http-method=post mode=https keep-result=no url="' + pub + '/enroll?token=' + token + '" http-data=("serial=" . $serial . "&model=" . $board . "&mac=" . $mac) } on-error={}');
    L.push('    # then restore the latest saved backup for this serial (if any)');
    L.push('    :local url ("' + pub + '/provision/" . $serial . "?token=' + token + '")');
    L.push('    :do {');
    L.push('        /tool fetch url=$url mode=https dst-path=netinv-restore.rsc');
    L.push('        :delay 3s');
    L.push('        :if ([:len [/file find where name="netinv-restore.rsc"]] > 0) do={');
    L.push('            :if ([/file get [find name="netinv-restore.rsc"] size] > 40) do={ /import file-name=netinv-restore.rsc; /system scheduler remove [find where name="netinv-init"] }');
    L.push('            /file remove [find where name="netinv-restore.rsc"]');
    L.push('        }');
    L.push('    } on-error={}');
    L.push('}');
    L.push('/system scheduler add name=netinv-init start-time=startup interval=0 on-event="/system script run netinv-init" comment="netinv enroll + restore"');
  }
  L.push('');
  return L.join('\n');
}

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

// Accounts <-> Customers many-to-many helpers
function customerAccounts(custId) { return db.prepare('SELECT a.id, a.name FROM account_customers ac JOIN accounts a ON a.id=ac.account_id WHERE ac.customer_id=? ORDER BY a.name').all(custId); }
function accountCustomers(acctId) { return db.prepare('SELECT c.* FROM account_customers ac JOIN customers c ON c.id=ac.customer_id WHERE ac.account_id=? ORDER BY c.name').all(acctId); }
function setCustomerAccounts(custId, ids) {
  const clean = [...new Set((ids || []).map(Number).filter(Boolean))];
  db.prepare('DELETE FROM account_customers WHERE customer_id=?').run(custId);
  const ins = db.prepare('INSERT OR IGNORE INTO account_customers (account_id, customer_id) VALUES (?,?)');
  for (const a of clean) ins.run(a, custId);
  db.prepare('UPDATE customers SET account_id=? WHERE id=?').run(clean[0] || null, custId); // keep legacy primary
}
function defaultAccountForCustomer(custId) {
  const r = db.prepare('SELECT account_id FROM account_customers WHERE customer_id=? ORDER BY account_id LIMIT 1').get(custId);
  return r ? r.account_id : null;
}

app.get('/api/accounts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  a.contacts = db.prepare('SELECT * FROM account_contacts WHERE account_id=?').all(a.id);
  a.previous_isps = db.prepare('SELECT * FROM previous_isps WHERE account_id=?').all(a.id);
  a.customers = accountCustomers(a.id).map(c => ({ ...c, site_count: db.prepare('SELECT COUNT(*) AS n FROM sites WHERE customer_id=?').get(c.id).n }));
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
  // deleting an account would cascade to its sites — refuse while anything still depends on it
  const ns = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE account_id=?').get(req.params.id).n;
  const nc = db.prepare('SELECT COUNT(*) AS n FROM account_customers WHERE account_id=?').get(req.params.id).n;
  if (ns + nc > 0) return res.status(409).json({ error: `In use by ${nc} customer(s) and ${ns} site(s) — reassign or delete those first` });
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

app.post('/api/sites', (req, res) => {
  const b = req.body || {};
  // a site is served by one account chosen from its customer's accounts (defaults to the customer's primary)
  const accountId = b.account_id || defaultAccountForCustomer(b.customer_id);
  if (!accountId) return res.status(400).json({ error: 'A customer (with at least one account) is required' });
  const info = db.prepare('INSERT INTO sites (account_id,customer_id,name,service_address,lat,lng,status,current_mgmt_ip,current_public_ip,notes) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(N(accountId), N(b.customer_id || null), N(b.name), N(b.service_address), N(b.lat || null), N(b.lng || null), b.status || 'Active', N(b.current_mgmt_ip), N(b.current_public_ip), N(b.notes));
  audit(req, 'create', 'site#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/sites/:id', (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  // merge: fields not in the body keep their current values (so a customer-only change can't wipe the site)
  const customerId = b.customer_id !== undefined ? b.customer_id : ex.customer_id;
  const accountId = b.account_id || (b.customer_id !== undefined && b.customer_id !== ex.customer_id ? defaultAccountForCustomer(customerId) : null) || ex.account_id;
  db.prepare('UPDATE sites SET account_id=?, customer_id=?, name=?, service_address=?, lat=?, lng=?, status=?, current_mgmt_ip=?, current_public_ip=?, notes=? WHERE id=?')
    .run(N(accountId), N(customerId || null), N(b.name, ex.name), N(b.service_address, ex.service_address),
         b.lat === undefined ? ex.lat : (b.lat || null), b.lng === undefined ? ex.lng : (b.lng || null),
         N(b.status, ex.status), N(b.current_mgmt_ip, ex.current_mgmt_ip), N(b.current_public_ip, ex.current_public_ip), N(b.notes, ex.notes), req.params.id);
  audit(req, 'edit', 'site#' + req.params.id, b.name || ex.name);
  res.json({ ok: true });
});

// ---- customers (end clients; many-to-many with accounts) ----
const accountIdsFrom = b => { const ids = b.account_ids || (b.account_id ? [b.account_id] : []); return [...new Set(ids.map(Number).filter(Boolean))]; };
app.get('/api/customers', (req, res) => {
  const acct = req.query.account_id ? Number(req.query.account_id) : null;
  const where = acct ? ' WHERE c.id IN (SELECT customer_id FROM account_customers WHERE account_id=' + acct + ')' : '';
  const rows = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM sites s WHERE s.customer_id=c.id) AS site_count,
      (SELECT GROUP_CONCAT(a.name, ', ') FROM account_customers ac JOIN accounts a ON a.id=ac.account_id WHERE ac.customer_id=c.id) AS account_names
    FROM customers c${where} ORDER BY c.name`).all();
  res.json(rows);
});
app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.accounts = customerAccounts(c.id);
  c.account = c.accounts[0] || null; // legacy convenience
  c.sites = db.prepare('SELECT * FROM sites WHERE customer_id=?').all(c.id).map(withSiteSummary);
  c.device_count = c.sites.reduce((n, s) => n + s.device_total, 0);
  c.needs_attention = c.sites.filter(s => s.needs_attention).length;
  c.has_portal_password = !!c.portal_password; delete c.portal_password;
  res.json(c);
});
app.post('/api/customers', requireNoc, (req, res) => {
  const b = req.body || {};
  const ids = accountIdsFrom(b);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one account' });
  if (!b.name) return res.status(400).json({ error: 'Customer name required' });
  const info = db.prepare('INSERT INTO customers (account_id,name,status,notes,billing_email) VALUES (?,?,?,?,?)').run(ids[0], N(b.name), b.status || 'Active', N(b.notes), N(b.billing_email));
  setCustomerAccounts(info.lastInsertRowid, ids);
  audit(req, 'create', 'customer#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/customers/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE customers SET name=?, status=?, notes=?, billing_email=? WHERE id=?').run(N(b.name, ex.name), N(b.status, ex.status), N(b.notes), N(b.billing_email, ex.billing_email), req.params.id);
  if (b.account_ids !== undefined || b.account_id !== undefined) {
    const ids = accountIdsFrom(b);
    if (!ids.length) return res.status(400).json({ error: 'A customer must have at least one account' });
    setCustomerAccounts(req.params.id, ids);
  }
  if (b.portal_enabled !== undefined) db.prepare('UPDATE customers SET portal_enabled=? WHERE id=?').run(b.portal_enabled ? 1 : 0, req.params.id);
  if (b.portal_password) db.prepare('UPDATE customers SET portal_password=? WHERE id=?').run(hashPassword(String(b.portal_password)), req.params.id);
  audit(req, 'edit', 'customer#' + req.params.id, b.name);
  res.json({ ok: true });
});
app.delete('/api/customers/:id', requireNoc, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE customer_id=?').get(req.params.id).n;
  if (n > 0) return res.status(409).json({ error: `Has ${n} site(s)` });
  db.prepare('DELETE FROM account_customers WHERE customer_id=?').run(req.params.id);
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'customer#' + req.params.id);
  res.json({ ok: true });
});

app.delete('/api/sites/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  // hardware survives the site: back to unassigned (connections/notes/access cascade away)
  db.prepare("UPDATE devices SET assigned_type=NULL, assigned_site_id=NULL, associated_connection_id=NULL WHERE assigned_type='site' AND assigned_site_id=?").run(s.id);
  db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'site#' + req.params.id, s.name);
  res.json({ ok: true });
});

app.delete('/api/connections/:id', requireNoc, (req, res) => {
  const c = db.prepare('SELECT * FROM connections WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE devices SET associated_connection_id=NULL WHERE associated_connection_id=?').run(c.id);
  db.prepare('DELETE FROM connections WHERE id=?').run(c.id);
  audit(req, 'delete', 'connection#' + c.id, 'site#' + c.site_id);
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
const ATT_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf' };
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
// delete a note (+ its attachment files); NOC/Admin only
function deleteNoteAttachments(noteId) {
  for (const a of db.prepare('SELECT * FROM note_attachments WHERE note_id=?').all(noteId)) {
    try { unlinkSync(join(UPLOADS_DIR, a.stored_name)); } catch {}
    db.prepare('DELETE FROM note_attachments WHERE id=?').run(a.id);
  }
}
app.delete('/api/site-notes/:id', requireNoc, (req, res) => {
  const n = db.prepare('SELECT * FROM site_notes WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  deleteNoteAttachments(n.id);
  db.prepare('DELETE FROM site_notes WHERE id=?').run(n.id);
  audit(req, 'delete', 'site#' + n.site_id, 'note#' + n.id);
  res.json({ ok: true });
});
app.delete('/api/pop-notes/:id', requireNoc, (req, res) => {
  const n = db.prepare('SELECT * FROM pop_notes WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  deleteNoteAttachments(n.id);
  db.prepare('DELETE FROM pop_notes WHERE id=?').run(n.id);
  audit(req, 'delete', 'pop#' + n.pop_id, 'note#' + n.id);
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

// ---- batch config changes (fleet-wide, NOC/Admin) ----
async function applyBatchOp(d, op, params) {
  const H = rosHeaders(d);
  const ros = (m, p, b) => restReq(d.mgmt_address, p, { headers: H, method: m, body: b, timeoutMs: 15000 });
  if (op === 'add-user') {
    const r = await ros('PUT', '/rest/user', { name: params.name, password: params.password, group: params.group || 'full' });
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
    return 'added user ' + params.name + ' (' + (params.group || 'full') + ')';
  }
  if (op === 'change-password') {
    const g = await ros('GET', '/rest/user?name=' + encodeURIComponent(params.name));
    let users = []; try { users = JSON.parse(g.body); } catch {}
    const u = (Array.isArray(users) ? users : []).find(x => x.name === params.name);
    if (!u) throw new Error('user "' + params.name + '" not found on device');
    const r = await ros('PATCH', '/rest/user/' + u['.id'], { password: params.password });
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
    return 'password changed for ' + params.name;
  }
  if (op === 'remove-user') {
    if (params.name === (d.admin_username || 'admin')) throw new Error('refusing to remove the platform admin user "' + params.name + '"');
    const g = await ros('GET', '/rest/user?name=' + encodeURIComponent(params.name));
    let users = []; try { users = JSON.parse(g.body); } catch {}
    const u = (Array.isArray(users) ? users : []).find(x => x.name === params.name);
    if (!u) return 'user "' + params.name + '" not present (nothing to do)';
    const r = await ros('DELETE', '/rest/user/' + u['.id']);
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
    return 'removed user ' + params.name;
  }
  if (op === 'set-wifi') {
    const wf = await readWifi(d);
    if (!wf.system || !wf.radios.length) throw new Error('no WiFi on this device');
    let n = 0;
    for (const radio of wf.radios) { await writeWifi(d, { system: wf.system, id: radio.id, profile: radio.profile, profileId: radio.profileId, ssid: params.ssid, password: params.password }); n++; }
    return 'updated ' + n + ' radio(s)' + (params.ssid ? ' · ssid=' + params.ssid : '') + (params.password ? ' · password set' : '');
  }
  if (op === 'update-packages') {
    if (params.channel) await ros('PATCH', '/rest/system/package/update', { channel: params.channel });
    await ros('POST', '/rest/system/package/update/check-for-updates', {});
    let inst = '', latest = '', status = '';
    const g = await ros('GET', '/rest/system/package/update');
    if (g.status < 400) { try { const o = JSON.parse(g.body); const u = Array.isArray(o) ? o[0] : o; inst = u['installed-version'] || ''; latest = u['latest-version'] || ''; status = u.status || ''; } catch {} }
    if (latest && inst && latest !== inst) {
      try {
        const r = await ros('POST', '/rest/system/package/update/install', {});
        if (r.status >= 400) throw new Error('install HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
      } catch (e) {
        if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(e.code) || e.message === 'timeout') return 'upgrade ' + inst + ' → ' + latest + ' initiated (device rebooting)';
        throw e;
      }
      return 'upgrading ' + inst + ' → ' + latest + ' (downloading + rebooting)';
    }
    return 'already up to date' + (inst ? ' (' + inst + ')' : '') + (status ? ' · ' + status : '');
  }
  if (op === 'update-firmware') {
    const r = await ros('POST', '/rest/system/routerboard/upgrade', {});
    if (r.status >= 400) throw new Error('routerboard upgrade HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
    let rebooted = false;
    try { const rb = await ros('POST', '/rest/system/reboot', {}); rebooted = rb.status < 400; } catch {}
    return 'RouterBOOT firmware upgrade staged' + (rebooted ? ' · rebooting to apply' : ' · reboot to apply');
  }
  if (op === 'add-firewall') {
    const body = { chain: params.chain, action: params.action };
    if (params.protocol && params.protocol !== 'any') body.protocol = params.protocol;
    if (params.dst_port) body['dst-port'] = String(params.dst_port);
    if (params.src_address) body['src-address'] = params.src_address;
    if (params.dst_address) body['dst-address'] = params.dst_address;
    if (params.in_interface) body['in-interface'] = params.in_interface;
    body.comment = params.comment || 'netinv batch';
    const r = await ros('PUT', '/rest/ip/firewall/filter', body);
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
    return body.chain + '/' + body.action + ' rule added';
  }
  throw new Error('unknown op');
}
async function runBatch(op, params, deviceIds, actor) {
  const devs = deviceIds.map(id => db.prepare('SELECT * FROM devices WHERE id=?').get(id)).filter(Boolean);
  const results = [];
  let idx = 0;
  const worker = async () => {
    while (idx < devs.length) {
      const d = devs[idx++];
      let status = 'ok', detail = '';
      if (d.management_mode !== 'platform') { status = 'error'; detail = 'provider-managed device (skipped)'; }
      else if (!d.mgmt_address || !d.admin_password) { status = 'error'; detail = 'no management IP / admin password on file'; }
      else { try { detail = await applyBatchOp(d, op, params); } catch (e) { status = 'error'; detail = e.message; } }
      results.push({ device_id: d.id, device_name: d.name, status, detail });
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, devs.length) }, worker)); // limited concurrency
  results.sort((a, b) => String(a.device_name).localeCompare(String(b.device_name)));
  const ok = results.filter(r => r.status === 'ok').length, fail = results.length - ok;
  const summary = ({
    'add-user': 'Add user ' + params.name,
    'change-password': 'Change password ' + params.name,
    'remove-user': 'Remove user ' + params.name,
    'set-wifi': 'Set WiFi' + (params.ssid ? ' "' + params.ssid + '"' : ' password'),
    'add-firewall': 'Add firewall ' + params.chain + '/' + params.action,
    'update-packages': 'Update packages' + (params.channel ? ' (' + params.channel + ')' : ''),
    'update-firmware': 'Update RouterBOOT firmware'
  })[op] || op;
  const jid = db.prepare("INSERT INTO batch_jobs (op,summary,actor,total,ok,fail) VALUES (?,?,?,?,?,?)").run(op, summary, actor, results.length, ok, fail).lastInsertRowid;
  const ins = db.prepare("INSERT INTO batch_results (job_id,device_id,device_name,status,detail) VALUES (?,?,?,?,?)");
  for (const r of results) ins.run(jid, r.device_id, r.device_name, r.status, r.detail);
  return { id: jid, op, summary, total: results.length, ok, fail, results };
}
app.get('/api/batch/targets', requireNoc, (req, res) => {
  const rows = db.prepare("SELECT id, name, mgmt_address, management_mode, assigned_type, assigned_site_id, assigned_pop_id, ros_version, fw_version, fw_upgrade, last_polled, (admin_password IS NOT NULL AND admin_password<>'') AS has_pw FROM devices WHERE management_mode='platform' ORDER BY name").all();
  for (const r of rows) {
    r.eligible = !!(r.mgmt_address && r.has_pw);
    r.fw_needs_update = !!(r.fw_version && r.fw_upgrade && r.fw_version !== r.fw_upgrade);
    r.reason = r.eligible ? '' : (!r.mgmt_address ? 'no mgmt IP' : 'no admin password');
    if (r.assigned_type === 'site' && r.assigned_site_id) r.group = (db.prepare('SELECT name FROM sites WHERE id=?').get(r.assigned_site_id) || {}).name || 'Site';
    else if (r.assigned_type === 'pop' && r.assigned_pop_id) r.group = 'POP · ' + ((db.prepare('SELECT name FROM pops WHERE id=?').get(r.assigned_pop_id) || {}).name || '');
    else r.group = 'Unassigned';
    delete r.has_pw;
  }
  res.json(rows);
});
app.get('/api/batch', requireNoc, (req, res) => {
  res.json(db.prepare('SELECT id, op, summary, actor, total, ok, fail, created_at FROM batch_jobs ORDER BY id DESC LIMIT 100').all());
});
app.get('/api/batch/:id', requireNoc, (req, res) => {
  const job = db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  job.results = db.prepare('SELECT device_id, device_name, status, detail FROM batch_results WHERE job_id=? ORDER BY status, device_name').all(job.id);
  res.json(job);
});
app.post('/api/batch', requireNoc, async (req, res) => {
  const b = req.body || {};
  const OPS = ['add-user', 'change-password', 'remove-user', 'set-wifi', 'add-firewall', 'update-packages', 'update-firmware'];
  if (!OPS.includes(b.op)) return res.status(400).json({ error: 'unknown operation' });
  const ids = (b.device_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one device' });
  const p = b.params || {};
  let err = '';
  if (b.op === 'add-user' || b.op === 'change-password') { if (!p.name || !p.password) err = 'Username and password are required'; }
  else if (b.op === 'remove-user') { if (!p.name) err = 'Username is required'; }
  else if (b.op === 'set-wifi') { if (!p.ssid && !p.password) err = 'Enter a new SSID and/or password'; }
  else if (b.op === 'add-firewall') { if (!p.chain || !p.action) err = 'Chain and action are required'; }
  // update-packages / update-firmware need no params
  if (err) return res.status(400).json({ error: err });
  try {
    const out = await runBatch(b.op, p, ids, (req.user && req.user.email) || '');
    const tag = p.name || p.ssid || (p.chain + '/' + p.action) || '';
    audit(req, 'config_push', 'batch#' + out.id, `${b.op} ${tag} — ${out.ok}/${out.total} ok`); // never log secrets
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  // finishing setup (assigning to a site/POP) clears the pending-enrollment flag
  if (b.assigned_site_id || b.assigned_pop_id) db.prepare('UPDATE devices SET enroll_pending=0 WHERE id=?').run(req.params.id);
  audit(req, 'edit', 'device#' + req.params.id, b.name || existing.name);
  res.json({ ok: true });
});

app.delete('/api/devices/:id', (req, res) => {
  db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'device#' + req.params.id);
  res.json({ ok: true });
});


// ---- billing: standalone invoicing (Stripe processes card/ACH; card data never touches this server) ----
const r2 = v => Math.round(Number(v || 0) * 100) / 100;
const todayStr = () => new Date().toISOString().slice(0, 10);
const esc2 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function computeTotals(items, taxRate) {
  const line = it => Number(it.quantity || 1) * Number(it.unit_price || 0);
  const subtotal = r2(items.reduce((n, it) => n + line(it), 0));
  const taxableBase = r2(items.filter(it => it.taxable !== 0 && it.taxable !== false).reduce((n, it) => n + line(it), 0));
  const tax = r2(taxableBase * (Number(taxRate || 0) / 100));
  return { subtotal, tax, total: r2(subtotal + tax) };
}
function nextInvoiceNumber() {
  const prefix = getSetting('bill_prefix') || 'INV-';
  const seq = parseInt(getSetting('bill_next'), 10) || 1001;
  setSetting('bill_next', String(seq + 1));
  return prefix + seq;
}
function cleanItems(raw) {
  return (Array.isArray(raw) ? raw : []).map(it => ({
    description: String(it.description || '').slice(0, 400),
    quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
    unit_price: r2(it.unit_price),
    taxable: (it.taxable === 0 || it.taxable === false) ? 0 : 1
  })).filter(it => it.description || it.unit_price);
}
function insertInvoice({ customer_id, email, date, due_date, tax_rate, notes, items, status, terms }) {
  const t = computeTotals(items, tax_rate);
  const info = db.prepare(`INSERT INTO bill_invoices (number,customer_id,email,date,due_date,status,tax_rate,subtotal,tax,total,balance,notes,terms,pay_token)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextInvoiceNumber(), customer_id, N(email), date || todayStr(), N(due_date), status || 'draft',
         Number(tax_rate || 0), t.subtotal, t.tax, t.total, t.total, N(notes), N(terms), randomBytes(18).toString('hex'));
  const ins = db.prepare('INSERT INTO bill_items (invoice_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
  for (const it of items) ins.run(info.lastInsertRowid, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
  return info.lastInsertRowid;
}
function loadInvoice(id) {
  const inv = db.prepare(`SELECT i.*, c.name AS customer_name, c.billing_email FROM bill_invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=?`).get(id);
  if (!inv) return null;
  inv.items = db.prepare('SELECT * FROM bill_items WHERE invoice_id=? ORDER BY id').all(id);
  inv.payments = db.prepare('SELECT * FROM bill_payments WHERE invoice_id=? ORDER BY date, id').all(id);
  const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
  inv.pay_url = pub && inv.pay_token ? `${pub}/pay/${inv.pay_token}` : null;
  return inv;
}
// Record a payment and roll the invoice status forward. Idempotent per Stripe payment-intent.
function applyPayment(invId, { amount, method, reference, stripe_pi, date, notes }) {
  const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(invId);
  if (!inv) throw Object.assign(new Error('invoice not found'), { http: 404 });
  if (stripe_pi && db.prepare('SELECT id FROM bill_payments WHERE stripe_pi=?').get(stripe_pi)) return { duplicate: true };
  const amt = r2(amount);
  if (!(amt > 0)) throw Object.assign(new Error('amount must be > 0'), { http: 400 });
  db.prepare('INSERT INTO bill_payments (invoice_id,date,amount,method,reference,stripe_pi,notes) VALUES (?,?,?,?,?,?,?)')
    .run(invId, date || todayStr(), amt, method || 'other', N(reference), N(stripe_pi), N(notes));
  const balance = r2(Math.max(0, inv.balance - amt));
  const status = balance <= 0 ? 'paid' : 'partial';
  db.prepare('UPDATE bill_invoices SET balance=?, status=? WHERE id=?').run(balance, status, invId);
  return { balance, status };
}
// Email an invoice (uses the SMTP settings) with the public pay link when available
function emailInvoice(inv) {
  const to = inv.email || inv.billing_email;
  if (!to) return false;
  const company = getSetting('bill_company') || 'Network Inventory';
  const lines = inv.items.map(it => ` - ${it.description}  x${it.quantity}  $${it.amount.toFixed(2)}`).join('\n');
  const rows = inv.items.map(it => `<tr><td style="padding:4px 12px 4px 0">${esc2(it.description)}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
  const payBit = inv.pay_url ? `\n\nPay online (card or bank/ACH): ${inv.pay_url}` : '';
  const payBtn = inv.pay_url ? `<p style="margin:18px 0"><a href="${inv.pay_url}" style="background:#378ADD;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none">Pay invoice online</a><br><span style="color:#777;font-size:12px">Card or bank transfer (ACH), processed securely by Stripe.</span></p>` : '';
  mailSafe({
    to, subject: `Invoice ${inv.number} from ${company} — $${inv.total.toFixed(2)}${inv.due_date ? ' due ' + inv.due_date : ''}`,
    text: `Invoice ${inv.number} from ${company}\nDate: ${inv.date}${inv.due_date ? '\nDue: ' + inv.due_date : ''}\n\n${lines}\n\nTotal: $${inv.total.toFixed(2)}\nBalance due: $${inv.balance.toFixed(2)}${payBit}${inv.notes ? '\n\n' + inv.notes : ''}`,
    html: `<h2>Invoice ${esc2(inv.number)}</h2><p>${esc2(company)} · ${esc2(inv.date)}${inv.due_date ? ' · due <b>' + esc2(inv.due_date) + '</b>' : ''}</p>
      <table style="border-collapse:collapse">${rows}<tr><td style="padding:8px 12px 0 0"><b>Total</b></td><td></td><td align="right"><b>$${inv.total.toFixed(2)}</b></td></tr></table>
      ${payBtn}${inv.notes ? `<p style="color:#555">${esc2(inv.notes)}</p>` : ''}`
  });
  return true;
}
// ---- Stripe (REST via fetch; no SDK) ----
async function stripeReq(method, path, params) {
  const key = getSetting('stripe_secret');
  if (!key) throw Object.assign(new Error('Set the Stripe secret key in Settings first'), { http: 400 });
  const r = await fetch('https://api.stripe.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params).toString() : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Stripe: ' + ((j.error && j.error.message) || ('HTTP ' + r.status))), { http: 502 });
  return j;
}
function verifyStripeSig(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  let t = null; const v1s = [];
  for (const part of String(sigHeader).split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v; else if (k === 'v1') v1s.push(v);
  }
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min replay tolerance
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1s.some(v => { try { return v.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch { return false; } });
}
function stripeWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  if (!verifyStripeSig(raw, req.headers['stripe-signature'], getSetting('stripe_webhook_secret'))) return res.status(400).json({ error: 'bad signature' });
  let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad payload' }); }
  try {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) {
      const s = ev.data.object;
      const invId = Number(s.metadata && s.metadata.invoice_id);
      // cards are paid at completion; ACH completes now and settles later via async_payment_succeeded
      if (invId && s.payment_status === 'paid') {
        const out = applyPayment(invId, { amount: (s.amount_total || 0) / 100, method: 'stripe', reference: s.payment_intent, stripe_pi: s.payment_intent });
        if (!out.duplicate) db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)')
          .run('stripe', 'system', 'payment', 'invoice#' + invId, `$${((s.amount_total || 0) / 100).toFixed(2)} via Stripe (${ev.type})`);
      }
    } else if (ev.type === 'checkout.session.async_payment_failed') {
      const s = ev.data.object;
      const invId = Number(s.metadata && s.metadata.invoice_id);
      if (invId) db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)')
        .run('stripe', 'system', 'payment_failed', 'invoice#' + invId, 'ACH payment failed');
    }
    res.json({ received: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
// ---- billing API (NOC/Admin) ----
app.get('/api/billing/summary', requireNoc, (req, res) => {
  const today = todayStr();
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  res.json({
    stripe: !!getSetting('stripe_secret'),
    outstanding: db.prepare("SELECT COALESCE(SUM(balance),0) v FROM bill_invoices WHERE status IN ('sent','partial')").get().v,
    overdue: db.prepare("SELECT COALESCE(SUM(balance),0) v FROM bill_invoices WHERE status IN ('sent','partial') AND due_date IS NOT NULL AND due_date<?").get(today).v,
    overdue_count: db.prepare("SELECT COUNT(*) v FROM bill_invoices WHERE status IN ('sent','partial') AND due_date IS NOT NULL AND due_date<?").get(today).v,
    collected_30d: db.prepare('SELECT COALESCE(SUM(amount),0) v FROM bill_payments WHERE date>=?').get(monthAgo).v,
    draft_count: db.prepare("SELECT COUNT(*) v FROM bill_invoices WHERE status='draft'").get().v
  });
});
app.get('/api/billing/products', requireNoc, (req, res) => {
  res.json(db.prepare('SELECT * FROM bill_products WHERE active=1 ORDER BY name').all());
});
app.post('/api/billing/products', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO bill_products (name,description,price,taxable) VALUES (?,?,?,?)').run(b.name, N(b.description), r2(b.price), b.taxable === false ? 0 : 1);
  audit(req, 'create', 'product#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/billing/products/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM bill_products WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bill_products SET name=?, description=?, price=?, taxable=? WHERE id=?')
    .run(N(b.name, ex.name), N(b.description, ex.description), b.price === undefined ? ex.price : r2(b.price),
         b.taxable === undefined ? ex.taxable : (b.taxable ? 1 : 0), req.params.id);
  audit(req, 'edit', 'product#' + req.params.id, b.name || ex.name);
  res.json({ ok: true });
});
app.delete('/api/billing/products/:id', requireNoc, (req, res) => {
  db.prepare('UPDATE bill_products SET active=0 WHERE id=?').run(req.params.id); // soft delete: past invoice lines stay intact
  audit(req, 'delete', 'product#' + req.params.id);
  res.json({ ok: true });
});
app.get('/api/billing/invoices', requireNoc, (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%';
  let sql = `SELECT i.id, i.number, i.customer_id, i.date, i.due_date, i.status, i.total, i.balance, c.name AS customer_name
    FROM bill_invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE (i.number LIKE ? OR c.name LIKE ?)`;
  const args = [q, q];
  if (req.query.status) { sql += ' AND i.status=?'; args.push(String(req.query.status)); }
  sql += ' ORDER BY i.id DESC LIMIT 300';
  res.json(db.prepare(sql).all(...args));
});
app.get('/api/billing/invoices/:id', requireNoc, (req, res) => {
  const inv = loadInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  res.json(inv);
});
app.post('/api/billing/invoices', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Pick a customer' });
  const items = cleanItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
  const id = insertInvoice({ customer_id: Number(b.customer_id), email: b.email, date: b.date, due_date: b.due_date, tax_rate: b.tax_rate, notes: b.notes, items, status: 'draft', terms: getSetting('invoice_terms') });
  let emailed = false;
  if (b.send) {
    emailed = emailInvoice(loadInvoice(id));
    db.prepare("UPDATE bill_invoices SET status='sent', sent_at=datetime('now') WHERE id=?").run(id);
  }
  const num = db.prepare('SELECT number FROM bill_invoices WHERE id=?').get(id).number;
  audit(req, 'create', 'invoice#' + id, num + (b.send ? ' (sent)' : ' (draft)'));
  res.json({ id, number: num, emailed });
});
app.put('/api/billing/invoices/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (inv.status !== 'draft') return res.status(409).json({ error: 'Only draft invoices can be edited' });
  const items = cleanItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
  const t = computeTotals(items, b.tax_rate === undefined ? inv.tax_rate : b.tax_rate);
  db.prepare('UPDATE bill_invoices SET customer_id=?, email=?, date=?, due_date=?, tax_rate=?, subtotal=?, tax=?, total=?, balance=?, notes=? WHERE id=?')
    .run(Number(b.customer_id || inv.customer_id), N(b.email, inv.email), b.date || inv.date, N(b.due_date, inv.due_date),
         Number(b.tax_rate === undefined ? inv.tax_rate : b.tax_rate), t.subtotal, t.tax, t.total, t.total, N(b.notes, inv.notes), inv.id);
  db.prepare('DELETE FROM bill_items WHERE invoice_id=?').run(inv.id);
  const ins = db.prepare('INSERT INTO bill_items (invoice_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
  for (const it of items) ins.run(inv.id, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
  audit(req, 'edit', 'invoice#' + inv.id, inv.number);
  res.json({ ok: true });
});
app.post('/api/billing/invoices/:id/send', requireNoc, (req, res) => {
  const inv = loadInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (['paid', 'void'].includes(inv.status)) return res.status(409).json({ error: 'Invoice is ' + inv.status });
  const emailed = emailInvoice(inv);
  if (inv.status === 'draft') db.prepare("UPDATE bill_invoices SET status='sent', sent_at=datetime('now') WHERE id=?").run(inv.id);
  audit(req, 'edit', 'invoice#' + inv.id, inv.number + (emailed ? ' emailed' : ' marked sent (no email on file)'));
  res.json({ ok: true, emailed });
});
app.post('/api/billing/invoices/:id/pay', requireNoc, (req, res) => {
  const b = req.body || {};
  try {
    const out = applyPayment(Number(req.params.id), { amount: b.amount, method: b.method || 'other', reference: b.reference, date: b.date, notes: b.notes });
    audit(req, 'payment', 'invoice#' + req.params.id, `$${r2(b.amount).toFixed(2)} ${b.method || 'other'}${b.reference ? ' · ' + b.reference : ''}`);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
app.post('/api/billing/invoices/:id/void', requireNoc, (req, res) => {
  const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (inv.status === 'paid') return res.status(409).json({ error: 'Paid invoices cannot be voided' });
  db.prepare("UPDATE bill_invoices SET status='void', balance=0 WHERE id=?").run(inv.id);
  audit(req, 'edit', 'invoice#' + inv.id, inv.number + ' voided');
  res.json({ ok: true });
});
app.delete('/api/billing/invoices/:id', requireNoc, (req, res) => {
  const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (!['draft', 'void'].includes(inv.status)) return res.status(409).json({ error: 'Only draft or void invoices can be deleted — void it first' });
  db.prepare('DELETE FROM bill_items WHERE invoice_id=?').run(inv.id);
  db.prepare('DELETE FROM bill_payments WHERE invoice_id=?').run(inv.id);
  db.prepare('DELETE FROM bill_invoices WHERE id=?').run(inv.id);
  audit(req, 'delete', 'invoice#' + inv.id, inv.number);
  res.json({ ok: true });
});
app.get('/api/billing/payments', requireNoc, (req, res) => {
  res.json(db.prepare(`SELECT p.*, i.number AS invoice_number, c.name AS customer_name
    FROM bill_payments p JOIN bill_invoices i ON i.id=p.invoice_id LEFT JOIN customers c ON c.id=i.customer_id
    ORDER BY p.date DESC, p.id DESC LIMIT 300`).all());
});
// ---- recurring schedules ----
const FREQS = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', yearly: 'Yearly' };
const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
function advanceDate(dateStr, freq) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + (FREQ_MONTHS[freq] || 1));
  return d.toISOString().slice(0, 10);
}
app.get('/api/billing/recurring', requireNoc, (req, res) => {
  const rows = db.prepare(`SELECT r.*, c.name AS customer_name FROM bill_recurring r LEFT JOIN customers c ON c.id=r.customer_id ORDER BY r.active DESC, c.name`).all();
  for (const r of rows) {
    try { r.items = JSON.parse(r.items_json); } catch { r.items = []; }
    r.amount = computeTotals(r.items, r.tax_rate).total;
    r.frequency_label = FREQS[r.frequency] || r.frequency;
    delete r.items_json;
  }
  res.json(rows);
});
app.post('/api/billing/recurring', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Pick a customer' });
  const items = cleanItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
  if (!b.next_date) return res.status(400).json({ error: 'Set the next invoice date' });
  const freq = FREQS[b.frequency] ? b.frequency : 'monthly';
  const info = db.prepare('INSERT INTO bill_recurring (customer_id,frequency,next_date,tax_rate,items_json,auto_send,active) VALUES (?,?,?,?,?,?,1)')
    .run(Number(b.customer_id), freq, b.next_date, Number(b.tax_rate || 0), JSON.stringify(items), b.auto_send === false ? 0 : 1);
  audit(req, 'create', 'recurring#' + info.lastInsertRowid, `customer#${b.customer_id} ${freq}`);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/billing/recurring/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM bill_recurring WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  const items = b.items !== undefined ? cleanItems(b.items) : null;
  db.prepare('UPDATE bill_recurring SET customer_id=?, frequency=?, next_date=?, tax_rate=?, items_json=?, auto_send=?, active=? WHERE id=?')
    .run(Number(b.customer_id || ex.customer_id), FREQS[b.frequency] ? b.frequency : ex.frequency, b.next_date || ex.next_date,
         Number(b.tax_rate === undefined ? ex.tax_rate : b.tax_rate), items ? JSON.stringify(items) : ex.items_json,
         b.auto_send === undefined ? ex.auto_send : (b.auto_send ? 1 : 0),
         b.active === undefined ? ex.active : (b.active ? 1 : 0), ex.id);
  audit(req, 'edit', 'recurring#' + ex.id);
  res.json({ ok: true });
});
app.delete('/api/billing/recurring/:id', requireNoc, (req, res) => {
  db.prepare('DELETE FROM bill_recurring WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'recurring#' + req.params.id);
  res.json({ ok: true });
});
// Generate invoices for due schedules (sampler runs this hourly; button exposes it too)
function runRecurringBilling() {
  const due = db.prepare('SELECT * FROM bill_recurring WHERE active=1 AND next_date<=?').all(todayStr());
  let made = 0;
  for (const r of due) {
    let items = []; try { items = JSON.parse(r.items_json); } catch {}
    if (!items.length) continue;
    const cust = db.prepare('SELECT billing_email FROM customers WHERE id=?').get(r.customer_id) || {};
    const id = insertInvoice({ customer_id: r.customer_id, email: cust.billing_email, date: r.next_date, due_date: advanceDate(r.next_date, 'monthly'), tax_rate: r.tax_rate, items, status: r.auto_send ? 'sent' : 'draft', terms: getSetting('recurring_invoice_terms') || getSetting('invoice_terms') });
    if (r.auto_send) { emailInvoice(loadInvoice(id)); db.prepare("UPDATE bill_invoices SET sent_at=datetime('now') WHERE id=?").run(id); }
    db.prepare('UPDATE bill_recurring SET next_date=? WHERE id=?').run(advanceDate(r.next_date, r.frequency), r.id);
    db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)')
      .run('system', 'system', 'create', 'invoice#' + id, 'recurring#' + r.id + (r.auto_send ? ' (auto-sent)' : ' (draft)'));
    made++;
  }
  return made;
}
app.post('/api/billing/recurring/run', requireNoc, (req, res) => {
  const made = runRecurringBilling();
  audit(req, 'edit', 'billing', `recurring run: ${made} invoice(s) generated`);
  res.json({ made });
});
app.post('/api/billing/stripe-test', requireNoc, async (req, res) => {
  try {
    const j = await stripeReq('GET', '/v1/balance');
    res.json({ ok: true, livemode: !!j.livemode, currency: (j.available && j.available[0] && j.available[0].currency) || 'usd' });
  } catch (e) { res.status(e.http || 502).json({ error: e.message }); }
});
// per-customer billing rollup (customer page card)
app.get('/api/customers/:id/billing', requireNoc, (req, res) => {
  const invoices = db.prepare('SELECT id, number, date, due_date, status, total, balance FROM bill_invoices WHERE customer_id=? ORDER BY id DESC LIMIT 12').all(req.params.id);
  const outstanding = db.prepare("SELECT COALESCE(SUM(balance),0) v FROM bill_invoices WHERE customer_id=? AND status IN ('sent','partial')").get(req.params.id).v;
  res.json({ any: invoices.length > 0, outstanding, invoices });
});
// full billing backup / restore (all bill_* tables + numbering)
app.get('/api/billing/backup', requireNoc, (req, res) => {
  const dump = {
    format: 'netinv-billing-backup', version: 2, exported_at: new Date().toISOString(),
    bill_prefix: getSetting('bill_prefix') || 'INV-', bill_next: getSetting('bill_next') || '1001',
    products: db.prepare('SELECT * FROM bill_products').all(),
    invoices: db.prepare('SELECT * FROM bill_invoices').all(),
    items: db.prepare('SELECT * FROM bill_items').all(),
    payments: db.prepare('SELECT * FROM bill_payments').all(),
    recurring: db.prepare('SELECT * FROM bill_recurring').all(),
    quotes: db.prepare('SELECT * FROM bill_quotes').all(),
    quote_items: db.prepare('SELECT * FROM bill_quote_items').all()
  };
  audit(req, 'billing_backup', 'billing', `${dump.invoices.length} invoices, ${dump.payments.length} payments`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="billing-backup-${todayStr()}.json"`);
  res.send(JSON.stringify(dump));
});
app.post('/api/billing/restore', requireNoc, (req, res) => {
  const b = req.body || {};
  if (b.format !== 'netinv-billing-backup' || b.version !== 2 || !Array.isArray(b.invoices)) return res.status(400).json({ error: 'Not a billing backup file' });
  db.exec('BEGIN');
  try {
    const tables = { bill_products: b.products, bill_invoices: b.invoices, bill_items: b.items, bill_payments: b.payments, bill_recurring: b.recurring, bill_quotes: b.quotes, bill_quote_items: b.quote_items };
    const counts = {};
    for (const [table, rows] of Object.entries(tables)) {
      db.exec(`DELETE FROM ${table}`);
      const list = Array.isArray(rows) ? rows : [];
      if (list.length) {
        const cols = Object.keys(list[0]);
        const ins = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        for (const row of list) ins.run(...cols.map(c => row[c] === undefined ? null : row[c]));
      }
      counts[table.replace('bill_', '')] = list.length;
    }
    if (b.bill_prefix) setSetting('bill_prefix', String(b.bill_prefix));
    if (b.bill_next) setSetting('bill_next', String(b.bill_next));
    db.exec('COMMIT');
    audit(req, 'billing_restore', 'billing', Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '));
    res.json({ ok: true, counts });
  } catch (e) { db.exec('ROLLBACK'); res.status(500).json({ error: 'Restore failed: ' + e.message }); }
});
// ---- public pay page (tokenized link; no login) ----
function payPage(inv, msg) {
  const company = esc2(getSetting('bill_company') || 'Network Inventory');
  const canPay = inv.balance > 0 && inv.status !== 'void' && !!getSetting('stripe_secret');
  const anyUntaxed = inv.tax > 0 && inv.items.some(it => it.taxable === 0);
  const rows = inv.items.map(it => `<tr><td>${esc2(it.description)}${anyUntaxed && it.taxable === 0 ? ' <span style="color:#9aa6b2;font-size:12px">· no tax</span>' : ''}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
  const statusTxt = inv.status === 'void' ? 'VOID' : inv.balance <= 0 ? 'PAID — thank you' : (inv.status === 'partial' ? `$${inv.balance.toFixed(2)} remaining` : `$${inv.balance.toFixed(2)} due${inv.due_date ? ' by ' + esc2(inv.due_date) : ''}`);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invoice ${esc2(inv.number)}</title>
<style>:root{--bg:#0f1216;--card:#171c22;--line:#2a323c;--text:#e6eaf0;--muted:#9aa6b2;--accent:#378ADD;--ok:#1D9E75}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5}
.wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:20px;margin:0 0 2px}.sub{color:var(--muted);font-size:14px;margin:0 0 18px}table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:7px 0;border-bottom:1px solid var(--line)}.tot td{border-bottom:0;padding-top:12px;font-weight:600}
.status{display:inline-block;margin:14px 0;padding:6px 14px;border-radius:20px;font-weight:600;font-size:14px;background:#0e1318;border:1px solid var(--line)}
.paid{color:var(--ok)}.due{color:#f0ad4e}.msg{margin:0 0 14px;padding:10px 14px;border-radius:9px;background:#0e1318;border:1px solid var(--line);font-size:14px}
.pay{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.hint{color:var(--muted);font-size:12px;margin-top:8px;text-align:center}</style></head><body><div class="wrap"><div class="card">
<h1>Invoice ${esc2(inv.number)}</h1><p class="sub">${company} · ${esc2(inv.date)}${inv.customer_name ? ' · ' + esc2(inv.customer_name) : ''}</p>
${msg ? `<div class="msg">${msg}</div>` : ''}
<table>${rows}${inv.tax > 0 ? `<tr><td>Tax (${inv.tax_rate}%)</td><td></td><td align="right">$${inv.tax.toFixed(2)}</td></tr>` : ''}<tr class="tot"><td>Total</td><td></td><td align="right">$${inv.total.toFixed(2)}</td></tr></table>
<div class="status ${inv.balance <= 0 ? 'paid' : 'due'}">${statusTxt}</div>
${inv.notes ? `<p class="sub">${esc2(inv.notes)}</p>` : ''}
${canPay ? `<button class="pay" onclick="pay(this)">Pay $${inv.balance.toFixed(2)} online</button><div class="hint">Card or US bank transfer (ACH) — processed securely by Stripe. This site never sees your card or bank details.</div>` : ''}
${inv.terms ? `<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--line)"><div style="color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px">TERMS &amp; BILLING AGREEMENT</div><div style="color:var(--muted);font-size:12px;white-space:pre-wrap">${esc2(inv.terms)}</div></div>` : ''}
</div></div>
<script>async function pay(btn){btn.disabled=true;btn.textContent='Redirecting to secure payment…';
try{const r=await fetch(location.pathname+'/checkout',{method:'POST'});const j=await r.json();
if(j.url)location.href=j.url;else{alert(j.error||'Could not start payment');btn.disabled=false;btn.textContent='Pay online';}}
catch(e){alert('Could not start payment');btn.disabled=false;btn.textContent='Pay online';}}</script></body></html>`;
}
const invByToken = (token) => { const row = db.prepare('SELECT id FROM bill_invoices WHERE pay_token=?').get(String(token || '')); return row ? loadInvoice(row.id) : null; };
app.get('/pay/:token', (req, res) => {
  const inv = invByToken(req.params.token);
  if (!inv) return res.status(404).type('text/plain').send('Invoice not found');
  let msg = null;
  if (req.query.result === 'success') msg = inv.balance <= 0 ? 'Payment received — thank you!' : 'Payment submitted. Bank (ACH) payments take a few business days to clear; this page will update once it does.';
  else if (req.query.result === 'cancel') msg = 'Payment was cancelled — you can try again below.';
  res.type('html').send(payPage(inv, msg));
});
app.post('/pay/:token/checkout', async (req, res) => {
  const inv = invByToken(req.params.token);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (inv.balance <= 0 || inv.status === 'void') return res.status(409).json({ error: 'Nothing to pay on this invoice' });
  const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
  if (!pub) return res.status(400).json({ error: 'Online payment not configured' });
  try {
    const company = getSetting('bill_company') || 'Invoice';
    const session = await stripeReq('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'us_bank_account',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Invoice ${inv.number} — ${company}`,
      'line_items[0][price_data][unit_amount]': String(Math.round(inv.balance * 100)),
      'line_items[0][quantity]': '1',
      success_url: `${pub}/pay/${inv.pay_token}?result=success`,
      cancel_url: `${pub}/pay/${inv.pay_token}?result=cancel`,
      'metadata[invoice_id]': String(inv.id),
      ...(inv.email || inv.billing_email ? { customer_email: inv.email || inv.billing_email } : {})
    });
    res.json({ url: session.url });
  } catch (e) { res.status(e.http || 502).json({ error: e.message }); }
});

// ---- quotes (mirror invoices; convert to invoice) ----
function nextQuoteNumber() {
  const prefix = getSetting('quote_prefix') || 'QUO-';
  const seq = parseInt(getSetting('quote_next'), 10) || 1001;
  setSetting('quote_next', String(seq + 1));
  return prefix + seq;
}
function insertQuote({ customer_id, email, date, expiry_date, tax_rate, notes, items, status, terms }) {
  const t = computeTotals(items, tax_rate);
  const info = db.prepare(`INSERT INTO bill_quotes (number,customer_id,email,date,expiry_date,status,tax_rate,subtotal,tax,total,notes,terms,view_token)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nextQuoteNumber(), customer_id, N(email), date || todayStr(), N(expiry_date), status || 'draft',
         Number(tax_rate || 0), t.subtotal, t.tax, t.total, N(notes), N(terms), randomBytes(18).toString('hex'));
  const ins = db.prepare('INSERT INTO bill_quote_items (quote_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
  for (const it of items) ins.run(info.lastInsertRowid, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
  return info.lastInsertRowid;
}
function loadQuote(id) {
  const q = db.prepare(`SELECT q.*, c.name AS customer_name, c.billing_email FROM bill_quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=?`).get(id);
  if (!q) return null;
  q.items = db.prepare('SELECT * FROM bill_quote_items WHERE quote_id=? ORDER BY id').all(id);
  const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
  q.view_url = pub && q.view_token ? `${pub}/quote/${q.view_token}` : null;
  return q;
}
function emailQuote(q) {
  const to = q.email || q.billing_email; if (!to) return false;
  const company = getSetting('bill_company') || 'Network Inventory';
  const lines = q.items.map(it => ` - ${it.description}  x${it.quantity}  $${it.amount.toFixed(2)}`).join('\n');
  const rows = q.items.map(it => `<tr><td style="padding:4px 12px 4px 0">${esc2(it.description)}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
  const viewBtn = q.view_url ? `<p style="margin:18px 0"><a href="${q.view_url}" style="background:#378ADD;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none">View &amp; respond to quote</a></p>` : '';
  mailSafe({
    to, subject: `Quote ${q.number} from ${company} — $${q.total.toFixed(2)}`,
    text: `Quote ${q.number} from ${company}\nDate: ${q.date}${q.expiry_date ? '\nValid until: ' + q.expiry_date : ''}\n\n${lines}\n\nTotal: $${q.total.toFixed(2)}${q.view_url ? '\n\nView & respond: ' + q.view_url : ''}${q.notes ? '\n\n' + q.notes : ''}`,
    html: `<h2>Quote ${esc2(q.number)}</h2><p>${esc2(company)} · ${esc2(q.date)}${q.expiry_date ? ' · valid until <b>' + esc2(q.expiry_date) + '</b>' : ''}</p>
      <table style="border-collapse:collapse">${rows}<tr><td style="padding:8px 12px 0 0"><b>Total</b></td><td></td><td align="right"><b>$${q.total.toFixed(2)}</b></td></tr></table>${viewBtn}${q.notes ? `<p style="color:#555">${esc2(q.notes)}</p>` : ''}`
  });
  return true;
}
app.get('/api/billing/quotes', requireNoc, (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%';
  const st = String(req.query.status || '');
  let sql = `SELECT q.id, q.number, q.date, q.expiry_date, q.status, q.total, q.converted_invoice_id, c.name AS customer_name
    FROM bill_quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE (q.number LIKE ? OR c.name LIKE ?)`;
  const params = [q, q];
  if (st) { sql += ' AND q.status=?'; params.push(st); }
  sql += ' ORDER BY q.id DESC LIMIT 300';
  res.json(db.prepare(sql).all(...params));
});
app.get('/api/billing/quotes/:id', requireNoc, (req, res) => {
  const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'not found' });
  res.json(q);
});
app.post('/api/billing/quotes', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Pick a customer' });
  const items = cleanItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
  const id = insertQuote({ customer_id: Number(b.customer_id), email: b.email, date: b.date, expiry_date: b.expiry_date, tax_rate: b.tax_rate, notes: b.notes, items, status: 'draft', terms: getSetting('invoice_terms') });
  let emailed = false;
  if (b.send) { emailed = emailQuote(loadQuote(id)); db.prepare("UPDATE bill_quotes SET status='sent', sent_at=datetime('now') WHERE id=?").run(id); }
  const num = db.prepare('SELECT number FROM bill_quotes WHERE id=?').get(id).number;
  audit(req, 'create', 'quote#' + id, num + (b.send ? ' (sent)' : ' (draft)'));
  res.json({ id, number: num, emailed });
});
app.put('/api/billing/quotes/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const q = db.prepare('SELECT * FROM bill_quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  if (['converted', 'accepted'].includes(q.status)) return res.status(409).json({ error: 'This quote can no longer be edited' });
  const items = cleanItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
  const t = computeTotals(items, b.tax_rate === undefined ? q.tax_rate : b.tax_rate);
  db.prepare('UPDATE bill_quotes SET customer_id=?, email=?, date=?, expiry_date=?, tax_rate=?, subtotal=?, tax=?, total=?, notes=? WHERE id=?')
    .run(Number(b.customer_id || q.customer_id), N(b.email, q.email), b.date || q.date, N(b.expiry_date, q.expiry_date),
         Number(b.tax_rate === undefined ? q.tax_rate : b.tax_rate), t.subtotal, t.tax, t.total, N(b.notes, q.notes), q.id);
  db.prepare('DELETE FROM bill_quote_items WHERE quote_id=?').run(q.id);
  const ins = db.prepare('INSERT INTO bill_quote_items (quote_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
  for (const it of items) ins.run(q.id, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
  audit(req, 'edit', 'quote#' + q.id, q.number);
  res.json({ ok: true });
});
app.post('/api/billing/quotes/:id/send', requireNoc, (req, res) => {
  const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'not found' });
  if (['converted'].includes(q.status)) return res.status(409).json({ error: 'Quote already converted' });
  const emailed = emailQuote(q);
  if (q.status === 'draft') db.prepare("UPDATE bill_quotes SET status='sent', sent_at=datetime('now') WHERE id=?").run(q.id);
  audit(req, 'edit', 'quote#' + q.id, q.number + (emailed ? ' emailed' : ' marked sent'));
  res.json({ ok: true, emailed });
});
app.post('/api/billing/quotes/:id/status', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!['accepted', 'declined', 'sent', 'expired'].includes(b.status)) return res.status(400).json({ error: 'bad status' });
  const q = db.prepare('SELECT * FROM bill_quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  if (q.status === 'converted') return res.status(409).json({ error: 'Quote already converted' });
  db.prepare('UPDATE bill_quotes SET status=? WHERE id=?').run(b.status, q.id);
  audit(req, 'edit', 'quote#' + q.id, q.number + ' → ' + b.status);
  res.json({ ok: true });
});
app.post('/api/billing/quotes/:id/convert', requireNoc, (req, res) => {
  const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'not found' });
  if (q.status === 'converted') return res.status(409).json({ error: 'Quote already converted to invoice #' + q.converted_invoice_id });
  const items = q.items.map(it => ({ description: it.description, quantity: it.quantity, unit_price: it.unit_price, taxable: it.taxable }));
  if (!items.length) return res.status(400).json({ error: 'Quote has no line items' });
  const invId = insertInvoice({ customer_id: q.customer_id, email: q.email || q.billing_email, date: todayStr(), tax_rate: q.tax_rate, notes: q.notes, items, status: 'draft', terms: getSetting('invoice_terms') });
  db.prepare("UPDATE bill_quotes SET status='converted', converted_invoice_id=? WHERE id=?").run(invId, q.id);
  const num = db.prepare('SELECT number FROM bill_invoices WHERE id=?').get(invId).number;
  audit(req, 'edit', 'quote#' + q.id, q.number + ' → invoice ' + num);
  res.json({ ok: true, invoice_id: invId, invoice_number: num });
});
app.delete('/api/billing/quotes/:id', requireNoc, (req, res) => {
  const q = db.prepare('SELECT * FROM bill_quotes WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM bill_quote_items WHERE quote_id=?').run(q.id);
  db.prepare('DELETE FROM bill_quotes WHERE id=?').run(q.id);
  audit(req, 'delete', 'quote#' + q.id, q.number);
  res.json({ ok: true });
});
// public quote view (tokenized; no login) — accept/decline
function quotePage(q, msg) {
  const company = esc2(getSetting('bill_company') || 'Network Inventory');
  const rows = q.items.map(it => `<tr><td>${esc2(it.description)}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
  const canRespond = ['draft', 'sent'].includes(q.status);
  const statusTxt = { accepted: 'Accepted — thank you', declined: 'Declined', converted: 'Accepted', expired: 'Expired' }[q.status] || (q.expiry_date ? 'Valid until ' + esc2(q.expiry_date) : 'Awaiting your response');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Quote ${esc2(q.number)}</title>
<style>:root{--bg:#0f1216;--card:#171c22;--line:#2a323c;--text:#e6eaf0;--muted:#9aa6b2;--accent:#378ADD;--ok:#1D9E75;--danger:#dc3545}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5}
.wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:20px;margin:0 0 2px}.sub{color:var(--muted);font-size:14px;margin:0 0 18px}table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:7px 0;border-bottom:1px solid var(--line)}.tot td{border-bottom:0;padding-top:12px;font-weight:600}
.status{display:inline-block;margin:14px 0;padding:6px 14px;border-radius:20px;font-weight:600;font-size:14px;background:#0e1318;border:1px solid var(--line)}
.msg{margin:0 0 14px;padding:10px 14px;border-radius:9px;background:#0e1318;border:1px solid var(--line);font-size:14px}
.btns{display:flex;gap:10px;margin-top:18px}.b{flex:1;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
.acc{background:var(--ok);color:#fff}.dec{background:#0e1318;color:var(--text);border:1px solid var(--line)}</style></head><body><div class="wrap"><div class="card">
<h1>Quote ${esc2(q.number)}</h1><p class="sub">${company} · ${esc2(q.date)}${q.customer_name ? ' · ' + esc2(q.customer_name) : ''}</p>
${msg ? `<div class="msg">${msg}</div>` : ''}
<table>${rows}${q.tax > 0 ? `<tr><td>Tax (${q.tax_rate}%)</td><td></td><td align="right">$${q.tax.toFixed(2)}</td></tr>` : ''}<tr class="tot"><td>Total</td><td></td><td align="right">$${q.total.toFixed(2)}</td></tr></table>
<div class="status">${statusTxt}</div>
${q.notes ? `<p class="sub">${esc2(q.notes)}</p>` : ''}
${canRespond ? `<div class="btns"><button class="b acc" onclick="respond('accept',this)">Accept quote</button><button class="b dec" onclick="respond('decline',this)">Decline</button></div>` : ''}
${q.terms ? `<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--line)"><div style="color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px">TERMS &amp; BILLING AGREEMENT</div><div style="color:var(--muted);font-size:12px;white-space:pre-wrap">${esc2(q.terms)}</div></div>` : ''}
</div></div>
<script>async function respond(action,btn){btn.disabled=true;btn.parentElement.querySelectorAll('button').forEach(b=>b.disabled=true);
try{const r=await fetch(location.pathname+'/respond',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const j=await r.json();
if(j.ok)location.href=location.pathname+'?result='+action;else{alert(j.error||'Could not submit');btn.disabled=false;}}catch(e){alert('Could not submit');btn.disabled=false;}}</script></body></html>`;
}
const quoteByToken = (token) => { const row = db.prepare('SELECT id FROM bill_quotes WHERE view_token=?').get(String(token || '')); return row ? loadQuote(row.id) : null; };
app.get('/quote/:token', (req, res) => {
  const q = quoteByToken(req.params.token);
  if (!q) return res.status(404).type('text/plain').send('Quote not found');
  let msg = null;
  if (req.query.result === 'accept') msg = 'Thank you — your acceptance has been recorded.';
  else if (req.query.result === 'decline') msg = 'You have declined this quote.';
  res.type('html').send(quotePage(q, msg));
});
app.post('/quote/:token/respond', express.json(), (req, res) => {
  const q = quoteByToken(req.params.token);
  if (!q) return res.status(404).json({ error: 'not found' });
  if (!['draft', 'sent'].includes(q.status)) return res.status(409).json({ error: 'This quote can no longer be responded to' });
  const action = (req.body || {}).action;
  const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : null;
  if (!status) return res.status(400).json({ error: 'bad action' });
  db.prepare('UPDATE bill_quotes SET status=? WHERE id=?').run(status, q.id);
  db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)').run(q.email || 'customer', 'public', 'quote_' + status, 'quote#' + q.id, q.number);
  const notify = getSetting('access_notify_email') || getSetting('mail_from');
  if (notify) mailSafe({ to: notify, subject: `Quote ${q.number} ${status}`, text: `Quote ${q.number} for ${q.customer_name || ''} was ${status}.`, html: `<p>Quote <b>${esc2(q.number)}</b> for ${esc2(q.customer_name || '')} was <b>${status}</b>.</p>` });
  res.json({ ok: true, status });
});

// ---- customer portal (separate auth: password OR magic link) ----
function portalCookie(res, token) { res.setHeader('Set-Cookie', `psid=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`); }
function portalCustomer(req) {
  const t = parseCookies(req).psid; if (!t) return null;
  const s = db.prepare("SELECT customer_id FROM portal_sessions WHERE token=? AND expires_at>datetime('now')").get(t);
  return s ? db.prepare('SELECT * FROM customers WHERE id=?').get(s.customer_id) : null;
}
function requirePortal(req, res, next) { const c = portalCustomer(req); if (!c) return res.status(401).json({ error: 'Please sign in' }); req.pcust = c; next(); }
const pubBase = () => (getSetting('public_base_url') || '').replace(/\/+$/, '');
app.get('/portal', (req, res) => res.sendFile(join(__dirname, 'public', 'portal.html')));
app.post('/portal/login', (req, res) => {
  const b = req.body || {}; const email = String(b.email || '').trim().toLowerCase();
  const c = db.prepare("SELECT * FROM customers WHERE lower(billing_email)=? AND portal_enabled=1").get(email);
  if (!c || !c.portal_password || !verifyPassword(String(b.password || ''), c.portal_password)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = randomBytes(24).toString('hex');
  db.prepare("INSERT INTO portal_sessions (token,customer_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").run(token, c.id);
  portalCookie(res, token); res.json({ ok: true });
});
app.post('/portal/login-link', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const c = db.prepare("SELECT * FROM customers WHERE lower(billing_email)=? AND portal_enabled=1").get(email);
  if (c && c.billing_email) {
    const token = randomBytes(24).toString('hex');
    db.prepare("INSERT INTO portal_login_tokens (token,customer_id,expires_at) VALUES (?,?,datetime('now','+30 minutes'))").run(token, c.id);
    const link = pubBase() + '/portal/auth/' + token;
    mailSafe({ to: c.billing_email, subject: 'Your account portal login link', text: `Sign in to your account portal:\n${link}\n\nThis link expires in 30 minutes.`, html: `<p><a href="${link}">Sign in to your account portal</a></p><p style="color:#777;font-size:12px">This link expires in 30 minutes. If you didn't request it, you can ignore this email.</p>` });
  }
  res.json({ ok: true }); // never reveal whether the email exists
});
app.get('/portal/auth/:token', (req, res) => {
  const row = db.prepare("SELECT customer_id FROM portal_login_tokens WHERE token=? AND expires_at>datetime('now')").get(req.params.token);
  if (!row) return res.status(400).type('text/plain').send('This login link is invalid or has expired.');
  db.prepare('DELETE FROM portal_login_tokens WHERE token=?').run(req.params.token);
  const token = randomBytes(24).toString('hex');
  db.prepare("INSERT INTO portal_sessions (token,customer_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").run(token, row.customer_id);
  portalCookie(res, token); res.redirect('/portal');
});
app.post('/portal/logout', (req, res) => { const t = parseCookies(req).psid; if (t) db.prepare('DELETE FROM portal_sessions WHERE token=?').run(t); res.setHeader('Set-Cookie', 'psid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/portal/api/me', requirePortal, (req, res) => res.json({ name: req.pcust.name, email: req.pcust.billing_email, company: getSetting('bill_company') || 'Your provider' }));
app.get('/portal/api/invoices', requirePortal, (req, res) => {
  const pub = pubBase();
  const rows = db.prepare("SELECT id,number,date,due_date,status,total,balance,pay_token FROM bill_invoices WHERE customer_id=? AND status!='void' ORDER BY id DESC").all(req.pcust.id);
  res.json(rows.map(i => ({ id: i.id, number: i.number, date: i.date, due_date: i.due_date, status: i.status, total: i.total, balance: i.balance, pay_url: pub && i.pay_token && i.balance > 0 ? `${pub}/pay/${i.pay_token}` : null })));
});
app.get('/portal/api/quotes', requirePortal, (req, res) => {
  const pub = pubBase();
  const rows = db.prepare("SELECT id,number,date,expiry_date,status,total,view_token FROM bill_quotes WHERE customer_id=? ORDER BY id DESC").all(req.pcust.id);
  res.json(rows.map(q => ({ id: q.id, number: q.number, date: q.date, expiry_date: q.expiry_date, status: q.status, total: q.total, view_url: pub && q.view_token ? `${pub}/quote/${q.view_token}` : null })));
});
app.get('/portal/api/account', requirePortal, (req, res) => {
  res.json({
    name: req.pcust.name,
    accounts: customerAccounts(req.pcust.id),
    sites: db.prepare('SELECT id,name,service_address,status FROM sites WHERE customer_id=? ORDER BY name').all(req.pcust.id)
  });
});

// ---- support / trouble tickets ----
const TICKET_STATUS = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
const TICKET_PRIO = ['low', 'normal', 'high', 'urgent'];
const nl2br = s => esc2(s).replace(/\n/g, '<br>');
function ticketNotify(subject, text, html) { const to = getSetting('access_notify_email') || getSetting('mail_from'); if (to) mailSafe({ to, subject, text, html }); }
function createTicket({ customer_id, site_id, subject, body, priority, opened_by, author }) {
  const info = db.prepare("INSERT INTO tickets (customer_id,site_id,subject,priority,opened_by) VALUES (?,?,?,?,?)")
    .run(customer_id, N(site_id), subject, TICKET_PRIO.includes(priority) ? priority : 'normal', opened_by || 'customer');
  const id = info.lastInsertRowid;
  db.prepare('UPDATE tickets SET number=? WHERE id=?').run('TKT-' + (1000 + id), id);
  if (body) db.prepare("INSERT INTO ticket_messages (ticket_id,author_type,author,body) VALUES (?,?,?,?)").run(id, opened_by || 'customer', author || '', body);
  return id;
}
function loadTicket(id) {
  const t = db.prepare('SELECT t.*, c.name AS customer_name, c.billing_email, s.name AS site_name FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=t.site_id WHERE t.id=?').get(id);
  if (!t) return null;
  t.messages = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(id);
  return t;
}
// staff
app.get('/api/tickets', requireNoc, (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%'; const st = String(req.query.status || '');
  let sql = `SELECT t.id,t.number,t.subject,t.status,t.priority,t.assigned_to,t.opened_by,t.created_at,t.updated_at, c.name AS customer_name,
    (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=t.id) AS msg_count
    FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE (t.subject LIKE ? OR t.number LIKE ? OR c.name LIKE ?)`;
  const p = [q, q, q];
  if (st === 'active') sql += " AND t.status IN ('open','in_progress','waiting')";
  else if (st) { sql += ' AND t.status=?'; p.push(st); }
  sql += " ORDER BY (t.status IN ('open','in_progress','waiting')) DESC, t.updated_at DESC LIMIT 300";
  res.json(db.prepare(sql).all(...p));
});
app.get('/api/tickets/summary', requireNoc, (req, res) => {
  res.json({
    open: db.prepare("SELECT COUNT(*) v FROM tickets WHERE status IN ('open','in_progress','waiting')").get().v,
    unassigned: db.prepare("SELECT COUNT(*) v FROM tickets WHERE status IN ('open','in_progress','waiting') AND (assigned_to IS NULL OR assigned_to='')").get().v,
    urgent: db.prepare("SELECT COUNT(*) v FROM tickets WHERE status IN ('open','in_progress','waiting') AND priority='urgent'").get().v
  });
});
app.get('/api/staff', requireNoc, (req, res) => res.json(db.prepare("SELECT name, email FROM users WHERE active=1 ORDER BY name").all()));
app.get('/api/tickets/:id', requireNoc, (req, res) => { const t = loadTicket(req.params.id); if (!t) return res.status(404).json({ error: 'not found' }); res.json(t); });
app.post('/api/tickets', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.customer_id || !b.subject) return res.status(400).json({ error: 'Customer and subject are required' });
  const id = createTicket({ customer_id: Number(b.customer_id), site_id: b.site_id, subject: String(b.subject).slice(0, 200), body: b.body, priority: b.priority, opened_by: 'staff', author: (req.user && req.user.email) || '' });
  const num = db.prepare('SELECT number FROM tickets WHERE id=?').get(id).number;
  audit(req, 'create', 'ticket#' + id, num + ' ' + b.subject);
  res.json({ id, number: num });
});
app.post('/api/tickets/:id/reply', requireNoc, (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  const body = String((req.body || {}).body || '').trim(); if (!body) return res.status(400).json({ error: 'Enter a reply' });
  db.prepare("INSERT INTO ticket_messages (ticket_id,author_type,author,body) VALUES (?,?,?,?)").run(t.id, 'staff', (req.user && req.user.email) || '', body);
  db.prepare("UPDATE tickets SET updated_at=datetime('now'), status=CASE WHEN status IN ('resolved','closed') THEN status ELSE 'waiting' END WHERE id=?").run(t.id);
  const c = db.prepare('SELECT billing_email FROM customers WHERE id=?').get(t.customer_id) || {};
  if (c.billing_email) { const pub = pubBase(); mailSafe({ to: c.billing_email, subject: `Re: ${t.number} — ${t.subject}`, text: `${body}\n\nView your ticket: ${pub}/portal`, html: `<p>${nl2br(body)}</p><p><a href="${pub}/portal">View your ticket in the portal</a></p>` }); }
  audit(req, 'reply', 'ticket#' + t.id, t.number);
  res.json({ ok: true });
});
app.put('/api/tickets/:id', requireNoc, (req, res) => {
  const b = req.body || {}; const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  const status = TICKET_STATUS.includes(b.status) ? b.status : t.status;
  const priority = TICKET_PRIO.includes(b.priority) ? b.priority : t.priority;
  const wasClosed = ['resolved', 'closed'].includes(t.status), nowClosed = ['resolved', 'closed'].includes(status);
  db.prepare(`UPDATE tickets SET status=?, priority=?, assigned_to=?, updated_at=datetime('now')${nowClosed && !wasClosed ? ", closed_at=datetime('now')" : (!nowClosed ? ', closed_at=NULL' : '')} WHERE id=?`)
    .run(status, priority, b.assigned_to !== undefined ? N(b.assigned_to) : t.assigned_to, t.id);
  audit(req, 'edit', 'ticket#' + t.id, `${status}/${priority}`);
  res.json({ ok: true });
});
// portal (scoped to the signed-in customer)
app.get('/portal/api/tickets', requirePortal, (req, res) => {
  res.json(db.prepare("SELECT id,number,subject,status,priority,created_at,updated_at,(SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=tickets.id) AS msg_count FROM tickets WHERE customer_id=? ORDER BY updated_at DESC").all(req.pcust.id));
});
app.post('/portal/api/tickets', requirePortal, (req, res) => {
  const b = req.body || {}; const subject = String(b.subject || '').trim().slice(0, 200); const body = String(b.body || '').trim();
  if (!subject) return res.status(400).json({ error: 'Please enter a subject' });
  let siteId = null; if (b.site_id) { const s = db.prepare('SELECT id FROM sites WHERE id=? AND customer_id=?').get(Number(b.site_id), req.pcust.id); if (s) siteId = s.id; }
  const id = createTicket({ customer_id: req.pcust.id, site_id: siteId, subject, body, priority: b.priority, opened_by: 'customer', author: req.pcust.name });
  const num = db.prepare('SELECT number FROM tickets WHERE id=?').get(id).number;
  ticketNotify(`New support ticket ${num}: ${subject}`, `${req.pcust.name} opened ${num}:\n\n${body}`, `<p><b>${esc2(req.pcust.name)}</b> opened <b>${esc2(num)}</b>: ${esc2(subject)}</p><p>${nl2br(body)}</p>`);
  res.json({ ok: true, id, number: num });
});
app.get('/portal/api/tickets/:id', requirePortal, (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=? AND customer_id=?').get(req.params.id, req.pcust.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  t.messages = db.prepare('SELECT author_type, body, created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(t.id);
  res.json(t);
});
app.post('/portal/api/tickets/:id/reply', requirePortal, (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=? AND customer_id=?').get(req.params.id, req.pcust.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const body = String((req.body || {}).body || '').trim(); if (!body) return res.status(400).json({ error: 'Enter a message' });
  db.prepare("INSERT INTO ticket_messages (ticket_id,author_type,author,body) VALUES (?,?,?,?)").run(t.id, 'customer', req.pcust.name, body);
  db.prepare("UPDATE tickets SET updated_at=datetime('now'), status=CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END, closed_at=CASE WHEN status IN ('resolved','closed') THEN NULL ELSE closed_at END WHERE id=?").run(t.id);
  ticketNotify(`Reply on ${t.number}: ${t.subject}`, `${req.pcust.name} replied on ${t.number}:\n\n${body}`, `<p><b>${esc2(req.pcust.name)}</b> replied on <b>${esc2(t.number)}</b>:</p><p>${nl2br(body)}</p>`);
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
    // recurring invoices: generate (and optionally email) any that have come due — once/hour is plenty
    if (process.env.BILLING !== 'off' && _tickN % 60 === 1) {
      try { runRecurringBilling(); } catch (e) { console.warn('recurring billing failed:', e.message); }
    }
    // end-of-day auto check-out of any visitors still on site (once per day, at/after the configured time)
    const acAt = getSetting('auto_checkout_at');
    if (acAt && /^\d{1,2}:\d{2}$/.test(acAt)) {
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const cutoff = acAt.length === 4 ? '0' + acAt : acAt;
      if (hhmm >= cutoff && getSetting('last_auto_checkout') !== today) {
        const open = db.prepare('SELECT COUNT(*) AS n FROM visits WHERE check_out_at IS NULL').get().n;
        if (open > 0) {
          db.prepare("UPDATE visits SET check_out_at=datetime('now'), check_out_by='auto (end of day)' WHERE check_out_at IS NULL").run();
          db.prepare("INSERT INTO audit_log (actor,role,action,target,details) VALUES ('system','system','checkout','visits',?)").run('auto end-of-day: ' + open + ' visitor(s)');
        }
        setSetting('last_auto_checkout', today);
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

// ---- public site-access check-in (no login) ----
app.get('/access', (req, res) => res.sendFile(join(__dirname, 'public', 'access.html')));
// public site autocomplete (minimal: id + name only)
app.get('/access/sites', (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%';
  const rows = db.prepare('SELECT id, name FROM sites WHERE name LIKE ? ORDER BY name LIMIT 20').all(q);
  res.json(rows);
});
function saveIdPhoto(dataUrl) {
  let raw = String(dataUrl); const c = raw.indexOf(','); let mime = '';
  if (raw.startsWith('data:')) { mime = raw.slice(5, raw.indexOf(';')); if (c !== -1) raw = raw.slice(c + 1); }
  if (!ATT_MIME[mime]) return { error: 'ID photo must be an image or PDF', code: 400 };
  let buf; try { buf = Buffer.from(raw, 'base64'); } catch { return { error: 'bad photo data', code: 400 }; }
  if (buf.length > ATT_MAX) return { error: 'ID photo too large (max 25 MB)', code: 413 };
  const stored = 'idphoto-' + randomUUID() + ATT_MIME[mime];
  try { writeFileSync(join(UPLOADS_DIR, stored), buf); } catch { return { error: 'could not save photo', code: 500 }; }
  return { stored };
}
// copy a prior visitor's ID photo to a new file so a returning visit reuses it without re-scanning
function copyIdPhoto(srcStored) {
  if (!srcStored || !existsSync(join(UPLOADS_DIR, srcStored))) return null;
  const ext = '.' + (srcStored.split('.').pop() || 'jpg');
  const stored = 'idphoto-' + randomUUID() + ext;
  try { copyFileSync(join(UPLOADS_DIR, srcStored), join(UPLOADS_DIR, stored)); return stored; } catch { return null; }
}
app.post('/access', (req, res) => {
  const b = req.body || {};
  if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'First and last name are required' });
  if (!b.email && !b.phone) return res.status(400).json({ error: 'An email or phone is required' });
  let stored = null;
  if (b.id_photo) { const r = saveIdPhoto(b.id_photo); if (r.error) return res.status(r.code).json({ error: r.error }); stored = r.stored; }
  const info = db.prepare("INSERT INTO access_requests (first_name,last_name,email,phone,id_photo) VALUES (?,?,?,?,?)")
    .run(N(b.first_name), N(b.last_name), N(b.email), N(b.phone), stored);
  const ids = [...new Set((b.site_ids || (b.site_id ? [b.site_id] : [])).map(Number).filter(Boolean))];
  const ins = db.prepare('INSERT OR IGNORE INTO access_request_sites (request_id, site_id) VALUES (?,?)');
  for (const sid of ids) ins.run(info.lastInsertRowid, sid);
  db.prepare('INSERT INTO audit_log (actor, role, action, target, details) VALUES (?,?,?,?,?)').run((b.email || (b.first_name + ' ' + b.last_name)), 'public', 'access_request', 'access#' + info.lastInsertRowid, ids.length + ' site(s)');
  // notify staff mailbox
  const notify = getSetting('access_notify_email');
  if (notify) {
    const siteNames = accessSites(info.lastInsertRowid).map(s => s.name).join(', ') || '(none)';
    const who = `${b.first_name} ${b.last_name}`;
    const contact = [b.email, b.phone].filter(Boolean).join(' · ');
    const reviewUrl = (getSetting('public_base_url') || '').replace(/\/+$/, '') + '/#/access';
    mailSafe({
      to: notify, subject: `New site access request: ${who}`,
      text: `New site access request\n\nName: ${who}\nContact: ${contact}\nSite(s): ${siteNames}\nID photo: ${stored ? 'attached (view in app)' : 'none'}\n\nReview: ${reviewUrl}`,
      html: `<h2>New site access request</h2><p><b>Name:</b> ${who}<br><b>Contact:</b> ${contact || '—'}<br><b>Site(s):</b> ${siteNames}<br><b>ID photo:</b> ${stored ? 'attached (view in app)' : 'none'}</p><p><a href="${reviewUrl}">Review in the platform</a></p>`
    });
  }
  res.json({ ok: true, id: info.lastInsertRowid });
});
function accessSites(reqId) { return db.prepare('SELECT s.id, s.name FROM access_request_sites ars JOIN sites s ON s.id=ars.site_id WHERE ars.request_id=?').all(reqId); }
const openVisit = reqId => db.prepare('SELECT * FROM visits WHERE request_id=? AND check_out_at IS NULL ORDER BY id DESC LIMIT 1').get(reqId);
app.get('/api/access', requireNoc, (req, res) => {
  const rows = db.prepare('SELECT id, first_name, last_name, email, phone, status, reviewed_by, reviewed_at, notes, created_at, (id_photo IS NOT NULL) AS has_photo FROM access_requests ORDER BY (status=\'pending\') DESC, datetime(created_at) DESC').all();
  for (const r of rows) {
    r.sites = accessSites(r.id);
    const ov = openVisit(r.id);
    r.on_site = !!ov; r.checkin_at = ov ? ov.check_in_at : null;
    const last = db.prepare('SELECT check_in_at, check_out_at FROM visits WHERE request_id=? ORDER BY id DESC LIMIT 1').get(r.id);
    r.last_visit = last || null;
    r.visit_count = db.prepare('SELECT COUNT(*) AS n FROM visits WHERE request_id=?').get(r.id).n;
  }
  res.json(rows);
});
app.get('/api/access/:id/visits', requireNoc, (req, res) => {
  res.json(db.prepare('SELECT * FROM visits WHERE request_id=? ORDER BY id DESC').all(req.params.id));
});
app.post('/api/access/:id/checkin', requireNoc, (req, res) => {
  const r = db.prepare('SELECT id FROM access_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (openVisit(r.id)) return res.status(409).json({ error: 'Already checked in' });
  db.prepare("INSERT INTO visits (request_id, check_in_at, check_in_by) VALUES (?, datetime('now'), ?)").run(r.id, (req.user && req.user.email) || '');
  audit(req, 'checkin', 'access#' + r.id);
  res.json({ ok: true });
});
app.post('/api/access/:id/checkout', requireNoc, (req, res) => {
  const ov = openVisit(req.params.id);
  if (!ov) return res.status(409).json({ error: 'Not checked in' });
  db.prepare("UPDATE visits SET check_out_at=datetime('now'), check_out_by=? WHERE id=?").run((req.user && req.user.email) || '', ov.id);
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(req.params.id);
  if (r && r.email) {
    const siteNames = accessSites(r.id).map(s => s.name).join(', ') || 'the site';
    mailSafe({ to: r.email, subject: 'Site check-out confirmation', text: `Hi ${r.first_name},\n\nYou have been checked out of ${siteNames}. Thank you for visiting.`, html: `<p>Hi ${r.first_name},</p><p>You have been checked out of <b>${siteNames}</b>. Thank you for visiting.</p>` });
  }
  audit(req, 'checkout', 'access#' + req.params.id);
  res.json({ ok: true });
});
// Staff-created visitor + immediate check-in (no public form). Can reuse a prior visitor's ID photo.
app.post('/api/access/manual', requireNoc, (req, res) => {
  const b = req.body || {};
  if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'First and last name are required' });
  let stored = null;
  if (b.reuse_photo_from) {
    const src = db.prepare('SELECT id_photo FROM access_requests WHERE id=?').get(b.reuse_photo_from);
    if (src && src.id_photo) stored = copyIdPhoto(src.id_photo);
  } else if (b.id_photo) {
    const r = saveIdPhoto(b.id_photo); if (r.error) return res.status(r.code).json({ error: r.error }); stored = r.stored;
  }
  const me = (req.user && req.user.email) || '';
  const info = db.prepare("INSERT INTO access_requests (first_name,last_name,email,phone,id_photo,status,reviewed_by,reviewed_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
    .run(N(b.first_name), N(b.last_name), N(b.email), N(b.phone), stored, 'approved', me);
  const ids = [...new Set((b.site_ids || []).map(Number).filter(Boolean))];
  const insS = db.prepare('INSERT OR IGNORE INTO access_request_sites (request_id, site_id) VALUES (?,?)');
  for (const sid of ids) insS.run(info.lastInsertRowid, sid);
  if (b.check_in !== false) db.prepare("INSERT INTO visits (request_id, check_in_at, check_in_by) VALUES (?, datetime('now'), ?)").run(info.lastInsertRowid, me);
  audit(req, 'access_manual', 'access#' + info.lastInsertRowid, (b.reuse_photo_from ? 'reused photo · ' : '') + ids.length + ' site(s)');
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.get('/api/access/:id/photo', requireNoc, (req, res) => {
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(req.params.id);
  if (!r || !r.id_photo) return res.status(404).json({ error: 'no photo' });
  const fp = join(UPLOADS_DIR, r.id_photo);
  if (!existsSync(fp)) return res.status(404).json({ error: 'file missing' });
  const ext = (r.id_photo.split('.').pop() || '').toLowerCase();
  const mime = ext === 'pdf' ? 'application/pdf' : (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'heic' ? 'image/heic' : ext === 'heif' ? 'image/heif' : 'image/jpeg');
  audit(req, 'access_read', 'access#' + r.id, 'ID photo');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', statSync(fp).size);
  res.setHeader('Content-Disposition', 'inline');
  createReadStream(fp).pipe(res);
});
app.put('/api/access/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (b.status && ['pending', 'approved', 'denied'].includes(b.status)) {
    db.prepare("UPDATE access_requests SET status=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(b.status, (req.user && req.user.email) || '', r.id);
    if ((b.status === 'approved' || b.status === 'denied') && r.email) {
      const siteNames = accessSites(r.id).map(s => s.name).join(', ') || 'the requested site';
      if (b.status === 'approved') mailSafe({
        to: r.email, subject: 'Your site access request is approved',
        text: `Hi ${r.first_name},\n\nYour request for access to ${siteNames} has been approved.\n\nThank you.`,
        html: `<p>Hi ${r.first_name},</p><p>Your request for access to <b>${siteNames}</b> has been <b>approved</b>.</p><p>Thank you.</p>`
      });
      else mailSafe({
        to: r.email, subject: 'Your site access request',
        text: `Hi ${r.first_name},\n\nYour request for access to ${siteNames} was not approved. Please contact us if you have questions.\n\nThank you.`,
        html: `<p>Hi ${r.first_name},</p><p>Your request for access to <b>${siteNames}</b> was <b>not approved</b>. Please contact us if you have questions.</p><p>Thank you.</p>`
      });
    }
  }
  if (b.notes !== undefined) db.prepare('UPDATE access_requests SET notes=? WHERE id=?').run(N(b.notes), r.id);
  audit(req, 'edit', 'access#' + r.id, b.status || 'note');
  res.json({ ok: true });
});
app.delete('/api/access/:id', requireNoc, (req, res) => {
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.id_photo) { try { unlinkSync(join(UPLOADS_DIR, r.id_photo)); } catch {} }
  db.prepare('DELETE FROM access_request_sites WHERE request_id=?').run(r.id);
  db.prepare('DELETE FROM access_requests WHERE id=?').run(r.id);
  audit(req, 'delete', 'access#' + r.id);
  res.json({ ok: true });
});

// ---- static frontend ----
app.use(express.static(join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Network Inventory Platform running on http://localhost:${PORT}`));
