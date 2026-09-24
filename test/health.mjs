// Health checks, alerts and notifications.
//
// Three layers: the pure state machine (lib/health.js), the domain module driven directly against
// its own throwaway database so observe() and flush() can be exercised minute by minute without a
// sampler or real routers, and the HTTP API on the server test/run.mjs started.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, healthOf, effectiveRule, validateRule, eventMessage, METRICS } from '../lib/health.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const MIN = 60000, T0 = Date.UTC(2026, 8, 24, 12, 0);

// ---- the state machine ----
{
  const rule = { enabled: true, op: '<', threshold: 1, tolerance_min: 5 };
  let s = null, e;
  ({ state: s, event: e } = step(s, rule, 0, T0));
  ok(!e && s.breach_since === T0 && !s.firing, 'a first failure starts the clock but alerts nobody');
  ({ state: s, event: e } = step(s, rule, 0, T0 + 4 * MIN));
  ok(!e && !s.firing, 'still inside the tolerance: nothing yet');
  ({ state: s, event: e } = step(s, rule, 0, T0 + 5 * MIN));
  ok(e && e.kind === 'alert' && s.firing === 1 && e.since === T0, 'at the tolerance the alert fires, dated from when it started');
  ({ state: s, event: e } = step(s, rule, 0, T0 + 60 * MIN));
  ok(!e && s.firing, 'an hour later it is still firing, and has not fired again');
  ({ state: s, event: e } = step(s, rule, 1, T0 + 61 * MIN));
  ok(e && e.kind === 'recovery' && !s.firing && s.breach_since == null, 'the first good value sends one recovery');

  let b = null;
  ({ state: b } = step(b, rule, 0, T0));
  ({ state: b, event: e } = step(b, rule, 1, T0 + 2 * MIN));
  ok(!e && b.breach_since == null, 'a blip shorter than the tolerance never alerts, and sends no recovery either');

  const lat = { enabled: true, op: '>', threshold: 150, tolerance_min: 0 };
  ok(step(null, lat, 151, T0).event.kind === 'alert' && !step(null, lat, 150, T0).event, '"above" means strictly above; tolerance 0 alerts at once');
  let f = step(null, lat, 300, T0).state;
  const off = step(f, { ...lat, enabled: false }, 300, T0 + MIN);
  ok(!off.event && !off.state.firing, 'switching a rule off clears it without a false "recovered"');
  ok(!step(null, lat, null, T0).event, 'a missing value is not a breach');
}

// ---- rules and status ----
{
  const r = effectiveRule('latency', { latency: { threshold: 200 } }, { latency: { tolerance_min: 2 } });
  ok(r.threshold === 200 && r.tolerance_min === 2 && r.op === '>' && r.source === 'device', 'device overrides global overrides built-in, field by field');
  ok(effectiveRule('reachable').source === 'default' && effectiveRule('reachable').tolerance_min === 5, 'built-in: unreachable for 5 minutes');
  ok(validateRule('latency', { tolerance_min: 2.5 }).error && validateRule('latency', { op: '=' }).error && validateRule('nope', {}).error, 'bad rules are refused');
  ok(validateRule('latency', { threshold: '120', enabled: true }).rule.threshold === 120, 'good ones are normalised');

  const now = T0;
  const st = (metric, extra = {}) => ({ metric, observed_at: now - MIN, firing: 0, ...extra });
  ok(healthOf({ archived: true, monitored: true }, [], now) === 'deactivated', 'archived → deactivated');
  ok(healthOf({ archived: false, monitored: false }, [], now) === 'unmonitored', 'nothing to check with → not monitored');
  ok(healthOf({ monitored: true }, [], now) === 'unknown', 'monitored but never observed → unknown');
  ok(healthOf({ monitored: true }, [st('reachable')], now) === 'ok', 'observed and quiet → ok');
  ok(healthOf({ monitored: true }, [st('reachable'), st('latency', { firing: 1 })], now) === 'problem', 'a non-critical alert → problem');
  ok(healthOf({ monitored: true }, [st('reachable', { firing: 1 }), st('latency', { firing: 1 })], now) === 'critical', 'unreachable → critical');
  ok(healthOf({ monitored: true }, [st('reachable', { breach_since: now - MIN })], now) === 'ok', 'failing but inside the tolerance does not change the status');
  ok(healthOf({ monitored: true }, [st('reachable', { observed_at: now - 20 * MIN })], now) === 'unknown', 'nothing heard for 20 minutes → unknown');
  ok(eventMessage('latency', 'alert', 'Edge', 212.4, { threshold: 150 }) === 'Edge has high WAN latency (212ms, limit 150ms)', 'messages carry the value and the limit');
  ok(METRICS.reachable.critical && !METRICS.latency.critical, 'reachability is the critical check');
}

