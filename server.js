// Network Inventory & Management Platform — API + static server (testing build)
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, initSchema, isEmpty, seed } from './db.js';
import { createSession, destroySession, userForToken, parseCookies, setSessionCookie, clearSessionCookie } from './auth.js';
import { hashPassword, verifyPassword } from './hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// First-run: create schema + seed if empty
initSchema();
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

// Strip credential values from a device row, replace with has_* flags
function publicDevice(d) {
  const out = { ...d };
  for (const f of ALL_CREDS) { out['has_' + f] = !!out[f]; delete out[f]; }
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
  res.json(a);
});

app.post('/api/accounts', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO accounts (name, account_number, status, billing_address, notes) VALUES (?,?,?,?,?)')
    .run(N(b.name), N(b.account_number), b.status || 'Active', N(b.billing_address), N(b.notes));
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

app.put('/api/accounts/:id', (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE accounts SET name=?, account_number=?, status=?, billing_address=?, notes=? WHERE id=?')
    .run(N(b.name), N(b.account_number), N(b.status, 'Active'), N(b.billing_address), N(b.notes), req.params.id);
  audit(req, 'edit', 'account#' + req.params.id, b.name);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', (req, res) => {
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
  const cols = ['name','model_id','serial','mac','status','online','assigned_type','assigned_site_id','assigned_pop_id','management_mode','mgmt_overlay','mgmt_address','controller_id','ownership','owner_org','account_number','owner_account','owner_sub_account','account_status','hfc_mac','purchased_from','associated_connection_id','cell_carrier','cell_phone','cell_imei','cell_sim','cell_sku','factory_password','admin_password','tech_username','tech_password','factory_wifi_ssid','factory_wifi_password','acct_pin','acct_portal_username','acct_portal_password','acct_passphrase'];
  const vals = cols.map(c => b[c] === undefined ? null : b[c]);
  const info = db.prepare(`INSERT INTO devices (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...vals);
  audit(req, 'create', 'device#' + info.lastInsertRowid, b.name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/devices/:id', (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const cols = ['name','model_id','serial','mac','status','online','assigned_type','assigned_site_id','assigned_pop_id','management_mode','mgmt_overlay','mgmt_address','controller_id','ownership','owner_org','account_number','owner_account','owner_sub_account','account_status','hfc_mac','purchased_from','associated_connection_id','cell_carrier','cell_phone','cell_imei','cell_sim','cell_sku','factory_wifi_ssid','tech_username'];
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

// ---- static frontend ----
app.use(express.static(join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Network Inventory Platform running on http://localhost:${PORT}`));
