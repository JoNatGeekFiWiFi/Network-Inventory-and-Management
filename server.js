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
import { r2, todayStr, esc2, normPhone } from './lib/core.js';
import registerBilling from './domains/billing.js';
import registerSupport from './domains/support.js';
import registerNetwork from './domains/network.js';
import registerFiber from './domains/fiber.js';

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

// Reject malformed percent-encoding before anything tries to decode it. Internet scanners
// probe constantly with junk like '/.env.local.txt%85'; without this, serve-static (and any
// route with a :param) throws a URIError and dumps a stack trace per hit, burying real errors
// in the log. Answer 400 quietly instead. Must be first so it covers every route.
app.use((req, res, next) => {
  try { decodeURIComponent(req.path); return next(); }
  catch { return res.status(400).type('text/plain').send('Bad Request'); }
});

// Stripe webhook needs the RAW body for signature verification, so it registers before the JSON parser
// handler lives in domains/billing.js; resolved at request time via ctx (registration must stay here,
// ahead of the JSON parser, because Stripe signs the raw body)
app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => ctx.jobs.stripeWebhook(req, res));
// Telnyx signs the RAW request body (Ed25519), so it too must precede the JSON parser
app.post('/inbound/telnyx/:secret', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => ctx.jobs.inboundTelnyx(req, res));
app.use(express.json({ limit: '60mb' })); // raised so base64 note attachments + .npk package uploads fit
app.use(express.urlencoded({ extended: false, limit: '10mb' })); // Twilio + Mailgun inbound post form-encoded

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
// Brute-force throttle for the internet-facing logins. In-memory sliding window keyed by IP+identifier.
const _loginHits = new Map();
function loginThrottle(req, key, { max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const k = ip + '|' + key; const now = Date.now();
  const hits = (_loginHits.get(k) || []).filter(t => now - t < windowMs);
  if (_loginHits.size > 5000) _loginHits.clear(); // crude cap so it can't grow unbounded
  if (hits.length >= max) { _loginHits.set(k, hits); return Math.ceil((windowMs - (now - hits[0])) / 60000); }
  hits.push(now); _loginHits.set(k, hits); return 0;
}
const loginSucceeded = (req, key) => { const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; _loginHits.delete(ip + '|' + key); };
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const ident = (email || '').toLowerCase().trim();
  const wait = loginThrottle(req, 'staff:' + ident);
  if (wait) return res.status(429).json({ error: `Too many attempts — try again in ${wait} minute(s)` });
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(ident);
  if (!u || !verifyPassword(password, u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  loginSucceeded(req, 'staff:' + ident);
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
async function sendMail({ to, subject, text, html, replyTo, headers }) {
  const host = getSetting('smtp_host'), from = getSetting('mail_from');
  if (!host || !from || !to) return false;
  const tx = nodemailer.createTransport({
    host, port: parseInt(getSetting('smtp_port'), 10) || 587, secure: getSetting('smtp_secure') === '1',
    auth: getSetting('smtp_user') ? { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') || '' } : undefined
  });
  const info = await tx.sendMail({ from, to, subject, text, html, replyTo, headers });
  return info && info.messageId ? info.messageId : true;
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
    backup_enable_ssh: getSetting('backup_enable_ssh') !== '0',
    mgmt_overlay_cidr: getSetting('mgmt_overlay_cidr') || '',
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
    quote_next: getSetting('quote_next') || '1001',
    // omnichannel messaging
    sms_provider: getSetting('sms_provider') || 'twilio',
    whatsapp_provider: getSetting('whatsapp_provider') || 'twilio',
    twilio_sid: getSetting('twilio_sid') || '',
    twilio_sms_from: getSetting('twilio_sms_from') || '',
    twilio_wa_from: getSetting('twilio_wa_from') || '',
    has_twilio_token: !!getSetting('twilio_token'),
    telnyx_sms_from: getSetting('telnyx_sms_from') || '',
    telnyx_wa_from: getSetting('telnyx_wa_from') || '',
    telnyx_profile: getSetting('telnyx_profile') || '',
    has_telnyx_key: !!getSetting('telnyx_key'),
    email_inbound_method: getSetting('email_inbound_method') || 'imap',
    imap_host: getSetting('imap_host') || '',
    imap_port: getSetting('imap_port') || '993',
    imap_user: getSetting('imap_user') || '',
    imap_tls: getSetting('imap_tls') !== '0',
    has_imap_pass: !!getSetting('imap_pass'),
    inbound_secret: getSetting('inbound_secret') || '',
    public_base_url_effective: ctx.pubBase()
  });
});
app.put('/api/settings', requireNoc, (req, res) => {
  const b = req.body || {};
  for (const k of ['zt_network_id', 'wg_endpoint', 'wg_subnet', 'wg_dns', 'backup_upload_base', 'mgmt_overlay_cidr', 'public_base_url', 'prov_wifi_ssid', 'smtp_host', 'smtp_port', 'smtp_user', 'mail_from', 'access_notify_email', 'auto_checkout_at']) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  if (b.backup_enable_ssh !== undefined) setSetting('backup_enable_ssh', b.backup_enable_ssh ? '1' : '0');
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
  // omnichannel messaging config
  for (const k of ['twilio_sid', 'twilio_sms_from', 'twilio_wa_from', 'telnyx_sms_from', 'telnyx_wa_from', 'telnyx_profile', 'imap_host', 'imap_port', 'imap_user']) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  if (b.sms_provider !== undefined) setSetting('sms_provider', b.sms_provider === 'telnyx' ? 'telnyx' : 'twilio');
  if (b.whatsapp_provider !== undefined) setSetting('whatsapp_provider', b.whatsapp_provider === 'telnyx' ? 'telnyx' : 'twilio');
  if (b.email_inbound_method !== undefined) setSetting('email_inbound_method', b.email_inbound_method === 'webhook' ? 'webhook' : 'imap');
  if (b.imap_tls !== undefined) setSetting('imap_tls', b.imap_tls ? '1' : '0');
  if (b.twilio_token) setSetting('twilio_token', String(b.twilio_token).trim());
  if (b.telnyx_key) setSetting('telnyx_key', String(b.telnyx_key).trim());
  if (b.imap_pass) setSetting('imap_pass', String(b.imap_pass));
  if (!getSetting('inbound_secret')) setSetting('inbound_secret', randomUUID().replace(/-/g, '')); // path-gate secret for inbound webhooks
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
      const wf = await ctx.readWifi(d);
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
function publicDevice(d) {
  const out = { ...d };
  for (const f of ALL_CREDS) { out['has_' + f] = !!out[f]; delete out[f]; }
  out.wg_provisioned = !!out.wg_private_key;
  delete out.wg_private_key; // only released via the audited config endpoint
  if (out.owner_subaccount_id) {
    const sa = db.prepare('SELECT sa.name, a.name AS account_name FROM account_subaccounts sa JOIN accounts a ON a.id=sa.account_id WHERE sa.id=?').get(out.owner_subaccount_id);
    if (sa) { out.owner_subaccount_name = sa.name; out.owner_subaccount_account = sa.account_name; }
  }
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
  a.subaccounts = db.prepare('SELECT * FROM account_subaccounts WHERE account_id=? ORDER BY id').all(a.id).map(s => subAcctOut(s, req));
  if (!isPriv(req)) { delete a.pin; delete a.portal_password; delete a.security_questions; } // sensitive: NOC/Admin only
  res.json(a);
});
// PIN is NOC/Admin-only, mirror the account pattern
function subAcctOut(s, req) { const o = { ...s, has_pin: !!s.pin }; if (!isPriv(req)) delete o.pin; return o; }

app.post('/api/accounts', requireNoc, (req, res) => {
  const b = req.body || {};
  const cost = b.monthly_cost === '' || b.monthly_cost == null ? null : Math.max(0, parseFloat(b.monthly_cost) || 0);
  const info = db.prepare('INSERT INTO accounts (name, account_number, sub_account, pin, email, portal_url, portal_password, security_questions, status, billing_address, notes, monthly_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(N(b.name), N(b.account_number), N(b.sub_account), N(b.pin), N(b.email), N(b.portal_url), N(b.portal_password), N(b.security_questions), b.status || 'Active', N(b.billing_address), N(b.notes), cost);
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
  if (b.monthly_cost !== undefined) db.prepare('UPDATE accounts SET monthly_cost=? WHERE id=?').run(b.monthly_cost === '' ? null : Math.max(0, parseFloat(b.monthly_cost) || 0), req.params.id);
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
  db.prepare('DELETE FROM account_subaccounts WHERE account_id=?').run(req.params.id);
  audit(req, 'delete', 'account#' + req.params.id);
  res.json({ ok: true });
});

// ---- sub-accounts (many per account; each with its own PIN, status, monthly bill) ----
const SUBACCT_STATUS = ['active', 'suspended', 'closed'];
app.get('/api/accounts/:id/subaccounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM account_subaccounts WHERE account_id=? ORDER BY id').all(req.params.id).map(s => subAcctOut(s, req)));
});
// flat list across all accounts (for the device ownership picker)
app.get('/api/subaccounts', (req, res) => {
  res.json(db.prepare('SELECT sa.id, sa.account_id, sa.name, sa.status, a.name AS account_name FROM account_subaccounts sa JOIN accounts a ON a.id=sa.account_id ORDER BY a.name, sa.name').all());
});
app.post('/api/accounts/:id/subaccounts', requireNoc, (req, res) => {
  const a = db.prepare('SELECT id FROM accounts WHERE id=?').get(req.params.id); if (!a) return res.status(404).json({ error: 'account not found' });
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: 'Sub-account number/name required' });
  const status = SUBACCT_STATUS.includes(b.status) ? b.status : 'active';
  const cost = b.monthly_cost === '' || b.monthly_cost == null ? null : Math.max(0, parseFloat(b.monthly_cost) || 0);
  const info = db.prepare('INSERT INTO account_subaccounts (account_id,name,pin,status,monthly_cost,notes) VALUES (?,?,?,?,?,?)')
    .run(a.id, String(b.name).slice(0, 120), N(b.pin) || null, status, cost, N(b.notes) || null);
  audit(req, 'create', 'account#' + a.id, 'sub-account ' + b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/accounts/:id/subaccounts/:sid', requireNoc, (req, res) => {
  const ex = db.prepare('SELECT * FROM account_subaccounts WHERE id=? AND account_id=?').get(req.params.sid, req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const status = SUBACCT_STATUS.includes(b.status) ? b.status : ex.status;
  const cost = b.monthly_cost === '' ? null : (b.monthly_cost == null ? ex.monthly_cost : Math.max(0, parseFloat(b.monthly_cost) || 0));
  db.prepare('UPDATE account_subaccounts SET name=?, status=?, monthly_cost=?, notes=? WHERE id=?')
    .run(N(b.name, ex.name), status, cost, N(b.notes) || null, ex.id);
  if (b.pin) db.prepare('UPDATE account_subaccounts SET pin=? WHERE id=?').run(String(b.pin), ex.id); // blank = keep
  audit(req, 'edit', 'account#' + req.params.id, 'sub-account#' + ex.id);
  res.json({ ok: true });
});
app.delete('/api/accounts/:id/subaccounts/:sid', requireNoc, (req, res) => {
  const ex = db.prepare('SELECT id FROM account_subaccounts WHERE id=? AND account_id=?').get(req.params.sid, req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE sites SET subaccount_id=NULL WHERE subaccount_id=?').run(ex.id);       // don't orphan references
  db.prepare('UPDATE devices SET owner_subaccount_id=NULL WHERE owner_subaccount_id=?').run(ex.id);
  db.prepare('DELETE FROM account_subaccounts WHERE id=?').run(ex.id);
  audit(req, 'delete', 'account#' + req.params.id, 'sub-account#' + ex.id);
  res.json({ ok: true });
});

// ---- sites ----
// returns the sub-account id only if it belongs to the given account, else null (prevents cross-account refs)
function subaccountForAccount(subId, accountId) {
  if (!subId) return null;
  const r = db.prepare('SELECT id FROM account_subaccounts WHERE id=? AND account_id=?').get(Number(subId), Number(accountId));
  return r ? r.id : null;
}
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
  out.subaccount = s.subaccount_id ? db.prepare('SELECT id, name, status FROM account_subaccounts WHERE id=?').get(s.subaccount_id) : null;
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
  if (c.circuit_ref_id) { // optional link to the consolidated circuit inventory
    const ck = db.prepare('SELECT id,label,circuit_id,bandwidth,status FROM circuits WHERE id=?').get(c.circuit_ref_id);
    c.circuit = ck ? { id: ck.id, label: ck.label || ck.circuit_id || 'Circuit', bandwidth: ck.bandwidth, status: ck.status } : null;
  }
  return c;
}

