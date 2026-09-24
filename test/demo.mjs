// The public demo: pretend data, real-looking traffic, and no way to reach anything real.
//
// This suite starts its own two servers rather than using the one test/run.mjs provides: a
// "production" one holding some WAN traffic and publishing its shape, and a demo one that fetches
// that shape over loopback — the same arrangement as on the VPS.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildShapes, shapesFromDb, fillGaps, slotOf, SQL_SLOT, SLOTS, SCALE, sampleAt, backfillTimes, sanitizeShapes, syntheticShapes } from '../lib/trafficshape.js';
import { demoRefusal } from '../domains/demo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 'shape-token-' + 'x'.repeat(40);

// ---- the shape maths ----
{
  const g = fillGaps([10, null, null, 40]);
  ok(g[1] === 20 && g[2] === 30, 'gaps are filled by interpolation');
  const w = fillGaps([null, 10, null, null]);
  ok(w.every(v => v === 10), 'one known value fills the whole week');

  const mem = new DatabaseSync(':memory:');
  const times = [Date.UTC(2026, 8, 20, 0, 0), Date.UTC(2026, 8, 23, 13, 47), Date.UTC(2026, 8, 26, 23, 59)];
  ok(times.every(t => mem.prepare(`SELECT ${SQL_SLOT.replaceAll('ts', '?')} AS s`).get(...Array(3).fill(new Date(t).toISOString())).s === slotOf(t)),
    'SQLite and JavaScript agree on which slot of the week a timestamp is in');

  // Two series with a clear daily rhythm, plus one idle port that should be skipped.
  const rows = [];
  for (const series of [0, 1, 2]) for (let s = 0; s < SLOTS; s++) {
    const h = (s % 288) / 12, base = series === 2 ? 0 : (series + 1) * 1e8 * (0.2 + Math.max(0, Math.sin((h - 6) / 24 * 2 * Math.PI)));
    rows.push({ series, slot: s, rx: base, tx: base / 4, rx2: base * base * 1.04, n: 5 });
  }
  const out = buildShapes(rows);
  ok(out.profiles.length === 2, 'an idle port lends no shape');
  ok(out.profiles.every(p => Math.max(...p.rx, ...p.tx) === SCALE), 'each profile is scaled so its busiest slot is exactly 1000 — absolute rates are gone');
  ok(out.profiles.every(p => Math.abs(p.tx[100] / p.rx[100] - 0.25) < 0.02), 'but the download/upload ratio survives');
  ok(JSON.stringify(Object.keys(out).sort()) === '["profiles","slots","version"]' && out.profiles.every(p => JSON.stringify(Object.keys(p).sort()) === '["jitter","rx","tx"]'),
    'a shape contains curves and a jitter figure — nothing else');

  const s = sanitizeShapes({ profiles: [{ rx: out.profiles[0].rx, tx: out.profiles[0].tx, jitter: 0.2, device: 'Edge router', iface: 'ether1' }, { rx: [1, 2], tx: [] }], secret: 'x' });
  ok(s.profiles.length === 1 && !JSON.stringify(s).includes('Edge router') && !('secret' in s), 'the demo keeps only well-formed curves from what it is sent, dropping any extra fields');

  const p = syntheticShapes().profiles[0];
  const samples = [0, 3, 7].map(d => sampleAt(p, Date.UTC(2026, 8, 20 + d, 20), 5e8));
  ok(samples.every(x => x.rx_bps > 0 && x.tx_bps > 0 && x.rx_bps < 5e8 * 3), 'playback never goes negative or wildly past the port\'s peak');
  const bt = backfillTimes(Date.UTC(2026, 8, 23, 12));
  ok(bt.length > 4000 && bt.length < 5000 && bt.every((t, i) => !i || t > bt[i - 1]), `the 60-day backfill is ${bt.length} ordered points, not a quarter of a million`);
}

// ---- the gate ----
{
  ok(demoRefusal('PUT', '/api/users/1') && demoRefusal('POST', '/api/users') && demoRefusal('PUT', '/api/settings'), 'users and settings cannot be changed');
  ok(demoRefusal('PUT', '/api/mail/credential') && demoRefusal('POST', '/api/tokens') && demoRefusal('POST', '/api/m/session'), 'nor mail setup or device tokens');
  ok(!demoRefusal('GET', '/api/users') && !demoRefusal('GET', '/api/settings'), 'but those pages still load');
  ok(!demoRefusal('POST', '/api/customers') && !demoRefusal('PUT', '/api/sites/3'), 'and ordinary records can be created and edited');
  ok(!demoRefusal('POST', '/api/usersettings'), 'prefixes are matched on path segments, not characters');
  ok(demoRefusal('POST', '/inbound/twilio/abc').status === 404 && demoRefusal('POST', '/stripe/webhook').status === 404, 'provider webhooks do not exist in the demo');
  ok(demoRefusal('POST', '/access') && !demoRefusal('GET', '/access'), 'visitor check-in (with its ID photo) cannot be submitted');
}

