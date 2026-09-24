// Demo mode: the same application, with pretend data, live-looking traffic, and no way to touch
// anything real.
//
// Three layers, from hardest to softest:
//
//   1. lib/demoguard.js — every outbound connection in the process is refused unless it is to
//      loopback. This is the guarantee: no code path, present or future, can reach a router, a
//      mailbox, Twilio, Stripe or ZeroTier from the demo, because the socket itself will not open.
//   2. demoGate (below) — refuses the handful of changes that would spoil the demo for the next
//      visitor or take over the demo itself: users, settings, mail setup, device tokens. Everything
//      else can be created, edited and deactivated freely; the database is thrown away nightly.
//   3. The read overrides — the live device panels (DHCP leases, Wi-Fi clients, the sampler status)
//      would otherwise just say "could not reach the router". They answer with plausible, generated
//      data instead, so a visitor can see what the feature looks like.
//
// The traffic graphs are the headline, so they get real rhythm: production publishes anonymised
// weekly shapes (lib/trafficshape.js) on a token-protected loopback-only route, the demo fetches
// them at start, and a simulator writes samples every minute exactly where the real sampler would.
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEMO, DEMO_REFUSAL } from '../lib/demoguard.js';
import { shapesFromDb, sanitizeShapes, syntheticShapes, sampleAt, latencyAt, backfillTimes, mulberry32 } from '../lib/trafficshape.js';
import { DEMO_EMAIL, DEMO_PASSWORD, demoRouters } from '../lib/demodata.js';

export { DEMO };
export const DEMO_INFO = { email: DEMO_EMAIL, password: DEMO_PASSWORD, resets: 'nightly' };

// ---- 2. what a visitor may not change ----------------------------------------------------------

// Prefixes under /api where any write is refused. Reads still work, so the pages render.
const BLOCKED_API = ['/users', '/settings', '/mail', '/tokens', '/zerotier', '/wireguard', '/packages', '/m/session'];
// Public, non-/api surfaces that would accept data from strangers or act for a real device.
const BLOCKED_PUBLIC = [
  [/^\/inbound\//, 404],                 // provider webhooks: nothing real should ever post here
  [/^\/stripe\/webhook$/, 404],
  [/^\/provision\//, 404],               // router phone-home
  [/^\/access$/, 403, 'POST'],           // visitor check-in takes an ID photo; not from the public, not in a demo
  [/^\/pay\/[^/]+\/checkout$/, 403, 'POST'],
  [/^\/portal\/(login|login-link)$/, 403, 'POST']
];
const MAX_DEMO_BODY = 8 * 1024 * 1024;   // uploads: enough to try the feature, not to fill the disk

export function demoRefusal(method, path) {
  const m = String(method || 'GET').toUpperCase();
  if (path.startsWith('/api/')) {
    if (m === 'GET' || m === 'HEAD') return null;
    const rest = path.slice(4);
    if (BLOCKED_API.some(p => rest === p || rest.startsWith(p + '/'))) return { status: 403, error: 'Disabled in the demo: users, settings, mail setup and device tokens cannot be changed here.' };
    return null;
  }
  for (const [re, status, only] of BLOCKED_PUBLIC) {
    if (re.test(path) && (!only || only === m)) return { status, error: status === 404 ? 'Not found' : 'Disabled in the demo.' };
  }
  return null;
}

/** Registered before every route, including the raw-body webhooks, so nothing gets past it. */
export function demoGate(req, res, next) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_DEMO_BODY) return res.status(413).json({ error: 'Uploads are limited to 8 MB in the demo.' });
  const refuse = demoRefusal(req.method, req.path);
  if (refuse) return res.status(refuse.status).json({ error: refuse.error });
  res.setHeader('X-Demo', '1');
  next();
}

// ---- 3. the live panels ------------------------------------------------------------------------