app.post('/api/sites', (req, res) => {
  const b = req.body || {};
  // a site is served by one account chosen from its customer's accounts (defaults to the customer's primary)
  const accountId = b.account_id || defaultAccountForCustomer(b.customer_id);
  if (!accountId) return res.status(400).json({ error: 'A customer (with at least one account) is required' });
  const subId = subaccountForAccount(b.subaccount_id, accountId); // only keep if it belongs to this account
  const info = db.prepare('INSERT INTO sites (account_id,customer_id,name,service_address,lat,lng,status,current_mgmt_ip,current_public_ip,notes,subaccount_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(N(accountId), N(b.customer_id || null), N(b.name), N(b.service_address), N(b.lat || null), N(b.lng || null), b.status || 'Active', N(b.current_mgmt_ip), N(b.current_public_ip), N(b.notes), subId);
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
  const subId = b.subaccount_id !== undefined ? subaccountForAccount(b.subaccount_id, accountId) : (subaccountForAccount(ex.subaccount_id, accountId)); // clear if it no longer belongs to the account
  db.prepare('UPDATE sites SET account_id=?, customer_id=?, name=?, service_address=?, lat=?, lng=?, status=?, current_mgmt_ip=?, current_public_ip=?, notes=?, subaccount_id=? WHERE id=?')
    .run(N(accountId), N(customerId || null), N(b.name, ex.name), N(b.service_address, ex.service_address),
         b.lat === undefined ? ex.lat : (b.lat || null), b.lng === undefined ? ex.lng : (b.lng || null),
         N(b.status, ex.status), N(b.current_mgmt_ip, ex.current_mgmt_ip), N(b.current_public_ip, ex.current_public_ip), N(b.notes, ex.notes), subId, req.params.id);
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
  const info = db.prepare('INSERT INTO customers (account_id,name,status,notes,billing_email,sms_number,whatsapp_number,preferred_channel) VALUES (?,?,?,?,?,?,?,?)')
    .run(ids[0], N(b.name), b.status || 'Active', N(b.notes), N(b.billing_email), N(normPhone(b.sms_number) || null), N(normPhone(b.whatsapp_number) || null), N(['email', 'sms', 'whatsapp'].includes(b.preferred_channel) ? b.preferred_channel : null));
  setCustomerAccounts(info.lastInsertRowid, ids);
  audit(req, 'create', 'customer#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/customers/:id', requireNoc, (req, res) => {
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE customers SET name=?, status=?, notes=?, billing_email=? WHERE id=?').run(N(b.name, ex.name), N(b.status, ex.status), N(b.notes), N(b.billing_email, ex.billing_email), req.params.id);
  if (b.sms_number !== undefined) db.prepare('UPDATE customers SET sms_number=? WHERE id=?').run(normPhone(b.sms_number) || null, req.params.id);
  if (b.whatsapp_number !== undefined) db.prepare('UPDATE customers SET whatsapp_number=? WHERE id=?').run(normPhone(b.whatsapp_number) || null, req.params.id);
  if (b.preferred_channel !== undefined) db.prepare('UPDATE customers SET preferred_channel=? WHERE id=?').run(['email', 'sms', 'whatsapp'].includes(b.preferred_channel) ? b.preferred_channel : null, req.params.id);
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
  const id = req.params.id;
  // Refuse while anything still points at this customer — deleting used to silently orphan
  // invoices/quotes/tickets AND leave recurring schedules that kept generating invoices forever.
  const blockers = [];
  const n = (sql) => db.prepare(sql).get(id).n;
  const sites = n('SELECT COUNT(*) AS n FROM sites WHERE customer_id=?'); if (sites) blockers.push(`${sites} site(s)`);
  const invs = n('SELECT COUNT(*) AS n FROM bill_invoices WHERE customer_id=?'); if (invs) blockers.push(`${invs} invoice(s)`);
  const quotes = n('SELECT COUNT(*) AS n FROM bill_quotes WHERE customer_id=?'); if (quotes) blockers.push(`${quotes} quote(s)`);
  const recs = n('SELECT COUNT(*) AS n FROM bill_recurring WHERE customer_id=?'); if (recs) blockers.push(`${recs} recurring schedule(s)`);
  const tix = n('SELECT COUNT(*) AS n FROM tickets WHERE customer_id=?'); if (tix) blockers.push(`${tix} ticket(s)`);
  if (blockers.length) return res.status(409).json({ error: `In use by ${blockers.join(', ')} — reassign or delete those first` });
  db.prepare('DELETE FROM account_customers WHERE customer_id=?').run(id);
  db.prepare('DELETE FROM portal_sessions WHERE customer_id=?').run(id);
  db.prepare('DELETE FROM portal_login_tokens WHERE customer_id=?').run(id);
  db.prepare('DELETE FROM customers WHERE id=?').run(id);
  audit(req, 'delete', 'customer#' + id);
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
  out.notes = withNoteAttachments(db.prepare('SELECT * FROM pop_notes WHERE pop_id=? ORDER BY datetime(created_at) DESC').all(p.id));
  res.json(out);
});
// NOTE: POP upstream feeds used to live in `pop_circuits` with their own CRUD here. They were merged
// into the single `circuits` inventory (see db.js 'popcircuits_merged'); use /api/circuits?ref=pop:<id>.

// ---- circuits (standalone A<->Z inventory; endpoints are site | pop | carrier) ----
// 'carrier' = upstream_providers lookup (brokered transit). 'account' = a real carrier/distributor
// account you hold (Cox etc, with account numbers + sub-accounts) — POP upstream feeds use these.
const CIRCUIT_ENDPOINT_TYPES = ['site', 'pop', 'carrier', 'account', 'structure'];
const CIRCUIT_STATUS = ['Up', 'Standby', 'Down', 'Planned', 'Decommissioned'];
function endpointName(type, refId) {
  if (!refId) return null;
  if (type === 'site') { const r = db.prepare('SELECT name FROM sites WHERE id=?').get(refId); return r ? r.name : null; }
  if (type === 'pop') { const r = db.prepare('SELECT name FROM pops WHERE id=?').get(refId); return r ? r.name : null; }
  if (type === 'carrier') { const r = db.prepare('SELECT name FROM upstream_providers WHERE id=?').get(refId); return r ? r.name : null; }
  if (type === 'account') { const r = db.prepare('SELECT name FROM accounts WHERE id=?').get(refId); return r ? r.name : null; }
  if (type === 'structure') { const r = db.prepare('SELECT name FROM fiber_structures WHERE id=?').get(refId); return r ? r.name : null; }
  return null;
}
const endpointHref = (type, refId) => (type === 'site' ? '#/site/' + refId : type === 'pop' ? '#/pop/' + refId : type === 'account' ? '#/account/' + refId : type === 'structure' ? '#/fiber/structure/' + refId : null);
const INTERNAL_ENDPOINTS = ['site', 'pop', 'structure']; // at least one end must be our own plant
function decorateCircuit(c) {
  return {
    ...c,
    a_name: endpointName(c.a_type, c.a_ref_id), a_href: endpointHref(c.a_type, c.a_ref_id),
    z_name: endpointName(c.z_type, c.z_ref_id), z_href: endpointHref(c.z_type, c.z_ref_id),
    provider_name: c.provider_id ? (db.prepare('SELECT name FROM upstream_providers WHERE id=?').get(c.provider_id) || {}).name : null
  };
}
// validate + normalize an endpoint from the request body ({a_type,a_ref_id} etc)
function validEndpoint(type, refId) {
  if (!CIRCUIT_ENDPOINT_TYPES.includes(type)) return { error: 'endpoint type must be site, pop, or carrier' };
  if (!refId) return { error: 'pick an endpoint' };
  if (!endpointName(type, refId)) return { error: 'endpoint not found' };
  return { ok: true };
}
app.get('/api/circuits-options', (req, res) => {
  res.json({
    sites: db.prepare('SELECT id, name FROM sites ORDER BY name').all(),
    pops: db.prepare('SELECT id, name FROM pops ORDER BY name').all(),
    carriers: db.prepare('SELECT id, name FROM upstream_providers ORDER BY name').all(),
    accounts: db.prepare('SELECT id, name FROM accounts ORDER BY name').all()
  });
});
app.get('/api/circuits', (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%'; const st = String(req.query.status || '');
  let rows = db.prepare('SELECT * FROM circuits ORDER BY id DESC').all().map(decorateCircuit);
  if (req.query.ref) { const [t, idr] = String(req.query.ref).split(':'); const rid = Number(idr); rows = rows.filter(c => (c.a_type === t && c.a_ref_id === rid) || (c.z_type === t && c.z_ref_id === rid)); }
  if (st) rows = rows.filter(c => c.status === st);
  if (req.query.q) { const needle = String(req.query.q).toLowerCase(); rows = rows.filter(c => [c.label, c.circuit_id, c.a_name, c.z_name, c.provider_name, c.bandwidth, c.ctype].some(x => (x || '').toLowerCase().includes(needle))); }
  res.json(rows);
});
app.get('/api/circuits/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM circuits WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const out = decorateCircuit(c);
  // fibre strands carrying this circuit (set by the IQGeo importer or by hand)
  out.strands = db.prepare(`SELECT s.id, s.position, s.color, s.tube, s.status, s.label,
      cb.id AS cable_id, cb.name AS cable_name, cb.strand_count
    FROM fiber_strands s JOIN fiber_cables cb ON cb.id=s.cable_id
    WHERE s.assigned_type='circuit' AND s.assigned_id=? ORDER BY cb.name, s.position`).all(c.id);
  res.json(out);
});
function circuitFromBody(b) {
  const a = validEndpoint(b.a_type, Number(b.a_ref_id) || null); if (a.error) return { error: 'A-end: ' + a.error };
  const z = validEndpoint(b.z_type, Number(b.z_ref_id) || null); if (z.error) return { error: 'Z-end: ' + z.error };
  if (!INTERNAL_ENDPOINTS.includes(b.a_type) && !INTERNAL_ENDPOINTS.includes(b.z_type)) return { error: 'At least one end must be your own site or POP' };
  if (b.a_type === b.z_type && Number(b.a_ref_id) === Number(b.z_ref_id)) return { error: 'A circuit needs two different endpoints' };
  const status = CIRCUIT_STATUS.includes(b.status) ? b.status : 'Up';
  const cost = b.monthly_cost === '' || b.monthly_cost == null ? null : Math.max(0, parseFloat(b.monthly_cost) || 0) || null;
  return { vals: { label: N(b.label) || null, a_type: b.a_type, a_ref_id: Number(b.a_ref_id), z_type: b.z_type, z_ref_id: Number(b.z_ref_id), provider_id: b.provider_id ? Number(b.provider_id) : null, circuit_id: N(b.circuit_id) || null, ctype: N(b.ctype) || null, bandwidth: N(b.bandwidth) || null, status, monthly_cost: cost, install_date: N(b.install_date) || null, notes: N(b.notes) || null } };
}
app.post('/api/circuits', requireNoc, (req, res) => {
  const r = circuitFromBody(req.body || {}); if (r.error) return res.status(400).json({ error: r.error });
  const v = r.vals;
  const info = db.prepare(`INSERT INTO circuits (label,a_type,a_ref_id,z_type,z_ref_id,provider_id,circuit_id,ctype,bandwidth,status,monthly_cost,install_date,notes)
    VALUES (@label,@a_type,@a_ref_id,@z_type,@z_ref_id,@provider_id,@circuit_id,@ctype,@bandwidth,@status,@monthly_cost,@install_date,@notes)`).run(v);
  audit(req, 'create', 'circuit#' + info.lastInsertRowid, v.label || (endpointName(v.a_type, v.a_ref_id) + ' ↔ ' + endpointName(v.z_type, v.z_ref_id)));
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/circuits/:id', requireNoc, (req, res) => {
  const ex = db.prepare('SELECT * FROM circuits WHERE id=?').get(req.params.id); if (!ex) return res.status(404).json({ error: 'not found' });
  const r = circuitFromBody(req.body || {}); if (r.error) return res.status(400).json({ error: r.error });
  const v = r.vals;
  db.prepare(`UPDATE circuits SET label=@label,a_type=@a_type,a_ref_id=@a_ref_id,z_type=@z_type,z_ref_id=@z_ref_id,provider_id=@provider_id,circuit_id=@circuit_id,ctype=@ctype,bandwidth=@bandwidth,status=@status,monthly_cost=@monthly_cost,install_date=@install_date,notes=@notes WHERE id=@id`).run({ ...v, id: Number(req.params.id) });
  audit(req, 'edit', 'circuit#' + req.params.id, v.label || '');
  res.json({ ok: true });
});
app.delete('/api/circuits/:id', requireNoc, (req, res) => {
  db.prepare('DELETE FROM circuits WHERE id=?').run(req.params.id);
  audit(req, 'delete', 'circuit#' + req.params.id);
  res.json({ ok: true });
});

// ---- patch panel documentation (per site or POP; opt-in) ----
const PATCH_PORT_STATUS = ['free', 'used', 'reserved'];
function patchParent(type, id) {
  if (type === 'site') return db.prepare('SELECT id, name, patch_enabled FROM sites WHERE id=?').get(id);
  if (type === 'pop') return db.prepare('SELECT id, name, patch_enabled FROM pops WHERE id=?').get(id);
  return null;
}
// the site's/POP's devices + circuits, formatted for the per-port dropdowns
function patchContext(type, id) {
  if (type === 'site') {
    const devices = db.prepare("SELECT id, name FROM devices WHERE assigned_type='site' AND assigned_site_id=? ORDER BY name").all(id);
    const circuits = db.prepare('SELECT * FROM connections WHERE site_id=? ORDER BY priority').all(id).map(resolveConn)
      .map(c => ({ id: c.id, label: `${c.role}${c.served_label ? ' · ' + c.served_label : ''}${c.static_ip ? ' · ' + c.static_ip : (c.current_ip ? ' · ' + c.current_ip : '')}` }));
    return { devices, circuits };
  }
  const devices = db.prepare("SELECT id, name FROM devices WHERE assigned_type='pop' AND assigned_pop_id=? ORDER BY name").all(id);
  // circuits touching this POP (either end), from the consolidated inventory
  const circuits = db.prepare('SELECT * FROM circuits WHERE (a_type=? AND a_ref_id=?) OR (z_type=? AND z_ref_id=?) ORDER BY id')
    .all('pop', id, 'pop', id).map(decorateCircuit).map(c => {
      const far = (c.a_type === 'pop' && Number(c.a_ref_id) === Number(id)) ? c.z_name : c.a_name;
      return { id: c.id, label: `${c.label || c.circuit_id || far || 'Circuit'}${c.bandwidth ? ' · ' + c.bandwidth : ''}` };
    });
  return { devices, circuits };
}
function loadPanels(type, id) {
  const panels = db.prepare('SELECT * FROM patch_panels WHERE parent_type=? AND parent_id=? ORDER BY id').all(type, id);
  for (const p of panels) p.used_ports = db.prepare('SELECT * FROM patch_ports WHERE panel_id=? ORDER BY port_no').all(p.id);
  return panels;
}
app.get('/api/patch/:type/:id', (req, res) => {
  const { type, id } = req.params; const parent = patchParent(type, id);
  if (!parent) return res.status(404).json({ error: 'not found' });
  const ctx = patchContext(type, id);
  res.json({ parent: { id: parent.id, name: parent.name, type }, enabled: !!parent.patch_enabled, panels: loadPanels(type, id), devices: ctx.devices, circuits: ctx.circuits });
});
app.post('/api/patch/:type/:id/enable', requireNoc, (req, res) => {
  const { type, id } = req.params; const parent = patchParent(type, id); if (!parent) return res.status(404).json({ error: 'not found' });
  const on = (req.body || {}).enabled ? 1 : 0;
  db.prepare(`UPDATE ${type === 'pop' ? 'pops' : 'sites'} SET patch_enabled=? WHERE id=?`).run(on, id);
  audit(req, 'edit', type + '#' + id, 'patch panels ' + (on ? 'enabled' : 'disabled'));
  res.json({ ok: true, enabled: !!on });
});
app.post('/api/patch/:type/:id/panels', requireNoc, (req, res) => {
  const { type, id } = req.params; const parent = patchParent(type, id); if (!parent) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: 'Panel name required' });
  const ports = Math.min(Math.max(parseInt(b.ports, 10) || 24, 1), 288);
  const info = db.prepare('INSERT INTO patch_panels (parent_type,parent_id,name,location,ports,notes) VALUES (?,?,?,?,?,?)').run(type, id, String(b.name).slice(0, 120), N(b.location), ports, N(b.notes));
  if (!parent.patch_enabled) db.prepare(`UPDATE ${type === 'pop' ? 'pops' : 'sites'} SET patch_enabled=1 WHERE id=?`).run(id);
  audit(req, 'create', type + '#' + id, 'patch panel ' + b.name);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/patch/panels/:pid', requireNoc, (req, res) => {
  const p = db.prepare('SELECT * FROM patch_panels WHERE id=?').get(req.params.pid); if (!p) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const ports = Math.min(Math.max(parseInt(b.ports, 10) || p.ports, 1), 288);
  db.prepare('UPDATE patch_panels SET name=?, location=?, ports=?, notes=? WHERE id=?').run(N(b.name, p.name), N(b.location, p.location), ports, N(b.notes, p.notes), p.id);
  if (ports < p.ports) db.prepare('DELETE FROM patch_ports WHERE panel_id=? AND port_no>?').run(p.id, ports); // drop rows for removed ports
  audit(req, 'edit', p.parent_type + '#' + p.parent_id, 'patch panel#' + p.id);
  res.json({ ok: true });
});
app.delete('/api/patch/panels/:pid', requireNoc, (req, res) => {
  const p = db.prepare('SELECT * FROM patch_panels WHERE id=?').get(req.params.pid); if (!p) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM patch_ports WHERE panel_id=?').run(p.id);
  db.prepare('DELETE FROM patch_panels WHERE id=?').run(p.id);
  audit(req, 'delete', p.parent_type + '#' + p.parent_id, 'patch panel#' + p.id);
  res.json({ ok: true });
});
// upsert a single port. Empty/free with no data clears the row.
app.put('/api/patch/panels/:pid/ports/:portNo', requireNoc, (req, res) => {
  const p = db.prepare('SELECT * FROM patch_panels WHERE id=?').get(req.params.pid); if (!p) return res.status(404).json({ error: 'not found' });
  const portNo = parseInt(req.params.portNo, 10);
  if (!(portNo >= 1 && portNo <= p.ports)) return res.status(400).json({ error: 'port out of range' });
  const b = req.body || {};
  const status = PATCH_PORT_STATUS.includes(b.status) ? b.status : 'free';
  const deviceId = b.device_id ? Number(b.device_id) : null;
  const circuitId = b.circuit_id ? Number(b.circuit_id) : null;
  const vals = { label: N(b.label) || null, device_id: deviceId, device_text: N(b.device_text) || null, circuit_id: circuitId, circuit_text: N(b.circuit_text) || null, far_end: N(b.far_end) || null, status, note: N(b.note) || null };
  const empty = !vals.label && !vals.device_id && !vals.device_text && !vals.circuit_id && !vals.circuit_text && !vals.far_end && !vals.note && status === 'free';
  if (empty) { db.prepare('DELETE FROM patch_ports WHERE panel_id=? AND port_no=?').run(p.id, portNo); return res.json({ ok: true, cleared: true }); }
  db.prepare(`INSERT INTO patch_ports (panel_id,port_no,label,device_id,device_text,circuit_id,circuit_text,far_end,status,note)
    VALUES (@panel_id,@port_no,@label,@device_id,@device_text,@circuit_id,@circuit_text,@far_end,@status,@note)
    ON CONFLICT(panel_id,port_no) DO UPDATE SET label=@label,device_id=@device_id,device_text=@device_text,circuit_id=@circuit_id,circuit_text=@circuit_text,far_end=@far_end,status=@status,note=@note`)
    .run({ panel_id: p.id, port_no: portNo, ...vals });
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
// Photos render inline; documents are download-only (see the GET handler) so nothing
// user-supplied can execute in the browser's origin.
const ATT_IMAGE_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };
const ATT_DOC_MIME = {
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/zip': '.zip',
  // OTDR traces, CAD and other field artefacts have no registered type — browsers send octet-stream
  'application/octet-stream': '.bin'
};
const ATT_MIME = { ...ATT_IMAGE_MIME, ...ATT_DOC_MIME };
const ATT_MAX = 25 * 1024 * 1024; // 25 MB
// Anything a photo/document can hang off. Fiber plant needs these for as-built evidence:
// splice-tray photos, OTDR traces, locate tickets, permits.
const ATT_PARENTS = ['site', 'pop', 'cable', 'splice', 'structure', 'route'];
function withNoteAttachments(notes) {
  const q = db.prepare('SELECT id, filename, mime, size, caption FROM note_attachments WHERE note_id=? ORDER BY id');
  for (const n of notes) n.attachments = q.all(n.id);
  return notes;
}
/** Attachments hung directly off a record (not off a note). */
function attachmentsFor(parentType, parentId) {
  return db.prepare('SELECT id, filename, mime, size, caption, author, created_at FROM note_attachments WHERE parent_type=? AND parent_id=? AND note_id IS NULL ORDER BY id')
    .all(parentType, Number(parentId));
}
/** Remove every attachment for a record (called when the record itself is deleted). */
function deleteAttachmentsFor(parentType, parentId) {
  const rows = db.prepare('SELECT id, stored_name FROM note_attachments WHERE parent_type=? AND parent_id=?').all(parentType, Number(parentId));
  for (const a of rows) { try { unlinkSync(join(UPLOADS_DIR, a.stored_name)); } catch {} }
  if (rows.length) db.prepare('DELETE FROM note_attachments WHERE parent_type=? AND parent_id=?').run(parentType, Number(parentId));
  return rows.length;
}
app.get('/api/attachments', (req, res) => {
  const { parent_type, parent_id } = req.query;
  if (!ATT_PARENTS.includes(parent_type) || !parent_id) return res.status(400).json({ error: 'parent_type and parent_id required' });
  res.json(attachmentsFor(parent_type, parent_id));
});
app.post('/api/attachments', (req, res) => {
  const b = req.body || {};
  if (!ATT_PARENTS.includes(b.parent_type) || !b.parent_id) return res.status(400).json({ error: 'parent_type and parent_id required' });
  if (!ATT_MIME[b.mime]) return res.status(400).json({ error: 'Unsupported file type — images, PDF, Office documents, CSV/text and ZIP are allowed' });
  let raw = String(b.data || '');
  const comma = raw.indexOf(','); if (raw.startsWith('data:') && comma !== -1) raw = raw.slice(comma + 1); // strip data URL prefix
  let buf; try { buf = Buffer.from(raw, 'base64'); } catch { return res.status(400).json({ error: 'Bad file data' }); }
  if (!buf.length) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > ATT_MAX) return res.status(413).json({ error: 'File too large (max 25 MB)' });
  // keep the real extension for octet-stream uploads (.sor OTDR traces, .dwg, …) so downloads open correctly
  let ext = ATT_MIME[b.mime];
  if (b.mime === 'application/octet-stream') { const m = String(b.filename || '').match(/(\.[A-Za-z0-9]{1,8})$/); if (m) ext = m[1].toLowerCase(); }
  const stored = randomUUID() + ext;
  try { writeFileSync(join(UPLOADS_DIR, stored), buf); } catch (e) { return res.status(500).json({ error: 'Could not save file' }); }
  const info = db.prepare('INSERT INTO note_attachments (parent_type,parent_id,note_id,filename,mime,size,stored_name,author,caption) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(b.parent_type, b.parent_id, N(b.note_id), N(b.filename, 'file'), b.mime, buf.length, stored, (req.user && req.user.email) || '', N(b.caption) || null);
  audit(req, 'attach', b.parent_type + '#' + b.parent_id, b.filename || stored);
  res.json({ id: info.lastInsertRowid, filename: b.filename, mime: b.mime, size: buf.length });
});
app.put('/api/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM note_attachments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!isPriv(req) && a.author !== (req.user && req.user.email)) return res.status(403).json({ error: 'Only the author or NOC/Admin can edit' });
  db.prepare('UPDATE note_attachments SET caption=? WHERE id=?').run(N((req.body || {}).caption) || null, a.id);
  res.json({ ok: true });
});
app.get('/api/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM note_attachments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const fp = join(UPLOADS_DIR, a.stored_name);
  if (!existsSync(fp)) return res.status(404).json({ error: 'file missing' });
  // Only images and PDFs render inline; everything else downloads, so an uploaded file can never
  // be interpreted as script in our origin. nosniff stops the browser second-guessing the type.
  const inline = !!ATT_IMAGE_MIME[a.mime] || a.mime === 'application/pdf';
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', statSync(fp).size);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${(a.filename || 'file').replace(/[^\w.\-() ]/g, '_')}"`);
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
app.put('/api/sites/:id/access', requireNoc, (req, res) => {
  const s = db.prepare('SELECT id FROM sites WHERE id=?').get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const details = {
    gate_code: N(b.gate_code) || '', front_door: N(b.front_door) || '', lockbox: N(b.lockbox) || '',
    access_hours: N(b.access_hours) || '', notes: N(b.notes) || '',
    contacts: (Array.isArray(b.contacts) ? b.contacts : []).map(c => ({ name: String(c.name || '').trim(), phone: String(c.phone || '').trim() })).filter(c => c.name || c.phone)
  };
  const json = JSON.stringify(details);
  const ex = db.prepare('SELECT site_id FROM site_access WHERE site_id=?').get(req.params.id);
  if (ex) db.prepare('UPDATE site_access SET details_json=? WHERE site_id=?').run(json, req.params.id);
  else db.prepare('INSERT INTO site_access (site_id, details_json) VALUES (?,?)').run(req.params.id, json);
  audit(req, 'edit', 'site#' + req.params.id, 'site access');
  res.json({ ok: true });
});

// connections
app.post('/api/sites/:id/connections', (req, res) => {
  const b = req.body || {};
  const info = db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_pop_id,served_provider_id,circuit_id,wan_port,ip_type,static_ip,current_ip,bandwidth,status,circuit_ref_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.params.id, b.role||'Primary', b.priority||1, N(b.served_type), N(b.served_pop_id), N(b.served_provider_id), N(b.circuit_id), N(b.wan_port), b.ip_type||'Static', N(b.static_ip), N(b.current_ip), N(b.bandwidth), b.status||'Up', b.circuit_ref_id ? Number(b.circuit_ref_id) : null);
  audit(req, 'create', 'connection#' + info.lastInsertRowid, 'site#' + req.params.id);
  res.json({ id: info.lastInsertRowid });
});