// ---- the network guard, in a real demo-mode process ----
{
  const script = `
    import './lib/demoguard.js';
    import net from 'node:net';
    const tryConnect = (host, port) => new Promise(res => {
      const s = net.connect({ host, port });
      s.on('connect', () => { s.destroy(); res('connected'); });
      s.on('error', e => res(e.code || e.message));
      setTimeout(() => { s.destroy(); res('timeout'); }, 3000);
    });
    const srv = net.createServer(c => c.end()).listen(0, '127.0.0.1');
    await new Promise(r => srv.on('listening', r));
    const out = {
      router: await tryConnect('10.147.0.18', 443),
      smtp: await tryConnect('smtp.gmail.com', 587),
      numeric: await new Promise(res => { const s = new net.Socket(); s.on('error', e => res(e.code)); s.connect(22, '192.0.2.10'); }),
      fetch: await fetch('https://api.twilio.com/').then(() => 'reached', e => String(e.cause && e.cause.code || e.message)),
      loopback: await tryConnect('127.0.0.1', srv.address().port)
    };
    srv.close();
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { ...process.env, DEMO_MODE: '1' }, encoding: 'utf8', timeout: 20000 });
  let o = {}; try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { console.log(r.stdout, r.stderr); }
  ok(o.router === 'EDEMO', 'a router on the management overlay cannot be reached');
  ok(o.smtp === 'EDEMO' && o.numeric === 'EDEMO', 'nor a mail server, nor anything else, by name or by address');
  ok(o.fetch === 'EDEMO', 'fetch() — Twilio, Stripe, Google, ZeroTier — is refused the same way');
  ok(o.loopback === 'connected', 'while the process can still talk to itself');
}

// ---- production publishes, the demo plays back ----
const PROD_PORT = 4191, DEMO_PORT = 4192;
const PROD_DB = `/tmp/netinv-demo-prod-${process.pid}.db`, DEMO_DB = `/tmp/netinv-demo-demo-${process.pid}.db`;
const clean = () => { for (const f of [PROD_DB, DEMO_DB]) for (const x of ['', '-wal', '-shm']) rmSync(f + x, { force: true }); rmSync(join(dirname(DEMO_DB), 'traffic-shapes.json'), { force: true }); };
clean();
const procs = [];
const start = (env, logTo) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, SAMPLER: 'off', IMAP: 'off', GMAIL: 'off', ...env } });
  p.stdout.on('data', d => logTo.push(String(d))); p.stderr.on('data', d => logTo.push(String(d)));
  procs.push(p); return p;
};
const up = async (port) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/build`)).ok) return true; } catch {} await wait(250); } return false; };