// ---- the domain module, against its own database ----
{
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'health-')), 'h.db');
  const dbmod = await import('../db.js');
  dbmod.initSchema(); dbmod.migrate();
  const { db } = dbmod;
  const { default: registerHealth } = await import('../domains/health.js');
  const routes = {};
  const app = new Proxy({}, { get: (_, m) => (path, ...h) => { routes[m + ' ' + path] = h[h.length - 1]; } });
  const mails = [], texts = [];
  const ctx = { db, requireNoc: (q, r, n) => n(), audit: () => {}, role: () => 'admin', getSetting: () => 'https://noc.example',
    sendMailBest: async (m) => { mails.push(m); return { ok: true }; }, sendSms: async (to, body) => { texts.push({ to, body }); return { ok: true }; } };
  registerHealth(app, ctx);
  const H = ctx.health;

  const u = (name, email, role) => Number(db.prepare('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)').run(name, email, 'x', role).lastInsertRowid);
  const noc = u('Nia', 'nia@x.example', 'noc'), adm = u('Ada', 'ada@x.example', 'admin'), sup = u('Sam', 'sam@x.example', 'support');
  u('Gone', 'gone@x.example', 'noc'); db.prepare("UPDATE users SET active=0 WHERE email='gone@x.example'").run();
  db.prepare("INSERT INTO accounts (name) VALUES ('A')").run();
  db.prepare("INSERT INTO sites (account_id, name) VALUES (1, 'Riverside')").run();
  const dev = (name) => {
    const id = Number(db.prepare(`INSERT INTO devices (name, status, online, management_mode, platform, mgmt_address, admin_password, assigned_type, assigned_site_id)
      VALUES (?, 'Deployed', 1, 'platform', 'routeros', '10.1.1.1', 'pw', 'site', 1)`).run(name).lastInsertRowid);
    return () => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  };
  const a = dev('Edge A'), b = dev('Edge B'), m = dev('Edge M');

  // Two routers drop in the same minute.
  for (let t = 0; t <= 5; t++) for (const d of [a, b]) H.observe(d(), 'reachable', 0, T0 + t * MIN);
  ok(db.prepare("SELECT COUNT(*) n FROM alert_events WHERE kind='alert'").get().n === 2, 'both alerts recorded once each');
  ok(a().online === 0, "the device's online flag follows the alert");
  ok(H.healthFor(a(), T0 + 5 * MIN) === 'critical', 'and its health is critical');
  await H.flush();
  const toNia = mails.filter(x => x.to === 'nia@x.example');
  ok(toNia.length === 1 && /2 alerts/.test(toNia[0].subject) && /Edge A/.test(toNia[0].text) && /Edge B/.test(toNia[0].text), 'NOC gets ONE email listing both devices');
  ok(/Riverside/.test(toNia[0].text) && /https:\/\/noc\.example\/#\/device\//.test(toNia[0].text), 'naming the site, with a link to each device');
  ok(mails.some(x => x.to === 'ada@x.example') && !mails.some(x => x.to === 'sam@x.example') && !mails.some(x => x.to === 'gone@x.example'),
    'admins too; support staff not by default; deactivated users never');
  ok(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get(noc).n === 2 && db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get(sup).n === 0,
    'the bell gets a line per device for NOC, nothing for support');
  mails.length = 0; await H.flush();
  ok(mails.length === 0, 'flushing again sends nothing — each event is told once');

  // Muted for maintenance: recorded, not told.
  db.prepare('UPDATE devices SET monitor_muted_until=? WHERE id=?').run(new Date(Date.now() + 3600000).toISOString(), m().id);
  for (let t = 0; t <= 5; t++) H.observe(m(), 'reachable', 0, Date.now() + t * MIN);
  await H.flush();
  ok(db.prepare("SELECT suppressed FROM alert_events WHERE device_id=?").get(m().id).suppressed === 1 && mails.length === 0, 'a muted device records its alert but tells nobody');

  // Recovery, with one person opting out of recoveries and into texts.
  db.prepare('INSERT INTO notify_prefs (user_id, email, sms, phone, recoveries) VALUES (?,?,?,?,?)').run(adm, 1, 1, '+16025550100', 1);
  db.prepare('INSERT INTO notify_prefs (user_id, recoveries) VALUES (?,0)').run(noc);
  H.observe(a(), 'reachable', 1, T0 + 30 * MIN);
  ok(a().online === 1, 'back online on recovery');
  await H.flush();
  ok(mails.some(x => x.to === 'ada@x.example' && /Recovered: Edge A is reachable again/.test(x.subject)), 'the recovery is emailed');
  ok(!mails.some(x => x.to === 'nia@x.example'), 'except to someone who turned recoveries off');
  ok(texts.length === 1 && texts[0].to === '+16025550100' && /Edge A/.test(texts[0].body), 'and texted to someone who asked for texts');

  // WAN down while still reachable: a problem, not critical.
  for (let t = 0; t <= 5; t++) { H.observe(b(), 'reachable', 1, T0 + (40 + t) * MIN); H.observe(b(), 'wan_ping', 0, T0 + (40 + t) * MIN); }
  ok(H.healthFor(b(), T0 + 45 * MIN) === 'problem', 'reachable but no internet → problem');

  // A per-device rule override is used by observe().
  const put = routes['put /api/devices/:id/health/rules/:metric'];
  let status = 200; const res = { status: (c) => { status = c; return res; }, json: () => res };
  put({ params: { id: String(a().id), metric: 'latency' }, body: { threshold: 20, tolerance_min: 0 }, user: { email: 'x' } }, res);
  const ev = H.observe(a(), 'latency', 25, T0 + 50 * MIN);
  ok(status === 200 && ev && ev.kind === 'alert', 'a device-level rule (20 ms, no tolerance) takes effect immediately');
}