// ---- devices ----
app.get('/api/devices', (req, res) => {
  const rows = db.prepare('SELECT d.*, m.manufacturer, m.model, m.device_type FROM devices d LEFT JOIN device_models m ON m.id=d.model_id ORDER BY d.name').all().map(publicDevice);
  res.json(rows);
});

// ---- domain modules (registered after core middleware, before static) ----
const ctx = {
  db, N, audit, requireNoc, requireAdmin, role, isPriv, getSetting, setSetting,
  sendMail, mailSafe, publicDevice, restReq, rosHeaders, rosErr,
  customerAccounts, accountCustomers, setCustomerAccounts,
  verifyPassword, parseCookies, hashPassword,
  restReq, rosHeaders, rosErr, publicDevice, pollDeviceCore,
  UPLOADS_DIR, BACKUPS_DIR, PACKAGES_DIR,
  harvestThreats, pushBlocklistToDevice, activeBlockIps, blocklistMinHits,
  attachmentsFor, deleteAttachmentsFor,
  jobs: {}
};
registerNetwork(app, ctx);
registerFiber(app, ctx);
registerSupport(app, ctx);   // messaging helpers first: billing has no dependency, but portal/pubBase are shared
registerBilling(app, ctx);

// ---- audit ----
app.get('/api/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
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

// An unmatched /api path is a bug or a typo — answer JSON so callers see a real error
// instead of silently receiving the SPA's HTML (which looks like an empty page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

// SPA fallback. The frontend uses hash routing (#/sites), so genuine navigation only ever
// requests '/'. Anything with a file extension is a missing asset, and anything with a
// dot-segment is a scanner probing for /.env, /.git/config and friends — 404 those rather
// than handing back 200 + the whole login page, which only encourages the scanners.
app.get('*', (req, res) => {
  const segments = req.path.split('/').filter(Boolean);
  const looksLikeFile = !!extname(req.path) || segments.some(s => s.startsWith('.'));
  if (looksLikeFile) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Network Inventory Platform running on http://localhost:${PORT}`));