try {
  const prodLog = [];
  start({ DB_PATH: PROD_DB, PORT: String(PROD_PORT), DEMO_SHAPE_TOKEN: TOKEN }, prodLog);
  ok(await up(PROD_PORT), 'production starts');

  // A week of 5-minute WAN samples on one of production's routers, with a name we can look for.
  const pdb = new DatabaseSync(PROD_DB);
  const dev = pdb.prepare("SELECT id FROM devices ORDER BY id LIMIT 1").get();
  pdb.prepare("UPDATE devices SET name='SECRET-CUSTOMER-ROUTER', iface_roles_json=? WHERE id=?").run(JSON.stringify({ 'ether-secret-wan': 'WAN1' }), dev.id);
  const ins = pdb.prepare('INSERT INTO iface_traffic (device_id, iface, ts, rx_bps, tx_bps) VALUES (?,?,?,?,?)');
  const now = Date.now();
  pdb.exec('BEGIN');
  for (let t = now - 7 * 86400000; t <= now; t += 300000) {
    const h = new Date(t).getUTCHours();
    ins.run(dev.id, 'ether-secret-wan', new Date(t).toISOString(), 123456789 + h * 1e6, 23456789 + h * 1e5);
  }
  pdb.exec('COMMIT'); pdb.close();

  const shapeUrl = `http://127.0.0.1:${PROD_PORT}/internal/traffic-shape`;
  const get = (headers = {}) => fetch(shapeUrl, { headers }).then(async r => ({ status: r.status, text: await r.text() }));
  ok((await get()).status === 404, 'the shape route is invisible without the token');
  ok((await get({ 'x-shape-token': TOKEN.slice(0, -1) + 'y' })).status === 404, 'or with the wrong one');
  ok((await get({ 'x-shape-token': TOKEN, 'x-forwarded-for': '203.0.113.9' })).status === 404, 'or through the proxy, even with the right one');
  ok((await get({ 'x-shape-token': TOKEN, 'x-real-ip': '203.0.113.9' })).status === 404, '(either proxy header)');
  const good = await get({ 'x-shape-token': TOKEN });
  let shapes = {}; try { shapes = JSON.parse(good.text); } catch {}
  ok(good.status === 200 && shapes.profiles && shapes.profiles.length === 1, 'the demo, on loopback with the token, gets the shape');
  ok(!/SECRET|ether-secret|123456789|23456789/.test(good.text) && !good.text.includes(`"${dev.id}"`),
    'and it carries no device name, interface name or real traffic figure');

  const demoLog = [];
  start({ DEMO_MODE: '1', DB_PATH: DEMO_DB, PORT: String(DEMO_PORT), HOST: '127.0.0.1', DEMO_SHAPE_URL: shapeUrl, DEMO_SHAPE_TOKEN: TOKEN }, demoLog);
  ok(await up(DEMO_PORT), 'the demo starts');
  for (let i = 0; i < 60 && !/Demo: backfilled/.test(demoLog.join('')); i++) await wait(250);
  ok(/backfilled .* from production traffic shapes/.test(demoLog.join('')), 'and plays back production\'s shape, not the synthetic stand-in');

  const B = `http://127.0.0.1:${DEMO_PORT}`;
  let cookie = '';
  const call = async (p, { method = 'GET', body } = {}) => {
    const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
    if (cookie) h.cookie = cookie;
    const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j };
  };
  const build = (await call('/api/build')).json;
  ok(build.demo && build.demo.email && build.demo.password, 'the login page is told the demo sign-in');
  ok((await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } })).status === 401, 'the default seed accounts do not exist in the demo');
  ok((await call('/api/login', { body: { email: build.demo.email, password: build.demo.password } })).status === 200, 'the demo sign-in works');

  const sites = (await call('/api/sites')).json, devices = (await call('/api/devices')).json;
  ok(sites.length >= 10 && devices.length >= 25, `a made-up company is there to explore (${sites.length} sites, ${devices.length} devices)`);
  ok(sites.every(s => /, (Phoenix|Tempe|Mesa|Scottsdale|Chandler|Glendale|Gilbert) AZ/.test(s.service_address || '')), 'with Phoenix-area addresses');
  ok(devices.every(d => !d.mgmt_address || /^10\.147\./.test(d.mgmt_address)), 'and management addresses that go nowhere');

  const router = devices.find(d => d.name === 'Edge router' && d.online);
  const t24 = (await call(`/api/devices/${router.id}/wan-traffic?range=24h`)).json;
  const t60 = (await call(`/api/devices/${router.id}/wan-traffic?range=60d`)).json;
  ok(t24.length > 1300 && t60.length > 4000, `traffic graphs have history on first visit (${t24.length} points today, ${t60.length} over 60 days)`);
  ok((await call(`/api/devices/${router.id}/latency?range=24h`)).json.length > 1300, 'and latency');
  ok((await call(`/api/devices/${router.id}/dhcp-leases`)).json.leases.length > 3, 'the DHCP panel shows leases');
  const ap = devices.find(d => /AP/.test(d.name) && d.online);
  ok((await call(`/api/devices/${ap.id}/wifi-clients`)).json.clients.length > 0, 'and the Wi-Fi panel shows clients');

  const poll = await call(`/api/devices/${router.id}/poll`, { body: {} });
  ok(poll.status >= 400 && /Demo mode/.test(poll.json.error), 'polling a router is refused, and says why');
  const bl = await call('/api/blocklist/push', { body: {} });
  ok(bl.status !== 200 || !JSON.stringify(bl.json).includes('"ok":true'), 'pushing the blocklist reaches no router');
  ok((await call('/api/users/1', { method: 'PUT', body: { email: 'takeover@example.com' } })).status === 403, 'the demo account cannot be taken over');
  ok((await call('/api/settings', { method: 'PUT', body: { company_name: 'x' } })).status === 403, 'settings are read-only');
  const acct = (await call('/api/accounts')).json[0];
  const c = await call('/api/customers', { body: { name: 'Visitor Test Co', account_ids: [acct.id] } });
  ok(c.status === 200, 'but a visitor can add a customer, which is the point');
  ok((await fetch(`${B}/inbound/twilio/whatever`, { method: 'POST' })).status === 404, 'provider webhooks are gone');

  const ddb = readFileSync(DEMO_DB).toString('latin1') + (() => { try { return readFileSync(DEMO_DB + '-wal').toString('latin1'); } catch { return ''; } })();
  ok(!ddb.includes('SECRET-CUSTOMER-ROUTER') && !ddb.includes('ether-secret-wan'), 'nothing from production\'s database ended up in the demo\'s');
} finally {
  for (const p of procs) p.kill();
  await wait(300);
  clean();
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