// ---- HTTP ----
{
  const B = process.env.BASE ?? 'http://localhost:3000';
  const client = () => { let cookie = ''; return async (p, { method = 'GET', body } = {}) => {
    const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
    if (cookie) h.cookie = cookie;
    const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j };
  }; };
  const admin = client(); await admin('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  const sup = client(); await sup('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });

  const rules = (await admin('/api/health/rules')).json;
  ok(rules.length === 3 && rules.find(r => r.metric === 'reachable').tolerance_min === 5, 'the rules list the three checks with their defaults');
  ok((await admin('/api/health/rules/latency', { method: 'PUT', body: { threshold: 'lots' } })).status === 400, 'a bad rule is refused');
  ok((await sup('/api/health/rules/latency', { method: 'PUT', body: { threshold: 90 } })).status === 403, 'support staff cannot change rules');
  ok((await admin('/api/health/rules/latency', { method: 'PUT', body: { threshold: 120 } })).status === 200
    && (await admin('/api/health/rules')).json.find(r => r.metric === 'latency').threshold === 120, 'NOC/admin can');

  const devs = (await admin('/api/devices')).json;
  const d = devs.find(x => x.name === 'Edge Router');
  const h = (await admin('/api/devices/' + d.id + '/health')).json;
  ok(h.status && Array.isArray(h.checks) && h.checks.length === 3 && h.monitored === true, 'a device reports its health and each check');
  ok((await admin('/api/devices/' + d.id + '/health/mute', { body: { hours: 0 } })).status === 400, 'mute needs a duration');
  ok((await admin('/api/devices/' + d.id + '/health/mute', { body: { hours: 2, reason: 'fiber cut repair' } })).status === 200
    && (await admin('/api/devices/' + d.id + '/health')).json.mute_reason === 'fiber cut repair', 'a device can be muted for maintenance, with a reason');
  ok((await sup('/api/devices/' + d.id + '/health/mute', { method: 'DELETE' })).status === 403, 'support cannot unmute');
  ok((await admin('/api/devices/' + d.id + '/health/mute', { method: 'DELETE' })).status === 200 && !(await admin('/api/devices/' + d.id + '/health')).json.muted_until, 'and it can be unmuted');

  const st = (await admin('/api/health/status')).json;
  ok(st[d.id] && Object.values(st).every(v => ['critical', 'problem', 'ok', 'unknown', 'unmonitored', 'deactivated'].includes(v)), 'status for every device in one call, for lists');
  const sum = (await admin('/api/health/summary')).json;
  ok(sum.counts && Array.isArray(sum.firing), 'the summary has counts and what is firing');

  ok((await admin('/api/notifications/prefs', { method: 'PUT', body: { sms: true, phone: '' } })).status === 400, 'texts need a phone number');
  ok((await admin('/api/notifications/prefs', { method: 'PUT', body: { email: false, sms: true, phone: '602-555-0100' } })).status === 200, 'prefs are saved');
  const p = (await admin('/api/notifications/prefs')).json;
  ok(p.email === false && p.sms === true && /6025550100/.test(p.phone), 'and read back');
  const sp = (await sup('/api/notifications/prefs')).json;
  ok(sp.email === false && sp.web === false, "each person's prefs are their own; support defaults to off");
  const n = (await admin('/api/notifications')).json;
  ok(typeof n.unread === 'number' && Array.isArray(n.items), 'the bell reads its list');
  ok((await admin('/api/notifications/read', { body: {} })).status === 200 && (await admin('/api/notifications/count')).json.unread === 0, 'mark all read');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