const VENDORS_OUI = ['3C:22:FB', 'F0:18:98', 'A4:83:E7', 'DC:A6:32', '00:1B:63', '88:66:5A', 'B8:27:EB', '7C:D1:C3'];
const HOSTS = ['FRONT-DESK', 'iPhone', 'Galaxy-S24', 'HP-LaserJet', 'MacBook-Pro', 'ipad', 'DESKTOP-4K2L', 'Ring-Doorbell',
  'Sonos-Office', 'Surface-Laptop', 'Pixel-8', 'Polycom-VVX', 'Chromecast', 'NVR-Cameras', 'Brother-MFC', 'Thermostat'];

/** Deterministic per device and per hour, so a refresh looks like the same network, a little later. */
function fakeClients(deviceId, n) {
  const hour = Math.floor(Date.now() / 3600000);
  const R = mulberry32(deviceId * 7919 + hour);
  const stable = mulberry32(deviceId * 104729);
  const out = [];
  for (let i = 0; i < n; i++) {
    const oui = VENDORS_OUI[Math.floor(stable() * VENDORS_OUI.length)];
    const mac = oui + ':' + [0, 0, 0].map(() => Math.floor(stable() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
    out.push({ mac, host: HOSTS[Math.floor(stable() * HOSTS.length)], ip: `192.168.88.${20 + i}`, R });
  }
  return out;
}

export function registerDemo(app, ctx) {
  if (!DEMO) return;
  const { db } = ctx;
  const device = (id) => db.prepare('SELECT id, name, wifi_json, assigned_type FROM devices WHERE id=?').get(id);

  app.get('/api/devices/:id/dhcp-leases', (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const leases = fakeClients(d.id, 6 + (d.id % 9)).map((c, i) => ({
      id: '*' + (i + 1).toString(16), address: c.ip, mac: c.mac, host: c.host, status: c.R() < 0.9 ? 'bound' : 'waiting',
      dynamic: i > 1, expires: `${Math.floor(c.R() * 9) + 1}h${Math.floor(c.R() * 59)}m`, server: 'defconf', comment: i <= 1 ? 'reserved' : ''
    }));
    res.json({ leases });
  });

  app.get('/api/devices/:id/wifi-clients', (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    let radios = []; try { radios = (JSON.parse(d.wifi_json || '{}').radios) || []; } catch {}
    if (!radios.length) return res.json({ system: null, clients: [] });
    const clients = fakeClients(d.id, 4 + (d.id % 8)).map((c, i) => {
      const r = radios[i % radios.length];
      const signal = -Math.round(42 + c.R() * 38);
      return { iface: r.iface, ssid: r.ssid, mac: c.mac, signal, snr: Math.max(5, 92 + signal), lastIp: c.ip, comment: '',
        txRate: `${[144, 286, 573, 1201][Math.floor(c.R() * 4)]}Mbps`, rxRate: `${[72, 144, 286, 573][Math.floor(c.R() * 4)]}Mbps`,
        uptime: `${Math.floor(c.R() * 20)}h${Math.floor(c.R() * 59)}m` };
    });
    res.json({ system: 'wifi', clients });
  });

  app.get('/api/devices/:id/wifi', (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    let w = null; try { w = JSON.parse(d.wifi_json || 'null'); } catch {}
    if (!w) return res.json({ system: null, radios: [] });
    // The passphrase is not shown in the demo: there is none, and a made-up one would be misleading.
    res.json({ system: w.system, radios: (w.radios || []).map((r, i) => ({ id: '*' + i, iface: r.iface, ssid: r.ssid, password: '', disabled: !!r.disabled, band: r.band })) });
  });

  app.get('/api/devices/:id/sampler', (req, res) => {
    const d = device(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const n = db.prepare('SELECT COUNT(*) n FROM iface_traffic WHERE device_id=?').get(d.id).n;
    const l = db.prepare('SELECT COUNT(*) n FROM dev_latency WHERE device_id=?').get(d.id).n;
    res.json({ enabled: true, demo: true, last: n ? { ok: true, at: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(), ifaces: 1, error: null } : null,
      traffic_rows: n, latency_rows: l, platform: 'routeros', transport: 'auto', note: 'Demo: traffic is simulated from the shape of real network traffic.' });
  });
}

// ---- traffic: production's side ----------------------------------------------------------------

/**
 * GET /internal/traffic-shape — production only, and only for the demo on the same machine.
 *
 * Off unless DEMO_SHAPE_TOKEN is set. Refused unless the request arrived on the loopback socket AND
 * carries no proxy headers — nginx adds X-Real-IP/X-Forwarded-For to everything it forwards, so a
 * request from the internet cannot satisfy both, even though nginx itself connects from 127.0.0.1.
 * And the token must match. What it returns is described at the top of lib/trafficshape.js: curves
 * and nothing else.
 */
export function registerShapeExport(app, ctx) {
  const token = process.env.DEMO_SHAPE_TOKEN || '';
  if (DEMO || token.length < 32) return;
  let cache = null;
  app.get('/internal/traffic-shape', (req, res) => {
    const peer = String((req.socket && req.socket.remoteAddress) || '');
    const loop = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const proxied = req.headers['x-real-ip'] || req.headers['x-forwarded-for'];
    const given = Buffer.from(String(req.headers['x-shape-token'] || ''));
    const want = Buffer.from(token);
    if (!loop || proxied || given.length !== want.length || !timingSafeEqual(given, want)) return res.status(404).type('text/plain').send('Not found');
    if (!cache || Date.now() - cache.at > 6 * 3600000) cache = { at: Date.now(), body: shapesFromDb(ctx.db) };
    res.setHeader('Cache-Control', 'no-store');
    res.json(cache.body);
  });
}

// ---- traffic: the demo's side ------------------------------------------------------------------

/**
 * A few past alerts and recoveries, so the history on the Alerts page is not empty on day one.
 * Marked as already notified: they are history, not news.
 */
function demoAlertHistory(db, routers) {
  const ins = db.prepare("INSERT INTO alert_events (device_id, metric, kind, value, message, since, notified_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),?)");
  const name = (id) => (db.prepare('SELECT name FROM devices WHERE id=?').get(id) || {}).name || 'Router';
  const sql = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const now = Date.now();
  routers.slice(1, 4).forEach((r, i) => {
    const start = now - (2 + i * 3) * 86400000 - (3 + i) * 3600000, end = start + (20 + i * 25) * 60000;
    const [metric, bad, good, a, b] = i === 1
      ? ['latency', 240 + i * 30, 18, 'has high WAN latency', 'WAN latency is back to normal']
      : ['wan_ping', 0, 1, 'cannot reach the internet', 'can reach the internet again'];
    ins.run(r.id, metric, 'alert', bad, `${name(r.id)} ${a}`, new Date(start).toISOString(), sql(start));
    ins.run(r.id, metric, 'recovery', good, `${name(r.id)} ${b}`, new Date(start).toISOString(), sql(end));
  });
}

async function loadShapes(dbPath) {
  const cacheFile = join(dirname(dbPath), 'traffic-shapes.json');
  const url = process.env.DEMO_SHAPE_URL, token = process.env.DEMO_SHAPE_TOKEN;
  if (url && token) {
    try {
      const r = await fetch(url, { headers: { 'x-shape-token': token }, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const s = sanitizeShapes(await r.json());
        if (s.profiles.length) {
          try { writeFileSync(cacheFile, JSON.stringify(s)); } catch {}
          return { shapes: s, source: 'production' };
        }
      }
      console.warn('Demo: traffic shapes unavailable (HTTP ' + r.status + ')');
    } catch (e) { console.warn('Demo: could not fetch traffic shapes:', e.message); }
  }
  try {
    const s = sanitizeShapes(JSON.parse(readFileSync(cacheFile, 'utf8')));
    if (s.profiles.length) return { shapes: s, source: 'cache' };
  } catch {}
  return { shapes: syntheticShapes(), source: 'synthetic' };
}

/**
 * Start the simulator: backfill 60 days if the database has no traffic yet, then add one sample per
 * WAN port every minute. Each router gets one profile for good (by id), so its graph has a
 * consistent personality across ranges and restarts.
 */
export async function startDemoTraffic(ctx, { dbPath, intervalMs = 60000 } = {}) {
  if (!DEMO) return null;
  const { db } = ctx;
  const { shapes, source } = await loadShapes(dbPath);
  const profiles = shapes.profiles;
  const profileFor = (id) => profiles[id % profiles.length];
  const insT = db.prepare('INSERT INTO iface_traffic (device_id, iface, ts, rx_bps, tx_bps) VALUES (?,?,?,?,?)');
  const insL = db.prepare('INSERT INTO dev_latency (device_id, ts, ms) VALUES (?,?,?)');
  const rand = mulberry32(Date.now() % 2147483647);

  const writeAt = (routers, t) => {
    const ts = new Date(t).toISOString();
    for (const r of routers) {
      const prof = profileFor(r.id);
      let load = 0;
      for (const f of r.ifaces) {
        const s = sampleAt(prof, t, f.peak, rand);
        insT.run(r.id, f.name, ts, s.rx_bps, s.tx_bps);
        load = Math.max(load, s.load);
      }
      insL.run(r.id, ts, latencyAt(r.latency, load, rand));
    }
  };

  let routers = demoRouters(db);
  const have = db.prepare('SELECT COUNT(*) n FROM iface_traffic').get().n;
  if (!have && routers.length) {
    const times = backfillTimes(Date.now());
    db.exec('BEGIN');
    try { for (const t of times) writeAt(routers, t); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`Demo: backfilled ${times.length} samples × ${routers.length} routers from ${source} traffic shapes`);
    demoAlertHistory(db, routers);
  } else {
    console.log(`Demo: traffic simulator using ${source} shapes for ${routers.length} routers`);
  }

  // Health checks, fed from the same simulation. The devices that were generated offline stay
  // unreachable, so a few minutes after a reset their alerts fire and the bell has something real.
  const downIds = new Set(db.prepare("SELECT id FROM devices WHERE status='Deployed' AND online=0 AND archived_at IS NULL").all().map(r => r.id));
  const healthTick = (t) => {
    if (!ctx.health) return;
    const byId = new Map(routers.map(r => [r.id, r]));
    for (const d of db.prepare('SELECT * FROM devices WHERE archived_at IS NULL').all()) {
      if (!ctx.health.isMonitored(d)) continue;
      if (downIds.has(d.id)) { ctx.health.observe(d, 'reachable', 0, t); continue; }
      ctx.health.observe(d, 'reachable', 1, t);
      if (byId.has(d.id)) {
        const last = db.prepare('SELECT ms FROM dev_latency WHERE device_id=? ORDER BY ts DESC LIMIT 1').get(d.id);
        ctx.health.observe(d, 'wan_ping', 1, t);
        if (last) ctx.health.observe(d, 'latency', last.ms, t);
      }
    }
    ctx.health.flush().catch(() => {});
  };
  try { healthTick(Date.now()); } catch (e) { console.warn('Demo health:', e.message); }

  const tick = () => {
    try {
      routers = demoRouters(db);            // a visitor may have tagged a new WAN port or deactivated a router
      db.exec('BEGIN'); writeAt(routers, Math.floor(Date.now() / 60000) * 60000); db.exec('COMMIT');
      healthTick(Date.now());
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
      db.prepare('DELETE FROM iface_traffic WHERE ts<?').run(cutoff);
      db.prepare('DELETE FROM dev_latency WHERE ts<?').run(cutoff);
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.warn('Demo traffic tick:', e.message); }
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return { source, routers: routers.length, stop: () => clearInterval(timer) };
}

export { DEMO_REFUSAL };
