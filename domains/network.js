// Network operations domain: everything that talks to RouterOS — DHCP leases, WiFi,
// config backups (SFTP/FTP retrieval), zero-touch provisioning, the .npk package library,
// provisioning bench nodes, fleet batch config, telemetry read APIs and the threat blocklist.
import express from "express";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, createReadStream, existsSync, statSync, unlinkSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import net from "node:net";
import { r2 } from "../lib/core.js";

export default function registerNetwork(app, ctx) {
  const { db, N, audit, requireNoc, isPriv, role, getSetting, setSetting,
          restReq, rosHeaders, rosErr, publicDevice, pollDeviceCore,
          UPLOADS_DIR, BACKUPS_DIR, PACKAGES_DIR,
          harvestThreats, pushBlocklistToDevice, activeBlockIps, blocklistMinHits } = ctx;

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
  const pendingUploads = new Map(); // token -> { resolve }  (legacy upload receiver; SFTP/FTP pull is primary)
  // Primary retrieval: SFTP over the router's SSH service (usually enabled + secure). Dynamic import so the app
  // still boots if ssh2 isn't installed. RouterOS serves the flash filesystem as the SFTP root.
  async function sftpRetrieve(host, user, pass, filename, { port = 22, timeoutMs = 20000 } = {}) {
    const mod = await import('ssh2');
    const SshClient = mod.Client || (mod.default && mod.default.Client);
    if (!SshClient) throw new Error('ssh2 not available');
    return await new Promise((resolve, reject) => {
      const conn = new SshClient(); let done = false;
      const finish = (err, data) => { if (done) return; done = true; clearTimeout(timer); try { conn.end(); } catch {} err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(data); };
      const timer = setTimeout(() => finish(new Error('SFTP timeout')), timeoutMs);
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return finish(err);
          const names = [filename, '/' + filename, filename.replace(/^\/+/, '')];
          const tryPath = (i) => {
            if (i >= names.length) return finish(new Error('SFTP file not found: ' + filename));
            const chunks = []; const rs = sftp.createReadStream(names[i]);
            rs.on('data', c => chunks.push(c));
            rs.on('error', () => tryPath(i + 1));
            rs.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
          };
          tryPath(0);
        });
      });
      conn.on('error', e => finish(e));
      conn.connect({ host, port, username: user, password: pass, readyTimeout: timeoutMs });
    });
  }
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
  const slash16 = ip => { const m = String(ip || '').match(/^(\d+)\.(\d+)\./); return m ? `${m[1]}.${m[2]}.0.0/16` : ''; };
  // Backups pull config over SFTP/FTP, but many routers have those services off. Since the REST API works,
  // enable SSH via the API (scoped to the management overlay so it isn't exposed) right before pulling.
  async function ensureSshForBackup(d, ros) {
    if (getSetting('backup_enable_ssh') === '0') return { skipped: 'auto-enable off' };
    let arr = [];
    try { const r = await ros('GET', '/rest/ip/service'); if (r.status < 400) arr = JSON.parse(r.body); } catch (e) { return { error: e.message }; }
    const s = (Array.isArray(arr) ? arr : []).find(x => x.name === 'ssh'); if (!s) return { note: 'no ssh service' };
    if (!(s.disabled === 'true' || s.disabled === true)) return { alreadyOn: true };
    const cidr = (getSetting('mgmt_overlay_cidr') || '').trim() || slash16(d.mgmt_address);
    const patch = { disabled: 'false' };
    if (cidr && !s.address) patch.address = cidr; // scope to overlay only if the operator hasn't set their own address restriction
    try {
      const pr = await ros('PATCH', '/rest/ip/service/' + encodeURIComponent(s['.id']), patch);
      if (pr.status >= 400) return { error: 'enable HTTP ' + pr.status };
    } catch (e) { return { error: e.message }; }
    try { db.prepare("INSERT INTO audit_log (actor,role,action,target,details) VALUES ('system','system','edit',?,?)").run('device#' + d.id, 'auto-enabled SSH for backups' + (patch.address ? ' (address ' + patch.address + ')' : '')); } catch {}
    await _sleep(1500); // let sshd bind before we connect
    return { enabled: true, address: patch.address || s.address || '(unchanged)' };
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
        // B2: REST won't hand back contents — pull the .rsc from the router. Prefer SFTP (SSH), fall back to FTP.
        if (!text || !text.trim()) {
          const user = d.admin_username || 'admin'; let sftpErr = null, ftpErr = null;
          const sshFix = await ensureSshForBackup(d, ros).catch(e => ({ error: e.message })); // turn SSH on via the API if it's off
          try { text = await sftpRetrieve(d.mgmt_address, user, d.admin_password, f.name); } catch (e) { sftpErr = e; }
          if (!text || !text.trim()) { try { text = await ftpRetrieve(d.mgmt_address, user, d.admin_password, f.name); } catch (e) { ftpErr = e; } }
          if (!text || !text.trim()) {
            if (f['.id']) { try { await ros('DELETE', '/rest/file/' + f['.id']); } catch {} }
            const hint = sshFix && sshFix.enabled ? ' (SSH was just enabled' + (sshFix.address && sshFix.address !== '(unchanged)' ? ' scoped to ' + sshFix.address : '') + ' — run the backup once more)' : (sshFix && sshFix.error ? ' (SSH auto-enable failed: ' + sshFix.error + ')' : '');
            throw new Error('REST gave no config; SFTP failed: ' + (sftpErr ? sftpErr.message : 'n/a') + '; FTP failed: ' + (ftpErr ? ftpErr.message : 'n/a') + hint);
          }
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
        // Report SSH service state + auto-enable it (scoped to overlay) so SFTP can connect
        try { const sf = await ensureSshForBackup(d, ros); out.steps.push({ label: 'ensure SSH service', ...sf }); } catch (e) { out.steps.push({ label: 'ensure SSH service', error: e.message }); }
        // SFTP pull attempt (primary retrieval path) — report success length or error
        try { const t = await sftpRetrieve(d.mgmt_address, d.admin_username || 'admin', d.admin_password, f.name, { timeoutMs: 15000 }); out.steps.push({ label: 'SFTP get ' + f.name, ok: true, bytes: Buffer.byteLength(t), snippet: t.slice(0, 120) }); }
        catch (e) { out.steps.push({ label: 'SFTP get ' + f.name, error: e.message }); }
        // FTP pull attempt (fallback retrieval path) — report success length or error
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
    const cols = ['name','model_id','serial','mac','status','online','assigned_type','assigned_site_id','assigned_pop_id','management_mode','mgmt_overlay','mgmt_address','controller_id','ownership','owner_org','account_number','owner_account','owner_sub_account','owner_subaccount_id','account_status','hfc_mac','purchased_from','associated_connection_id','cell_carrier','cell_phone','cell_imei','cell_sim','cell_sku','factory_wifi_ssid','tech_username','zt_node_id','admin_username'];
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
      // expired auth rows accumulate forever otherwise
      try {
        db.prepare("DELETE FROM portal_sessions WHERE expires_at<datetime('now')").run();
        db.prepare("DELETE FROM portal_login_tokens WHERE expires_at<datetime('now')").run();
        db.prepare("DELETE FROM sessions WHERE expires_at<datetime('now')").run();
      } catch {}
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
        try { ctx.jobs.runRecurringBilling(); } catch (e) { console.warn('recurring billing failed:', e.message); }
      }
      // inbound email: poll the support mailbox for customer replies (self-guards on config)
      if (process.env.IMAP !== 'off') { try { await ctx.jobs.pollImap(); } catch (e) { console.warn('imap poll:', e.message); } }
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


  // shared with the sampler + pollDeviceCore
  Object.assign(ctx.jobs, { runWeeklyBackups, pruneOldBackups, sampleDevice, blocklistSig });
  ctx.readWifi = readWifi;
}
