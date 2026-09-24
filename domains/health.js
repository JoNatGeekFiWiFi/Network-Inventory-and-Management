// Device health, alerts and notifications.
//
// The sampler (domains/network.js) calls ctx.health.observe() for each check on each device every
// minute, then ctx.health.flush() once at the end of the pass. observe() runs the state machine in
// lib/health.js and records any alert or recovery; flush() tells people about them.
//
// Telling people is batched per pass: if a POP goes down and thirty site routers behind it go with
// it, each person gets ONE email (and one text) listing all thirty, not thirty emails. The bell
// still gets a line per event, because that is a list you scan, not a phone that buzzes.
import { METRICS, METRIC_KEYS, HEALTH, effectiveRule, step, healthOf, eventMessage, validateRule } from '../lib/health.js';

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const ms = (s) => (s == null ? null : Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z'));
const PRIV_ROLES = new Set(['noc', 'admin']);

export default function registerHealth(app, ctx) {
  const { db, requireNoc, audit, role } = ctx;

  // ---- rules ----
  function rulesFor(deviceId) {
    const g = {}, d = {};
    for (const r of db.prepare('SELECT * FROM alert_rules WHERE device_id IS NULL').all()) g[r.metric] = strip(r);
    if (deviceId) for (const r of db.prepare('SELECT * FROM alert_rules WHERE device_id=?').all(deviceId)) d[r.metric] = strip(r);
    return { g, d };
  }
  function strip(r) {
    const o = {};
    for (const k of ['enabled', 'op', 'threshold', 'tolerance_min']) if (r[k] !== null && r[k] !== undefined) o[k] = r[k];
    return o;
  }
  function saveRule(deviceId, metric, fields, who) {
    const ex = db.prepare('SELECT id FROM alert_rules WHERE IFNULL(device_id,0)=? AND metric=?').get(deviceId || 0, metric);
    const cols = ['enabled', 'op', 'threshold', 'tolerance_min'];
    if (ex) {
      const sets = cols.filter(c => fields[c] !== undefined);
      if (sets.length) db.prepare(`UPDATE alert_rules SET ${sets.map(c => c + '=?').join(',')}, updated_by=?, updated_at=datetime('now') WHERE id=?`)
        .run(...sets.map(c => fields[c]), who, ex.id);
    } else {
      db.prepare('INSERT INTO alert_rules (device_id, metric, enabled, op, threshold, tolerance_min, updated_by) VALUES (?,?,?,?,?,?,?)')
        .run(deviceId || null, metric, fields.enabled ?? null, fields.op ?? null, fields.threshold ?? null, fields.tolerance_min ?? null, who);
    }
  }

  // ---- monitored? ----
  const MONITORED_SQL = "archived_at IS NULL AND status='Deployed' AND management_mode='platform' AND COALESCE(platform,'routeros')<>'unknown' AND COALESCE(mgmt_address,'')<>'' AND COALESCE(admin_password,'')<>''";
  const isMonitored = (d) => !d.archived_at && d.status === 'Deployed' && d.management_mode === 'platform' && (d.platform || 'routeros') !== 'unknown' && !!d.mgmt_address && !!d.admin_password;

  // ---- observe ----
  const getState = db.prepare('SELECT * FROM metric_state WHERE device_id=? AND metric=?');
  const putState = db.prepare(`INSERT INTO metric_state (device_id, metric, value, observed_at, breach_since, firing, fired_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(device_id, metric) DO UPDATE SET value=excluded.value, observed_at=excluded.observed_at, breach_since=excluded.breach_since, firing=excluded.firing, fired_at=excluded.fired_at`);
  const putEvent = db.prepare('INSERT INTO alert_events (device_id, metric, kind, value, message, since, suppressed) VALUES (?,?,?,?,?,?,?)');

  function isMuted(d, now) { return !!(d.monitor_muted_until && ms(d.monitor_muted_until) > now); }

  /** One measurement. `d` is the device row; `value` a number (1/0 for yes/no checks). */
  function observe(d, metric, value, at = Date.now()) {
    if (!METRICS[metric]) return null;
    const { g, d: dr } = rulesFor(d.id);
    const rule = effectiveRule(metric, g, dr);
    const row = getState.get(d.id, metric);
    const prev = row ? { value: row.value, observed_at: ms(row.observed_at), breach_since: ms(row.breach_since), firing: row.firing, fired_at: ms(row.fired_at) } : null;
    const { state, event } = step(prev, rule, value, at);
    putState.run(d.id, metric, value, iso(state.observed_at), iso(state.breach_since), state.firing, iso(state.fired_at));
    // The device's online flag follows the reachability ALERT, not each sample, so a site page does
    // not turn red for a one-minute blip. A successful sample still marks a device online at once.
    if (metric === 'reachable') {
      if (event && event.kind === 'alert') db.prepare('UPDATE devices SET online=0 WHERE id=?').run(d.id);
      else if (Number(value) >= 1) db.prepare('UPDATE devices SET online=1 WHERE id=? AND online=0').run(d.id);
    }
    if (!event) return null;
    const name = d.name || ('Device ' + d.id);
    const msg = eventMessage(metric, event.kind, name, value, rule);
    const info = putEvent.run(d.id, metric, event.kind, value, msg, iso(event.since), isMuted(d, at) ? 1 : 0);
    return { id: Number(info.lastInsertRowid), kind: event.kind, message: msg };
  }

  // ---- notify ----
  function prefsFor(u) {
    const p = db.prepare('SELECT * FROM notify_prefs WHERE user_id=?').get(u.id) || {};
    const priv = PRIV_ROLES.has(u.role);
    return {
      web: p.web == null ? priv : !!p.web,
      email: p.email == null ? priv : !!p.email,
      sms: !!p.sms, phone: p.phone || '', recoveries: p.recoveries == null ? true : !!p.recoveries
    };
  }

  function siteLabel(deviceId) {
    const r = db.prepare(`SELECT d.name, s.name AS site, p.name AS pop FROM devices d
      LEFT JOIN sites s ON d.assigned_type='site' AND s.id=d.assigned_site_id
      LEFT JOIN pops p ON d.assigned_type='pop' AND p.id=d.assigned_pop_id WHERE d.id=?`).get(deviceId);
    return r ? (r.site || r.pop || '') : '';
  }

  let _flushing = false;
  /** Tell people about every event not yet told. Safe to call often; does nothing when idle. */
  async function flush() {
    if (_flushing) return { sent: 0 };
    _flushing = true;
    try {
      const pending = db.prepare('SELECT * FROM alert_events WHERE notified_at IS NULL ORDER BY id').all();
      if (!pending.length) return { sent: 0 };
      db.prepare(`UPDATE alert_events SET notified_at=datetime('now') WHERE id IN (${pending.map(() => '?').join(',')})`).run(...pending.map(e => e.id));
      const events = pending.filter(e => !e.suppressed);
      if (!events.length) return { sent: 0 };

      const users = db.prepare('SELECT id, name, email, role FROM users WHERE active=1').all();
      const insN = db.prepare('INSERT INTO notifications (user_id, event_id, level, title, body, href) VALUES (?,?,?,?,?,?)');
      const base = (ctx.getSetting && ctx.getSetting('public_base_url')) || '';
      let sent = 0;
      for (const u of users) {
        const p = prefsFor(u);
        const mine = events.filter(e => e.kind === 'alert' || p.recoveries);
        if (!mine.length) continue;
        const lines = mine.map(e => {
          const where = siteLabel(e.device_id);
          return { e, text: `${e.kind === 'alert' ? '⚠' : '✓'} ${e.message}${where ? ' — ' + where : ''}` };
        });
        if (p.web) for (const { e, text } of lines) {
          insN.run(u.id, e.id, e.kind === 'alert' ? (METRICS[e.metric] && METRICS[e.metric].critical ? 'critical' : 'problem') : 'recovery',
            text.slice(2), null, '#/device/' + e.device_id);
        }
        const alerts = mine.filter(e => e.kind === 'alert').length, recs = mine.length - alerts;
        const subject = alerts && recs ? `${alerts} alert${alerts > 1 ? 's' : ''}, ${recs} recovered`
          : alerts ? (alerts === 1 ? 'Alert: ' + mine[0].message : `${alerts} alerts`) : (recs === 1 ? 'Recovered: ' + mine[0].message : `${recs} recovered`);
        if (p.email && u.email) {
          const text = lines.map(l => l.text + (base ? `\n   ${base.replace(/\/$/, '')}/#/device/${l.e.device_id}` : '')).join('\n') +
            '\n\nChange how you are notified on the Alerts page.';
          try {
            if (ctx.sendMailBest) await ctx.sendMailBest({ to: u.email, subject: '[NOC] ' + subject, text, purpose: 'other' });
            else if (ctx.sendMail) await ctx.sendMail({ to: u.email, subject: '[NOC] ' + subject, text });
            sent++;
          } catch (e) { console.warn('alert email failed:', e.message); }
        }
        if (p.sms && p.phone && ctx.sendSms) {
          const body = [subject, ...lines.slice(0, 3).map(l => l.text)].join('\n') + (lines.length > 3 ? `\n+${lines.length - 3} more` : '');
          try { await ctx.sendSms(p.phone, body.slice(0, 600)); sent++; } catch (e) { console.warn('alert SMS failed:', e.message); }
        }
      }
      return { sent };
    } finally { _flushing = false; }
  }

  // ---- reading state ----
  function statesFor(deviceId) {
    return db.prepare('SELECT * FROM metric_state WHERE device_id=?').all(deviceId)
      .map(s => ({ ...s, observed_at: ms(s.observed_at), breach_since: ms(s.breach_since), fired_at: ms(s.fired_at) }));
  }
  function healthFor(d, now = Date.now()) {
    return healthOf({ archived: !!d.archived_at, monitored: isMonitored(d) }, statesFor(d.id), now);
  }
  /** Status for every device in one pass, for lists. */
  function allHealth(now = Date.now()) {
    const byDev = new Map();
    for (const s of db.prepare('SELECT * FROM metric_state').all()) {
      if (!byDev.has(s.device_id)) byDev.set(s.device_id, []);
      byDev.get(s.device_id).push({ ...s, observed_at: ms(s.observed_at) });
    }
    const out = {};
    for (const d of db.prepare('SELECT id, archived_at, status, management_mode, platform, mgmt_address, admin_password FROM devices').all())
      out[d.id] = healthOf({ archived: !!d.archived_at, monitored: isMonitored(d) }, byDev.get(d.id) || [], now);
    return out;
  }

  ctx.health = { observe, flush, healthFor, allHealth, isMonitored, METRICS };

  // ---- API ----
  const deviceRow = (id) => db.prepare('SELECT * FROM devices WHERE id=?').get(id);

  app.get('/api/health/status', (req, res) => res.json(allHealth()));

  app.get('/api/health/summary', (req, res) => {
    const all = allHealth();
    const counts = Object.fromEntries(Object.keys(HEALTH).map(k => [k, 0]));
    for (const s of Object.values(all)) counts[s]++;
    const firing = db.prepare(`SELECT m.device_id, m.metric, m.value, m.fired_at, m.breach_since, d.name, d.monitor_muted_until,
        s.name AS site, p.name AS pop, d.assigned_site_id, d.assigned_pop_id
      FROM metric_state m JOIN devices d ON d.id=m.device_id
      LEFT JOIN sites s ON d.assigned_type='site' AND s.id=d.assigned_site_id
      LEFT JOIN pops p ON d.assigned_type='pop' AND p.id=d.assigned_pop_id
      WHERE m.firing=1 AND d.archived_at IS NULL ORDER BY m.fired_at`).all()
      .map(r => ({ ...r, label: (METRICS[r.metric] || {}).label || r.metric, critical: !!(METRICS[r.metric] || {}).critical,
        muted: !!(r.monitor_muted_until && ms(r.monitor_muted_until) > Date.now()) }));
    res.json({ counts, firing, sampler: process.env.SAMPLER !== 'off' || process.env.DEMO_MODE === '1' });
  });

  app.get('/api/health/events', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const dev = Number(req.query.device) || null;
    const rows = db.prepare(`SELECT e.*, d.name AS device_name FROM alert_events e LEFT JOIN devices d ON d.id=e.device_id
      ${dev ? 'WHERE e.device_id=?' : ''} ORDER BY e.id DESC LIMIT ?`).all(...(dev ? [dev, limit] : [limit]));
    res.json(rows);
  });

  app.get('/api/health/rules', (req, res) => {
    const { g } = rulesFor(null);
    res.json(METRIC_KEYS.map(k => ({ ...effectiveRule(k, g, {}), label: METRICS[k].label, unit: METRICS[k].unit, bool: METRICS[k].bool, help: METRICS[k].help, critical: METRICS[k].critical, defaults: METRICS[k].rule })));
  });
  app.put('/api/health/rules/:metric', requireNoc, (req, res) => {
    const v = validateRule(req.params.metric, req.body || {}); if (v.error) return res.status(400).json({ error: v.error });
    saveRule(null, req.params.metric, v.rule, (req.user && req.user.email) || null);
    audit(req, 'edit', 'alert-rule:' + req.params.metric, JSON.stringify(v.rule));
    res.json({ ok: true });
  });

  app.get('/api/devices/:id/health', (req, res) => {
    const d = deviceRow(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const now = Date.now();
    const { g, d: dr } = rulesFor(d.id);
    const states = statesFor(d.id);
    const checks = METRIC_KEYS.map(k => {
      const s = states.find(x => x.metric === k) || null;
      const rule = effectiveRule(k, g, dr);
      return { metric: k, label: METRICS[k].label, unit: METRICS[k].unit, bool: METRICS[k].bool, help: METRICS[k].help, critical: METRICS[k].critical,
        rule, override: !!dr[k], value: s ? s.value : null, observed_at: iso(s && s.observed_at), firing: !!(s && s.firing),
        fired_at: iso(s && s.fired_at), breaching_since: iso(s && s.breach_since) };
    });
    res.json({
      status: healthFor(d, now), monitored: isMonitored(d), checks,
      muted_until: d.monitor_muted_until && ms(d.monitor_muted_until) > now ? d.monitor_muted_until : null, mute_reason: d.monitor_mute_reason || null,
      events: db.prepare('SELECT * FROM alert_events WHERE device_id=? ORDER BY id DESC LIMIT 30').all(d.id)
    });
  });
  app.put('/api/devices/:id/health/rules/:metric', requireNoc, (req, res) => {
    const d = deviceRow(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const v = validateRule(req.params.metric, req.body || {}); if (v.error) return res.status(400).json({ error: v.error });
    saveRule(d.id, req.params.metric, v.rule, (req.user && req.user.email) || null);
    audit(req, 'edit', 'device#' + d.id, `alert rule ${req.params.metric}: ${JSON.stringify(v.rule)}`);
    res.json({ ok: true });
  });
  app.delete('/api/devices/:id/health/rules/:metric', requireNoc, (req, res) => {
    db.prepare('DELETE FROM alert_rules WHERE device_id=? AND metric=?').run(Number(req.params.id), req.params.metric);
    audit(req, 'edit', 'device#' + req.params.id, `alert rule ${req.params.metric}: back to the default`);
    res.json({ ok: true });
  });
  app.post('/api/devices/:id/health/mute', requireNoc, (req, res) => {
    const d = deviceRow(req.params.id); if (!d) return res.status(404).json({ error: 'not found' });
    const hours = Number((req.body || {}).hours);
    if (!(hours > 0 && hours <= 24 * 30)) return res.status(400).json({ error: 'Mute for between a few minutes and 30 days' });
    const until = new Date(Date.now() + hours * 3600000).toISOString();
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200) || null;
    db.prepare('UPDATE devices SET monitor_muted_until=?, monitor_mute_reason=? WHERE id=?').run(until, reason, d.id);
    audit(req, 'edit', 'device#' + d.id, `alerts muted until ${until}${reason ? ' — ' + reason : ''}`);
    res.json({ ok: true, muted_until: until });
  });
  app.delete('/api/devices/:id/health/mute', requireNoc, (req, res) => {
    db.prepare('UPDATE devices SET monitor_muted_until=NULL, monitor_mute_reason=NULL WHERE id=?').run(Number(req.params.id));
    audit(req, 'edit', 'device#' + req.params.id, 'alerts unmuted');
    res.json({ ok: true });
  });

  // ---- my notifications ----
  const me = (req) => req.user && req.user.id;
  app.get('/api/notifications', (req, res) => {
    const unread = req.query.unread === '1';
    const rows = db.prepare(`SELECT * FROM notifications WHERE user_id=? ${unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`)
      .all(me(req), Math.min(Number(req.query.limit) || 50, 200));
    res.json({ unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(me(req)).n, items: rows });
  });
  app.get('/api/notifications/count', (req, res) => {
    res.json({ unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(me(req)).n });
  });
  app.post('/api/notifications/read', (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (ids && ids.length) db.prepare(`UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(me(req), ...ids);
    else db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL").run(me(req));
    res.json({ ok: true });
  });
  app.get('/api/notifications/prefs', (req, res) => {
    const u = db.prepare('SELECT id, role FROM users WHERE id=?').get(me(req));
    res.json({ ...prefsFor(u), sms_available: !!ctx.sendSms });
  });
  app.put('/api/notifications/prefs', (req, res) => {
    const b = req.body || {};
    const phone = b.phone !== undefined ? (ctx.normPhone ? ctx.normPhone(String(b.phone)) : String(b.phone).trim()) || null : undefined;
    if (b.sms && !phone && !(db.prepare('SELECT phone FROM notify_prefs WHERE user_id=?').get(me(req)) || {}).phone)
      return res.status(400).json({ error: 'Add a mobile number to get texts' });
    const cur = db.prepare('SELECT * FROM notify_prefs WHERE user_id=?').get(me(req));
    const val = (k, v) => (v === undefined ? (cur ? cur[k] : null) : (v ? 1 : 0));
    db.prepare(`INSERT INTO notify_prefs (user_id, web, email, sms, phone, recoveries) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET web=excluded.web, email=excluded.email, sms=excluded.sms, phone=excluded.phone, recoveries=excluded.recoveries, updated_at=datetime('now')`)
      .run(me(req), val('web', b.web), val('email', b.email), val('sms', b.sms), phone === undefined ? (cur ? cur.phone : null) : phone,
        b.recoveries === undefined ? (cur ? cur.recoveries : 1) : (b.recoveries ? 1 : 0));
    res.json({ ok: true });
  });

  // Old notifications go after 90 days; the alert events themselves are kept.
  const sweep = setInterval(() => { try { db.prepare("DELETE FROM notifications WHERE created_at < datetime('now','-90 days')").run(); } catch {} }, 6 * 3600000);
  if (sweep.unref) sweep.unref();
}
