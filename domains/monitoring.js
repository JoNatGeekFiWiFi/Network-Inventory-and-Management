// Monitoring additions: router resources, Wi-Fi session history, speed tests, CSV export, the
// topology map, and configuration templates with drift detection.
//
// The sampler (domains/network.js) calls ctx.monitoring.everyFiveMinutes(d) for each router it
// reached, and ctx.monitoring.hourly() once an hour. Everything else is an API route.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { driverFor, platformOf, can } from '../lib/drivers/index.js';
import { sshExec } from '../lib/sshexec.js';
import {
  parseRosResource, parseOwResource, restarted, diffSessions, parseOuiCsv, vendorOf,
  mbps, parseRosFetch, parseOwFetch, toCsv
} from '../lib/monitoring.js';
import {
  PLATFORMS as TPL_PLATFORMS, render, parseVars, systemVars, parseRouterOS, parseOpenWrt, diffRouterOS, diffOpenWrt
} from '../lib/configtemplates.js';

const RANGE_SEC = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000, '60d': 5184000 };
const sinceIso = (range) => new Date(Date.now() - (RANGE_SEC[range] || 86400) * 1000).toISOString();

export default function registerMonitoring(app, ctx) {
  const { db, requireNoc, audit, restReq, rosHeaders, getSetting, setSetting, UPLOADS_DIR } = ctx;
  const device = (id) => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const ros = (d) => async (method, path, body, timeoutMs = 10000) => {
    const r = await restReq(d.mgmt_address, path, { headers: rosHeaders(d), method, body, timeoutMs });
    if (r.status >= 400) throw Object.assign(new Error(`Device returned ${r.status} on ${path}`), { status: r.status });
    try { return r.body ? JSON.parse(r.body) : null; } catch { return null; }
  };
  const observe = (d, metric, v) => { if (ctx.health && v != null && Number.isFinite(v)) { try { ctx.health.observe(d, metric, v); } catch {} } };

  // =========================== resources ===========================
  const _cores = new Map(), _lastUptime = new Map();
  const insRes = db.prepare('INSERT INTO dev_resources (device_id, ts, cpu, mem_pct, disk_pct, uptime_s) VALUES (?,?,?,?,?,?)');

  async function readResources(d) {
    if (platformOf(d) === 'routeros') return parseRosResource(await ros(d)('GET', '/rest/system/resource'));
    const driver = await driverFor(d, { sshExec });
    const r = await driver.systemInfo();
    if (!_cores.has(d.id)) {
      const c = await driver.run(['grep', '-c', '^processor', '/proc/cpuinfo']).catch(() => null);
      _cores.set(d.id, Math.max(1, parseInt(c && c.data, 10) || 1));
    }
    let dfText = null;
    if (!(r && r.root)) { const df = await driver.run(['df', '-k', '/overlay']).catch(() => null); dfText = df && df.ok ? df.data : null; }
    return parseOwResource(r || {}, { cores: _cores.get(d.id) || 1, dfText });
  }

  async function sampleResources(d) {
    const r = await readResources(d);
    const ts = new Date().toISOString();
    insRes.run(d.id, ts, r.cpu, r.mem_pct, r.disk_pct, r.uptime_s);
    observe(d, 'cpu', r.cpu); observe(d, 'memory', r.mem_pct); observe(d, 'disk', r.disk_pct);
    // A restart is recorded in the device's history (not alerted on: reachability covers outages).
    const prev = _lastUptime.has(d.id) ? _lastUptime.get(d.id)
      : (db.prepare('SELECT uptime_s FROM dev_resources WHERE device_id=? AND ts<? ORDER BY ts DESC LIMIT 1').get(d.id, ts) || {}).uptime_s;
    if (restarted(prev, r.uptime_s)) {
      db.prepare("INSERT INTO alert_events (device_id, metric, kind, value, message, suppressed, notified_at) VALUES (?, 'uptime', 'notice', ?, ?, 1, datetime('now'))")
        .run(d.id, r.uptime_s, `${d.name} restarted (up ${Math.round(r.uptime_s / 60)} min)`);
    }
    _lastUptime.set(d.id, r.uptime_s);
    return r;
  }

  app.get('/api/devices/:id/resources', (req, res) => {
    const rows = db.prepare('SELECT ts, cpu, mem_pct, disk_pct, uptime_s FROM dev_resources WHERE device_id=? AND ts>=? ORDER BY ts').all(req.params.id, sinceIso(req.query.range || '24h'));
    res.json(rows);
  });
  app.post('/api/devices/:id/resources/now', requireNoc, async (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    try { res.json(await sampleResources(d)); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // =========================== Wi-Fi sessions ===========================
  let _oui = null, _ouiLoading = null;
  const ouiPath = () => join(dirname(UPLOADS_DIR), 'oui.csv');
  /** The IEEE vendor list, cached on disk for a month. Missing is fine — vendors just show blank. */
  async function oui() {
    if (_oui) return _oui;
    if (_ouiLoading) return _ouiLoading;
    _ouiLoading = (async () => {
      let text = null;
      try { const st = statSync(ouiPath()); if (Date.now() - st.mtimeMs < 30 * 86400000) text = readFileSync(ouiPath(), 'utf8'); } catch {}
      if (!text && process.env.DEMO_MODE !== '1' && process.env.OUI_FETCH !== 'off') {
        try {
          const r = await fetch('https://standards-oui.ieee.org/oui/oui.csv', { signal: AbortSignal.timeout(30000) });
          if (r.ok) { text = await r.text(); try { writeFileSync(ouiPath(), text); } catch {} }
        } catch {}
      }
      if (!text) { try { text = readFileSync(ouiPath(), 'utf8'); } catch {} }
      _oui = text ? parseOuiCsv(text) : new Map();
      _ouiLoading = null;
      return _oui;
    })();
    return _ouiLoading;
  }

  async function readClients(d) {
    if (platformOf(d) === 'routeros') {
      if (!ctx.readWifiClients) return [];
      const r = await ctx.readWifiClients(d);
      return (r.clients || []).map(c => ({ mac: c.mac, iface: c.iface, ssid: c.ssid, signal: c.signal }));
    }
    const driver = await driverFor(d, { sshExec });
    const list = await driver.wifiClients();
    return list.map(c => ({ mac: c.mac, iface: c.iface, ssid: c.ssid || '', signal: c.signal ?? null }));
  }

  async function sampleWifi(d) {
    const clients = await readClients(d);
    const now = new Date().toISOString();
    const open = db.prepare('SELECT id, mac FROM wifi_sessions WHERE device_id=? AND ended_at IS NULL').all(d.id);
    const { start, seen, end } = diffSessions(open, clients);
    const table = await oui();
    const ins = db.prepare('INSERT INTO wifi_sessions (device_id, mac, vendor, iface, ssid, started_at, last_seen, signal_last, signal_min) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const c of start) ins.run(d.id, c.mac, vendorOf(c.mac, table), c.iface || null, c.ssid || null, now, now, c.signal ?? null, c.signal ?? null);
    const upd = db.prepare('UPDATE wifi_sessions SET last_seen=?, signal_last=?, signal_min=CASE WHEN ? IS NULL THEN signal_min WHEN signal_min IS NULL OR ? < signal_min THEN ? ELSE signal_min END WHERE id=?');
    for (const { id, client } of seen) upd.run(now, client.signal ?? null, client.signal ?? null, client.signal ?? null, client.signal ?? null, id);
    // A client that has gone ended at the last time we saw it, not now — that is the honest time.
    const fin = db.prepare('UPDATE wifi_sessions SET ended_at=last_seen WHERE id=?');
    for (const id of end) fin.run(id);
    return { started: start.length, ended: end.length, connected: clients.length };
  }

  app.get('/api/devices/:id/wifi-sessions', requireNoc, (req, res) => {
    const rows = db.prepare(`SELECT * FROM wifi_sessions WHERE device_id=? AND (ended_at IS NULL OR last_seen>=?) ORDER BY ended_at IS NOT NULL, last_seen DESC LIMIT 500`)
      .all(req.params.id, sinceIso(req.query.range || '7d'));
    res.json(rows);
  });
  app.post('/api/devices/:id/wifi-sessions/now', requireNoc, async (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    try { res.json(await sampleWifi(d)); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  /** Where has this device (phone, laptop) been seen? */
  app.get('/api/wifi-sessions', requireNoc, (req, res) => {
    const mac = String(req.query.mac || '').trim().toUpperCase().replace(/-/g, ':');
    if (!/^([0-9A-F]{2}:){2,5}[0-9A-F]{0,2}$/.test(mac)) return res.status(400).json({ error: 'Enter a MAC address (at least the first three pairs)' });
    res.json(db.prepare(`SELECT w.*, d.name AS device_name FROM wifi_sessions w LEFT JOIN devices d ON d.id=w.device_id WHERE w.mac LIKE ? ORDER BY w.last_seen DESC LIMIT 200`).all(mac + '%'));
  });

  // =========================== speed test ===========================
  const DEFAULT_SPEED_URL = 'https://speed.cloudflare.com/__down?bytes=25000000';
  app.post('/api/devices/:id/speedtest', requireNoc, async (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    if (!d.mgmt_address || !d.admin_password) return res.status(400).json({ error: 'No management address or admin password on file' });
    const url = getSetting('speedtest_url') || DEFAULT_SPEED_URL;
    let bytes = null, seconds = null, error = null;
    try {
      if (platformOf(d) === 'routeros') {
        const r = await ros(d)('POST', '/rest/tool/fetch', { url, 'keep-result': 'no', 'as-value': '' }, 90000);
        ({ bytes, seconds } = parseRosFetch(r));
      } else if (platformOf(d) === 'openwrt') {
        const driver = await driverFor(d, { sshExec });
        // Time the download on the router itself; wget writes to nowhere, wc counts what arrived.
        // /proc/uptime rather than date +%N: BusyBox builds often lack nanosecond dates.
        const script = `s=$(cut -d' ' -f1 /proc/uptime); n=$(wget -q -O - '${url.replace(/'/g, '')}' | wc -c); e=$(cut -d' ' -f1 /proc/uptime); echo "$n $s $e"`;
        const r = await driver.run(['sh', '-c', script], { timeoutMs: 90000 });
        ({ bytes, seconds } = parseOwFetch(r.data));
        if (!bytes) throw new Error(r.error || 'nothing downloaded');
      } else throw new Error('Speed tests run on MikroTik and OpenWrt routers');
    } catch (e) { error = e.message; }
    const speed = error ? null : mbps(bytes, seconds);
    const info = db.prepare('INSERT INTO speed_tests (device_id, url, bytes, seconds, mbps, error, actor) VALUES (?,?,?,?,?,?,?)')
      .run(d.id, url, bytes, seconds, speed, error, (req.user && req.user.email) || null);
    audit(req, 'speedtest', 'device#' + d.id, error ? 'failed: ' + error : `${speed} Mbps`);
    if (error) return res.status(502).json({ error, id: Number(info.lastInsertRowid) });
    res.json({ id: Number(info.lastInsertRowid), mbps: speed, bytes, seconds });
  });
  app.get('/api/devices/:id/speedtests', (req, res) => {
    res.json(db.prepare('SELECT * FROM speed_tests WHERE device_id=? ORDER BY id DESC LIMIT 50').all(req.params.id));
  });

  // =========================== CSV ===========================
  // Column lists are explicit, so an empty export still has its header row.
  const COLS = {
    traffic: ['ts', 'iface', 'rx_bps', 'tx_bps'], latency: ['ts', 'ms'], resources: ['ts', 'cpu', 'mem_pct', 'disk_pct', 'uptime_s'],
    'wifi-sessions': ['mac', 'vendor', 'ssid', 'iface', 'started_at', 'last_seen', 'ended_at', 'signal_last', 'signal_min'],
    alerts: ['created_at', 'metric', 'kind', 'value', 'message'], speedtests: ['created_at', 'mbps', 'bytes', 'seconds', 'url', 'error'],
    allAlerts: ['created_at', 'device', 'metric', 'kind', 'value', 'message', 'suppressed']
  };
  const sendCsv = (res, name, rows, cols) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}.csv"`);
    res.send(toCsv(rows, cols));
  };
  app.get('/api/devices/:id/export/:what.csv', requireNoc, (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const since = sinceIso(req.query.range || '7d');
    const tag = `${d.name}-${req.params.what}-${(req.query.range || '7d')}`;
    switch (req.params.what) {
      case 'traffic': return sendCsv(res, tag, db.prepare('SELECT ts, iface, rx_bps, tx_bps FROM iface_traffic WHERE device_id=? AND ts>=? ORDER BY ts, iface').all(d.id, since), COLS['traffic']);
      case 'latency': return sendCsv(res, tag, db.prepare('SELECT ts, ms FROM dev_latency WHERE device_id=? AND ts>=? ORDER BY ts').all(d.id, since), COLS['latency']);
      case 'resources': return sendCsv(res, tag, db.prepare('SELECT ts, cpu, mem_pct, disk_pct, uptime_s FROM dev_resources WHERE device_id=? AND ts>=? ORDER BY ts').all(d.id, since), COLS['resources']);
      case 'wifi-sessions': return sendCsv(res, tag, db.prepare('SELECT mac, vendor, ssid, iface, started_at, last_seen, ended_at, signal_last, signal_min FROM wifi_sessions WHERE device_id=? AND last_seen>=? ORDER BY started_at').all(d.id, since), COLS['wifi-sessions']);
      case 'alerts': return sendCsv(res, tag, db.prepare('SELECT created_at, metric, kind, value, message FROM alert_events WHERE device_id=? AND created_at>=? ORDER BY id').all(d.id, since.replace('T', ' ').slice(0, 19)), COLS['alerts']);
      case 'speedtests': return sendCsv(res, tag, db.prepare('SELECT created_at, mbps, bytes, seconds, url, error FROM speed_tests WHERE device_id=? ORDER BY id').all(d.id), COLS['speedtests']);
      default: return res.status(404).json({ error: 'unknown export' });
    }
  });
  app.get('/api/export/alerts.csv', requireNoc, (req, res) => {
    sendCsv(res, 'alerts-' + (req.query.range || '30d'), db.prepare(`SELECT e.created_at, d.name AS device, e.metric, e.kind, e.value, e.message, e.suppressed
      FROM alert_events e LEFT JOIN devices d ON d.id=e.device_id WHERE e.created_at>=? ORDER BY e.id`).all(sinceIso(req.query.range || '30d').replace('T', ' ').slice(0, 19)), COLS.allAlerts);
  });

  // =========================== topology ===========================
  /**
   * The network as a graph: this server (the hub), POPs, sites, and their routers.
   * Edges: hub → each POP (its core router's reachability), POP → site (the connection it serves,
   * with that connection's status), carrier → site for brokered circuits. Each node carries the
   * worst health of its routers and each router its overlay and last WireGuard handshake.
   */
  app.get('/api/topology', async (req, res) => {
    const health = ctx.health ? ctx.health.allHealth() : {};
    const rank = { critical: 5, problem: 4, unknown: 3, ok: 2, unmonitored: 1, deactivated: 0 };
    const worst = (ids) => ids.map(i => health[i]).filter(Boolean).sort((a, b) => rank[b] - rank[a])[0] || 'unmonitored';
    let hs = new Map();
    try {
      const st = ctx.wgHubStatus ? await ctx.wgHubStatus() : null;
      if (st && st.peers) hs = new Map(st.peers.map(p => [p.public_key || p.pubkey, p]));
    } catch {}
    const devs = db.prepare(`SELECT id, name, assigned_type, assigned_site_id, assigned_pop_id, mgmt_overlay, mgmt_address, wg_public_key, platform, online
      FROM devices WHERE archived_at IS NULL AND status='Deployed' AND management_mode='platform'`).all();
    const devNode = (d) => {
      const peer = d.wg_public_key ? hs.get(d.wg_public_key) : null;
      return { id: 'd' + d.id, device_id: d.id, name: d.name, health: health[d.id] || 'unmonitored', overlay: d.mgmt_overlay || null, mgmt: d.mgmt_address,
        handshake_s: peer ? peer.seconds_since_handshake : null };
    };
    const pops = db.prepare('SELECT id, name, code FROM pops WHERE archived_at IS NULL ORDER BY name').all().map(p => {
      const rs = devs.filter(d => d.assigned_type === 'pop' && d.assigned_pop_id === p.id);
      return { id: 'p' + p.id, pop_id: p.id, kind: 'pop', name: p.code || p.name, full: p.name, health: worst(rs.map(r => r.id)), routers: rs.map(devNode) };
    });
    const sites = db.prepare('SELECT id, name FROM sites WHERE archived_at IS NULL ORDER BY name').all().map(s => {
      const rs = devs.filter(d => d.assigned_type === 'site' && d.assigned_site_id === s.id);
      return { id: 's' + s.id, site_id: s.id, kind: 'site', name: s.name, health: worst(rs.map(r => r.id)), routers: rs.map(devNode) };
    }).filter(s => s.routers.length || db.prepare('SELECT 1 FROM connections WHERE site_id=?').get(s.site_id));
    const carriers = new Map();
    const edges = [];
    for (const p of pops) edges.push({ from: 'hub', to: p.id, status: p.health === 'critical' ? 'down' : p.health === 'ok' ? 'up' : 'unknown', label: 'management' });
    for (const c of db.prepare('SELECT site_id, role, served_type, served_pop_id, served_provider_id, bandwidth, status FROM connections').all()) {
      if (!sites.some(s => s.site_id === c.site_id)) continue;
      let from = null;
      if (c.served_type === 'pop' && c.served_pop_id) from = 'p' + c.served_pop_id;
      else if (c.served_provider_id) {
        from = 'c' + c.served_provider_id;
        if (!carriers.has(from)) { const v = db.prepare('SELECT name FROM upstream_providers WHERE id=?').get(c.served_provider_id); carriers.set(from, { id: from, kind: 'carrier', name: v ? v.name : 'Carrier', health: 'unmonitored', routers: [] }); }
      }
      if (from) edges.push({ from, to: 's' + c.site_id, status: String(c.status || '').toLowerCase() === 'up' ? 'up' : String(c.status || '').toLowerCase() === 'down' ? 'down' : 'standby', label: `${c.role}${c.bandwidth ? ' · ' + c.bandwidth : ''}` });
    }
    res.json({ hub: { id: 'hub', kind: 'hub', name: getSetting('company_name') || 'NOC server' }, pops, carriers: [...carriers.values()], sites, edges });
  });

  // =========================== configuration templates ===========================
  const globalVars = () => { try { return JSON.parse(getSetting('config_vars') || '{}'); } catch { return {}; } };
  function varsFor(d, tpl, deviceVars) {
    const site = d.assigned_type === 'site' && d.assigned_site_id ? db.prepare('SELECT s.name, c.name AS customer FROM sites s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(d.assigned_site_id) : null;
    const pop = d.assigned_type === 'pop' && d.assigned_pop_id ? db.prepare('SELECT name FROM pops WHERE id=?').get(d.assigned_pop_id) : null;
    let defaults = {}; try { defaults = JSON.parse(tpl.defaults_json || '{}'); } catch {}
    return { ...defaults, ...globalVars(),
      ...systemVars(d, { site: site && site.name, customer: site && site.customer, pop: pop && pop.name, company: getSetting('company_name') || '' }),
      ...(deviceVars || {}) };
  }
  function templatesFor(d) {
    return db.prepare(`SELECT t.*, dt.vars_json FROM device_templates dt JOIN config_templates t ON t.id=dt.template_id WHERE dt.device_id=? ORDER BY dt.position, t.id`).all(d.id)
      .filter(t => t.platform === platformOf(d));
  }
  /** Render every template on a device into steps, or say exactly which template/line is wrong. */
  function stepsFor(d) {
    const all = [], problems = [];
    for (const t of templatesFor(d)) {
      let dv = {}; try { dv = JSON.parse(t.vars_json || '{}'); } catch {}
      const { text, missing } = render(t.body, varsFor(d, t, dv));
      if (missing.length) { problems.push(`${t.name}: no value for ${missing.map(m => '{{' + m + '}}').join(', ')}`); continue; }
      const parsed = t.platform === 'routeros' ? parseRouterOS(text) : parseOpenWrt(text);
      if (parsed.error) { problems.push(`${t.name} line ${parsed.line}: ${parsed.error}`); continue; }
      all.push(...parsed.steps.map(s => ({ ...s, template: t.name })));
    }
    return { steps: all, problems };
  }

  async function diffDevice(d) {
    const { steps, problems } = stepsFor(d);
    if (problems.length) return { problems, diff: [] };
    if (!steps.length) return { problems: [], diff: [], none: true };
    if (platformOf(d) === 'routeros') {
      const call = ros(d);
      const cache = new Map();
      const read = async (path) => {
        if (!cache.has(path)) cache.set(path, await call('GET', '/rest' + path).catch(e => (e.status === 404 || e.status === 400 ? undefined : Promise.reject(e))));
        return cache.get(path);
      };
      return { problems: [], diff: (await diffRouterOS(steps, read)).map((x, i) => ({ ...x, template: steps.find(s => s.line === x.line)?.template })) };
    }
    const driver = await driverFor(d, { sshExec });
    const configs = {};
    for (const c of [...new Set(steps.map(s => s.config))]) { const r = await driver.uciGetAll(c); if (r.ok) configs[c] = r.values; }
    return { problems: [], diff: diffOpenWrt(steps, configs) };
  }

  const saveStatus = (d, status, diff, error, applied) => db.prepare(`INSERT INTO device_config_status (device_id, status, diff_json, error, checked_at, applied_at) VALUES (?,?,?,?,datetime('now'),?)
    ON CONFLICT(device_id) DO UPDATE SET status=excluded.status, diff_json=excluded.diff_json, error=excluded.error, checked_at=excluded.checked_at,
      applied_at=COALESCE(excluded.applied_at, device_config_status.applied_at)`).run(d.id, status, JSON.stringify(diff || []), error || null, applied ? new Date().toISOString() : null);

  async function checkDevice(d) {
    try {
      const r = await diffDevice(d);
      if (r.none) { db.prepare('DELETE FROM device_config_status WHERE device_id=?').run(d.id); return { status: 'none', diff: [] }; }
      const status = r.problems.length ? 'error' : r.diff.some(x => x.error) ? 'error' : r.diff.length ? 'drifted' : 'in-sync';
      saveStatus(d, status, r.diff, r.problems.join('; ') || null);
      if (status !== 'error') observe(d, 'config', status === 'in-sync' ? 1 : 0);
      return { status, diff: r.diff, problems: r.problems };
    } catch (e) { saveStatus(d, 'error', [], e.message); return { status: 'error', error: e.message, diff: [] }; }
  }

  async function applyDevice(d) {
    const r = await diffDevice(d);
    if (r.problems.length) return { ok: false, error: r.problems.join('; ') };
    const errs = r.diff.filter(x => x.error);
    if (errs.length) return { ok: false, error: errs.map(e => e.what).join('; ') };
    if (!r.diff.length) { saveStatus(d, 'in-sync', [], null, true); observe(d, 'config', 1); return { ok: true, changed: 0 }; }
    if (platformOf(d) === 'routeros') {
      const call = ros(d);
      for (const x of r.diff) {
        if (x.action === 'set') await call('POST', '/rest' + x.path + '/set', x.body);
        else if (x.action === 'patch') await call('PATCH', '/rest' + x.path + '/' + encodeURIComponent(x.id), x.body);
        else if (x.action === 'add') await call('PUT', '/rest' + x.path, x.body);
      }
    } else {
      const driver = await driverFor(d, { sshExec });
      const out = await driver.stageApply(r.diff.map(x => x.op));
      if (!out.ok) return { ok: false, error: out.error };
    }
    const after = await checkDevice(d);
    if (after.status === 'in-sync') db.prepare("UPDATE device_config_status SET applied_at=datetime('now') WHERE device_id=?").run(d.id);
    return { ok: after.status === 'in-sync', changed: r.diff.length, status: after.status, remaining: after.diff };
  }

  // templates CRUD
  const tplRow = (t) => ({ ...t, defaults: (() => { try { return JSON.parse(t.defaults_json || '{}'); } catch { return {}; } })(),
    devices: db.prepare('SELECT COUNT(*) n FROM device_templates WHERE template_id=?').get(t.id).n });
  function validTpl(b) {
    if (!String(b.name || '').trim()) return 'Name the template';
    if (!TPL_PLATFORMS.includes(b.platform)) return 'Choose MikroTik (routeros) or OpenWrt';
    // Parse with every variable filled in, so syntax errors show now rather than on the router.
    const probe = String(b.body || '').replace(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g, 'x');
    const p = b.platform === 'routeros' ? parseRouterOS(probe) : parseOpenWrt(probe);
    return p.error ? `Line ${p.line}: ${p.error}` : null;
  }
  app.get('/api/config-templates', requireNoc, (req, res) => res.json(db.prepare('SELECT * FROM config_templates ORDER BY platform, name').all().map(tplRow)));
  app.post('/api/config-templates', requireNoc, (req, res) => {
    const b = req.body || {}; const err = validTpl(b); if (err) return res.status(400).json({ error: err });
    const info = db.prepare('INSERT INTO config_templates (name, platform, description, body, defaults_json, created_by) VALUES (?,?,?,?,?,?)')
      .run(String(b.name).trim().slice(0, 120), b.platform, String(b.description || '').slice(0, 500), String(b.body || ''), JSON.stringify(typeof b.defaults === 'string' ? parseVars(b.defaults) : (b.defaults || {})), (req.user && req.user.email) || null);
    audit(req, 'create', 'config-template#' + info.lastInsertRowid, b.name);
    res.json({ id: Number(info.lastInsertRowid) });
  });
  app.put('/api/config-templates/:id', requireNoc, (req, res) => {
    const t = db.prepare('SELECT * FROM config_templates WHERE id=?').get(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
    const b = { ...t, ...req.body }; const err = validTpl(b); if (err) return res.status(400).json({ error: err });
    db.prepare("UPDATE config_templates SET name=?, platform=?, description=?, body=?, defaults_json=?, updated_at=datetime('now') WHERE id=?")
      .run(String(b.name).trim().slice(0, 120), b.platform, String(b.description || '').slice(0, 500), String(b.body || ''),
        JSON.stringify(typeof req.body.defaults === 'string' ? parseVars(req.body.defaults) : (req.body.defaults || JSON.parse(t.defaults_json || '{}'))), t.id);
    audit(req, 'edit', 'config-template#' + t.id, b.name);
    res.json({ ok: true });
  });
  app.delete('/api/config-templates/:id', requireNoc, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) n FROM device_templates WHERE template_id=?').get(req.params.id).n;
    if (n) return res.status(409).json({ error: `Used by ${n} device(s) — remove it from them first` });
    db.prepare('DELETE FROM config_templates WHERE id=?').run(req.params.id);
    audit(req, 'delete', 'config-template#' + req.params.id, '');
    res.json({ ok: true });
  });
  app.get('/api/config-vars', requireNoc, (req, res) => res.json(globalVars()));
  app.put('/api/config-vars', requireNoc, (req, res) => {
    const v = typeof req.body.text === 'string' ? parseVars(req.body.text) : (req.body.vars || {});
    setSetting('config_vars', JSON.stringify(v));
    audit(req, 'edit', 'settings', 'configuration variables');
    res.json({ ok: true, vars: v });
  });

  // per device
  app.get('/api/devices/:id/config', requireNoc, (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const assigned = db.prepare('SELECT t.id, t.name, t.platform, dt.vars_json FROM device_templates dt JOIN config_templates t ON t.id=dt.template_id WHERE dt.device_id=? ORDER BY dt.position, t.id').all(d.id)
      .map(t => ({ ...t, vars: JSON.parse(t.vars_json || '{}'), matches_platform: t.platform === platformOf(d) }));
    const st = db.prepare('SELECT * FROM device_config_status WHERE device_id=?').get(d.id);
    const { steps, problems } = stepsFor(d);
    res.json({ platform: platformOf(d), assigned, available: db.prepare('SELECT id, name FROM config_templates WHERE platform=? ORDER BY name').all(platformOf(d)),
      status: st ? { ...st, diff: JSON.parse(st.diff_json || '[]') } : null, steps: steps.length, problems,
      system_vars: systemVars(d) });
  });
  app.put('/api/devices/:id/config', requireNoc, (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const list = Array.isArray((req.body || {}).templates) ? req.body.templates : [];
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM device_templates WHERE device_id=?').run(d.id);
      list.forEach((t, i) => {
        const tpl = db.prepare('SELECT id FROM config_templates WHERE id=?').get(Number(t.id));
        if (tpl) db.prepare('INSERT INTO device_templates (device_id, template_id, vars_json, position) VALUES (?,?,?,?)')
          .run(d.id, tpl.id, JSON.stringify(typeof t.vars === 'string' ? parseVars(t.vars) : (t.vars || {})), i);
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return res.status(400).json({ error: e.message }); }
    audit(req, 'edit', 'device#' + d.id, `configuration templates: ${list.length}`);
    res.json({ ok: true });
  });
  app.post('/api/devices/:id/config/check', requireNoc, async (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    res.json(await checkDevice(d));
  });
  app.post('/api/devices/:id/config/apply', requireNoc, async (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    try {
      const r = await applyDevice(d);
      audit(req, 'config_push', 'device#' + d.id, r.ok ? `templates applied (${r.changed} change(s))` : 'templates failed: ' + r.error);
      res.status(r.ok ? 200 : 502).json(r);
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // =========================== sampler hooks ===========================
  async function everyFiveMinutes(d) {
    if (!['routeros', 'openwrt'].includes(platformOf(d))) return;
    try { await sampleResources(d); } catch {}
    if (can(d, 'wifiClients') && d.wifi_json) { try { await sampleWifi(d); } catch {} }
  }
  async function hourly() {
    const ids = db.prepare('SELECT DISTINCT device_id FROM device_templates').all().map(r => r.device_id);
    for (const id of ids) { const d = device(id); if (d && d.mgmt_address && !d.archived_at) { try { await checkDevice(d); } catch {} } }
    // Keep 60 days of resources; Wi-Fi sessions for a year.
    db.prepare('DELETE FROM dev_resources WHERE ts<?').run(new Date(Date.now() - 60 * 86400000).toISOString());
    db.prepare('DELETE FROM wifi_sessions WHERE ended_at IS NOT NULL AND ended_at<?').run(new Date(Date.now() - 365 * 86400000).toISOString());
    // A session left open by a router that stopped answering is closed after a day.
    db.prepare('UPDATE wifi_sessions SET ended_at=last_seen WHERE ended_at IS NULL AND last_seen<?').run(new Date(Date.now() - 86400000).toISOString());
  }

  ctx.monitoring = { everyFiveMinutes, hourly, sampleResources, sampleWifi, checkDevice, applyDevice, oui };
}
