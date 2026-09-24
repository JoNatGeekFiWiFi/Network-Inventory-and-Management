// Suspension for nonpayment: the automatic job, the router enforcement, the captive redirect,
// the "your service is paused" page, payment arrangements, and the report staff override from.
//
// Policy lives in lib/suspension.js (pure); router changes in lib/suspendrouter.js. This file is
// the glue: it reads invoices, decides, records, tells the customer, and drives the routers.
import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as dnsp } from 'node:dns';
import { standing, decide, validateArrangement, splitInstallments, installmentProgress, isOpen, isoDay, DEFAULTS } from '../lib/suspension.js';
import {
  gardenHosts, captiveIpFor, routerosPlan, routerosSuspend, routerosClear, routerosIsSuspended,
  findOverlayZone, openwrtPlan, openwrtOurs
} from '../lib/suspendrouter.js';
import { driverFor, platformOf } from '../lib/drivers/index.js';
import { sshExec } from '../lib/sshexec.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);

export default function registerSuspension(app, ctx) {
  const { db, requireNoc, audit, getSetting, setSetting, restReq, rosHeaders } = ctx;
  const CAPTIVE_PORT = Number(process.env.CAPTIVE_PORT || 3080);
  const today = () => isoDay(Date.now());

  // ---- settings ----
  function policy() {
    const n = (k, d) => { const raw = getSetting(k); if (raw === null || raw === undefined || raw === '') return d; const v = Number(raw); return Number.isFinite(v) && v >= 0 ? v : d; };
    return {
      graceDays: n('suspend_grace_days', DEFAULTS.graceDays),
      warnDays: n('suspend_warn_days', DEFAULTS.warnDays),
      arrangementGraceDays: n('suspend_arrangement_grace_days', DEFAULTS.arrangementGraceDays)
    };
  }
  // Off until someone switches it on. The first pass would otherwise suspend every customer who is
  // already 10+ days late the moment this ships — including anyone whose "late" invoice is really a
  // stale import. Someone should look at the Late list once, then turn it on.
  const autoOn = () => getSetting('suspend_auto') === '1';
  const pubBase = () => String(getSetting('public_base_url') || '').replace(/\/$/, '');

  // ---- reading a customer's position ----
  const openInvoices = (cid) => db.prepare("SELECT id, number, status, balance, due_date, total, pay_token FROM bill_invoices WHERE customer_id=? AND status IN ('sent','partial') AND balance>0 ORDER BY due_date").all(cid);

  function activeArrangement(cid) {
    const a = db.prepare("SELECT * FROM payment_arrangements WHERE customer_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(cid);
    if (!a) return null;
    const ids = JSON.parse(a.invoice_ids || '[]');
    // Paid toward the covered invoices since the arrangement began — money, not ticks.
    const paid = ids.length ? db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM bill_payments WHERE invoice_id IN (${ids.map(() => '?').join(',')}) AND created_at >= ?`).get(...ids, a.created_at).s : 0;
    return { ...a, invoice_ids: ids, installments: JSON.parse(a.installments_json || '[]'), paid_since: paid };
  }

  function standingFor(c, day = today()) {
    return standing({ invoices: openInvoices(c.id), arrangement: activeArrangement(c.id), exempt: !!c.suspend_exempt,
      holdUntil: c.suspend_hold_until || null, today: day, policy: policy() });
  }

  function ensureToken(c) {
    if (c.suspend_token) return c.suspend_token;
    const t = randomBytes(18).toString('hex');
    db.prepare('UPDATE customers SET suspend_token=? WHERE id=?').run(t, c.id);
    return t;
  }
  const landingUrl = (c) => `${pubBase()}/suspended/${ensureToken(c)}`;

  // ---- which routers ----
  /**
   * The routers that carry this customer's service: platform-managed, deployed, RouterOS or
   * OpenWrt, at one of their sites, and actually a router (a WAN port tagged, or a router model).
   * A router shared with ANOTHER customer (an apartment block with units) is never touched — that
   * would cut off the neighbours. It is reported, so someone can suspend that unit's port by hand.
   */
  function routersFor(cid) {
    const rows = db.prepare(`SELECT d.*, s.id AS site_id, s.name AS site_name, m.device_type
      FROM devices d JOIN sites s ON d.assigned_type='site' AND s.id=d.assigned_site_id
      LEFT JOIN device_models m ON m.id=d.model_id
      WHERE s.customer_id=? AND d.archived_at IS NULL AND d.status='Deployed' AND d.management_mode='platform'`).all(cid);
    return rows.filter(d => {
      let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
      const hasWan = Object.values(roles).some(r => r === 'WAN1' || r === 'WAN2');
      return hasWan || /router/i.test(d.device_type || '');
    }).map(d => {
      const others = db.prepare('SELECT COUNT(*) n FROM site_units WHERE site_id=? AND customer_id IS NOT NULL AND customer_id<>?').get(d.site_id, cid).n;
      return { ...d, shared: others > 0, platformKey: platformOf(d) };
    });
  }

  // ---- router enforcement ----
  const recordDevice = db.prepare(`INSERT INTO suspension_devices (device_id, customer_id, want, state, detail, attempts, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET customer_id=excluded.customer_id, want=excluded.want, state=excluded.state, detail=excluded.detail,
      attempts=CASE WHEN excluded.state='applied' THEN 0 ELSE suspension_devices.attempts + 1 END, updated_at=datetime('now')`);

  function captiveTarget(d) {
    const ip = captiveIpFor(d.mgmt_address, os.networkInterfaces(), getSetting('captive_redirect_ip') || null);
    if (!ip) throw new Error(`This server has no address on ${d.mgmt_address}'s management network, so the router cannot send customers to the payment page. Set "Captive redirect IP" in suspension settings.`);
    return ip;
  }
  const garden = () => gardenHosts(pubBase(), getSetting('suspend_garden'));

  async function resolveAll(hosts) {
    const ips = new Set();
    for (const h of hosts) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { ips.add(h); continue; }
      try { for (const ip of await dnsp.resolve4(h)) ips.add(ip); } catch {}
    }
    return [...ips];
  }

  async function enforceRouterOS(d, suspend) {
    const call = async (method, path, body) => {
      const r = await restReq(d.mgmt_address, path, { headers: rosHeaders(d), method, body, timeoutMs: 15000 });
      return { status: r.status, body: r.body };
    };
    if (!suspend) { const n = await routerosClear(call); return n ? `removed ${n} rule(s)` : 'nothing to remove'; }
    const captiveIp = captiveTarget(d);
    await routerosSuspend(call, routerosPlan({ captiveIp, captivePort: CAPTIVE_PORT, garden: garden() }), { protect: [captiveIp, d.mgmt_address] });
    if (!(await routerosIsSuspended(call))) throw new Error('The rules were sent but are not on the router');
    return 'suspension rules on';
  }

  async function enforceOpenWrt(d, suspend) {
    const driver = await driverFor(d, { sshExec });
    if (!driver.uciGetAll) throw new Error('This device\'s driver cannot change the firewall');
    const fw = await driver.uciGetAll('firewall');
    if (!fw.ok) throw new Error('Could not read the firewall: ' + fw.error);
    const ours = openwrtOurs(fw.values);
    for (const name of ours) { const r = await driver.uciDelete('firewall', name); if (!r.ok) { await driver.uciRevert('firewall'); throw new Error(r.error); } }
    if (suspend) {
      const captiveIp = captiveTarget(d);
      const ifs = await driver.interfaces();
      const zone = findOverlayZone({ interfaces: ifs, firewall: fw.values, mgmtAddress: d.mgmt_address });
      if (!zone) { await driver.uciRevert('firewall'); throw new Error('Could not find the firewall zone for the management network on this router'); }
      const plan = openwrtPlan({ captiveIp, captivePort: CAPTIVE_PORT, gardenIps: await resolveAll(garden()), overlayZone: zone });
      for (const s of plan) {
        const r = await driver.uciAdd('firewall', s.type, s.name, s.values);
        if (!r.ok) { await driver.uciRevert('firewall'); throw new Error(`Could not stage ${s.name}: ${r.error}`); }
      }
    } else if (!ours.length) return 'nothing to remove';
    // Confirmed apply: if the change cut us off, the router undoes it by itself.
    const applied = await driver.applyConfirmed({ timeoutSeconds: 60 });
    if (!applied.ok) throw new Error(applied.error);
    return suspend ? 'suspension rules on' : `removed ${ours.length} section(s)`;
  }

  async function enforceDevice(d, cid, suspend) {
    const want = suspend ? 'suspended' : 'normal';
    if (d.shared) { recordDevice.run(d.id, cid, want, 'skipped', 'Shared with other customers at this site — suspend their unit or port by hand'); return; }
    if (!d.mgmt_address || !d.admin_password) { recordDevice.run(d.id, cid, want, 'skipped', 'No management address or admin password'); return; }
    try {
      let detail;
      if (d.platformKey === 'routeros') detail = await enforceRouterOS(d, suspend);
      else if (d.platformKey === 'openwrt') detail = await enforceOpenWrt(d, suspend);
      else { recordDevice.run(d.id, cid, want, 'skipped', `Suspension is not supported on ${d.platformKey}`); return; }
      recordDevice.run(d.id, cid, want, 'applied', detail);
      audit({ user: { email: 'system', role: 'system' } }, 'suspend-router', 'device#' + d.id, `${want}: ${detail}`);
    } catch (e) {
      recordDevice.run(d.id, cid, want, 'pending', String(e.message || e).slice(0, 400));
    }
  }

  /** Bring every router of this customer in line with their current state. */
  async function enforceCustomer(cid) {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid); if (!c) return;
    const suspend = !!c.suspended_at;
    const routers = routersFor(cid);
    for (const d of routers) await enforceDevice(d, cid, suspend);
    // A router that was suspended for this customer but has since moved away gets cleared too.
    for (const row of db.prepare("SELECT device_id FROM suspension_devices WHERE customer_id=? AND want='suspended'").all(cid)) {
      if (routers.some(r => r.id === row.device_id)) continue;
      const d = db.prepare('SELECT * FROM devices WHERE id=?').get(row.device_id);
      if (d) await enforceDevice({ ...d, shared: false, platformKey: platformOf(d) }, cid, false);
    }
  }

  // ---- telling the customer ----
  async function notifyCustomer(c, kind, st) {
    const company = getSetting('bill_company') || getSetting('company_name') || 'Your internet provider';
    const url = landingUrl(c);
    const lines = {
      warning: `${company}: your account is past due (${money(st.balance)}). To avoid a service interruption on ${st.suspendOn}, please pay here: ${url}`,
      suspended: `${company}: your internet service has been paused for nonpayment (${money(st.balance)} past due). Pay here and service comes back within minutes: ${url}`,
      restored: `${company}: thank you — your internet service is back on.`
    };
    const text = lines[kind];
    const sent = [];
    if (c.billing_email) {
      try {
        const subject = { warning: 'Payment reminder — service interruption on ' + st.suspendOn, suspended: 'Your internet service is paused', restored: 'Your internet service is back on' }[kind];
        const r = ctx.sendMailBest ? await ctx.sendMailBest({ to: c.billing_email, subject, text, purpose: 'billing' }) : await ctx.sendMail({ to: c.billing_email, subject, text });
        if (r && r.ok !== false) sent.push('email');
      } catch (e) { console.warn('suspension email:', e.message); }
    }
    if (c.sms_number && ctx.sendSms && (c.preferred_channel === 'sms' || !c.billing_email)) {
      try { const r = await ctx.sendSms(c.sms_number, text); if (r && r.ok !== false) sent.push('text'); } catch (e) { console.warn('suspension SMS:', e.message); }
    }
    return sent;
  }

  // ---- actions ----
  const log = db.prepare('INSERT INTO suspension_log (customer_id, action, reason, balance, days_late, actor) VALUES (?,?,?,?,?,?)');

  async function suspend(cid, { by, reason, notify = true }) {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid); if (!c) throw Object.assign(new Error('not found'), { http: 404 });
    if (c.suspended_at) return { already: true };
    const st = standingFor(c);
    db.prepare("UPDATE customers SET suspended_at=datetime('now'), suspended_by=?, suspended_reason=?, status='Suspended' WHERE id=?").run(by, reason || null, cid);
    log.run(cid, 'suspend', reason || null, st.balance, st.daysLate, by);
    ensureToken(c);
    if (notify) await notifyCustomer(c, 'suspended', st);
    await enforceCustomer(cid);
    return { ok: true };
  }

  async function restore(cid, { by, reason, notify = true }) {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid); if (!c) throw Object.assign(new Error('not found'), { http: 404 });
    if (!c.suspended_at) return { already: true };
    const st = standingFor(c);
    db.prepare("UPDATE customers SET suspended_at=NULL, suspended_by=NULL, suspended_reason=NULL, status=CASE WHEN status='Suspended' THEN 'Active' ELSE status END WHERE id=?").run(cid);
    log.run(cid, 'restore', reason || null, st.balance, st.daysLate, by);
    if (notify) await notifyCustomer(c, 'restored', st);
    await enforceCustomer(cid);
    return { ok: true };
  }

  /** Decide and act for one customer. Returns what happened. */
  async function check(cid) {
    const c = db.prepare('SELECT * FROM customers WHERE id=? AND archived_at IS NULL').get(cid); if (!c) return null;
    const st = standingFor(c);
    // Keep arrangement records honest as money arrives or dates pass.
    const arr = db.prepare("SELECT id FROM payment_arrangements WHERE customer_id=? AND status='active'").get(cid);
    if (arr && st.arrangementDone) db.prepare("UPDATE payment_arrangements SET status='completed', closed_at=datetime('now'), closed_reason='paid in full' WHERE id=?").run(arr.id);
    else if (arr && st.arrangementBroken) db.prepare("UPDATE payment_arrangements SET status='broken', closed_at=datetime('now'), closed_reason=? WHERE id=?").run('missed ' + st.suspendOn, arr.id);

    const action = decide(st, { suspended: !!c.suspended_at, suspendedBy: c.suspended_by, warnedFor: c.suspend_warned_for }, { auto: autoOn() });
    if (action === 'suspend') await suspend(cid, { by: 'auto', reason: `${st.daysLate} days past due (${money(st.balance)})` });
    else if (action === 'restore') await restore(cid, { by: 'auto', reason: st.balance > 0 ? (st.protectedBy ? 'payment arrangement' : st.held ? 'held by staff' : 'back in good standing') : 'paid in full' });
    else if (action === 'warn') {
      const sent = await notifyCustomer(c, 'warning', st);
      db.prepare('UPDATE customers SET suspend_warned_for=? WHERE id=?').run(st.suspendOn, cid);
      log.run(cid, 'warn', `suspension on ${st.suspendOn}${sent.length ? ' — sent by ' + sent.join(' and ') : ' — no email or mobile on file'}`, st.balance, st.daysLate, 'auto');
    }
    return { action, standing: st };
  }

  let _running = false;
  /** The hourly pass: every customer who owes or is suspended, then retry any router that failed. */
  async function runAll() {
    if (_running) return; _running = true;
    try {
      const ids = db.prepare(`SELECT DISTINCT c.id FROM customers c WHERE c.archived_at IS NULL AND (c.suspended_at IS NOT NULL OR EXISTS
        (SELECT 1 FROM bill_invoices i WHERE i.customer_id=c.id AND i.status IN ('sent','partial') AND i.balance>0))`).all().map(r => r.id);
      for (const id of ids) { try { await check(id); } catch (e) { console.warn('suspension check', id, e.message); } }
      const retry = db.prepare("SELECT DISTINCT customer_id FROM suspension_devices WHERE state='pending' AND attempts < 72").all();
      for (const r of retry) { try { await enforceCustomer(r.customer_id); } catch {} }
    } finally { _running = false; }
  }

  ctx.suspension = {
    check, runAll, suspend, restore, enforceCustomer, standingFor, routersFor,
    onPayment: async (cid) => { if (cid) await check(cid); }
  };
  ctx.jobs.runSuspensions = runAll;
  if (process.env.SUSPEND !== 'off' && process.env.DEMO_MODE !== '1') {
    const t = setInterval(() => runAll().catch(e => console.warn('suspension pass:', e.message)), 60 * 60000);
    if (t.unref) t.unref();
    setTimeout(() => runAll().catch(() => {}), 90000).unref?.();
  }

  // ---- captive redirect listener ----
  /**
   * A tiny separate HTTP server on its own port. Suspended routers send their customers' plain web
   * traffic here over the management overlay, masqueraded as the router itself, so the source
   * address IS the router's management address — which identifies the customer exactly. It answers
   * every path with a redirect, which is what makes phones show their "sign in to network" sheet.
   * Kept apart from the main app so a stray request here can never reach an API route.
   */
  function captiveHandler(req, res) {
    const src = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    let target = pubBase() ? `${pubBase()}/suspended` : null;
    try {
      const row = db.prepare(`SELECT c.* FROM devices d JOIN sites s ON d.assigned_type='site' AND s.id=d.assigned_site_id
        JOIN customers c ON c.id=s.customer_id WHERE d.mgmt_address=? AND d.archived_at IS NULL LIMIT 1`).get(src);
      if (row && pubBase()) target = landingUrl(row);
    } catch {}
    if (!target) { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('Service paused. Please contact your provider.'); }
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
    res.end(`<a href="${esc(target)}">Continue</a>`);
  }
  ctx.suspension.captiveHandler = captiveHandler;
  if (process.env.DEMO_MODE !== '1' && process.env.CAPTIVE_PORT !== 'off') {
    const srv = http.createServer(captiveHandler);
    srv.on('error', (e) => console.warn(`Captive redirect listener not started on port ${CAPTIVE_PORT}: ${e.code || e.message}`));
    srv.listen(CAPTIVE_PORT, process.env.CAPTIVE_HOST || '0.0.0.0', () => console.log(`Captive redirect listening on port ${CAPTIVE_PORT}`));
    if (srv.unref) srv.unref();
  }

  // ---- the customer's page ----
  function pageShell(title, body) {
    const company = esc(getSetting('bill_company') || getSetting('company_name') || '');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f6f8;color:#1f2328}
main{max-width:560px;margin:0 auto;padding:28px 18px}.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:20px;margin:14px 0}
h1{font-size:22px;margin:0 0 4px}.sub{color:#5f6b76;margin:0}.inv{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid #eef0f2}
.btn{display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600}.muted{color:#5f6b76;font-size:14px}
.tot{font-size:28px;font-weight:700}</style></head><body><main>${company ? `<div class="muted">${company}</div>` : ''}${body}</main></body></html>`;
  }

  app.get('/suspended', (req, res) => {
    const phone = getSetting('company_phone') || '', mail = getSetting('mail_from') || '';
    res.type('html').send(pageShell('Service paused', `<div class="card"><h1>Your internet service is paused</h1>
      <p class="sub">This connection has been paused. Please contact us to restore it${phone ? ` — ${esc(phone)}` : ''}${mail ? ` · ${esc(mail)}` : ''}.</p></div>`));
  });

  app.get('/suspended/:token', (req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE suspend_token=?').get(String(req.params.token || ''));
    if (!c) return res.status(404).type('html').send(pageShell('Not found', '<div class="card"><h1>Link not found</h1><p class="sub">Please contact us.</p></div>'));
    res.setHeader('Cache-Control', 'no-store');
    const st = standingFor(c);
    const invs = openInvoices(c.id).map(i => {
      if (!i.pay_token) { const t = randomBytes(18).toString('hex'); db.prepare('UPDATE bill_invoices SET pay_token=? WHERE id=?').run(t, i.id); i.pay_token = t; }
      return i;
    });
    const arr = activeArrangement(c.id);
    let arrText = '';
    if (arr && arr.kind === 'extension') arrText = `<p class="muted">Payment arrangement: you have until <b>${esc(arr.extend_until)}</b>.</p>`;
    if (arr && arr.kind === 'installments') {
      const next = installmentProgress(arr.installments, arr.paid_since).find(i => !i.paid);
      if (next) arrText = `<p class="muted">Payment plan: next payment of <b>${money(next.amount - next.covered)}</b> due <b>${esc(next.due_date)}</b>.</p>`;
    }
    const phone = getSetting('company_phone') || '';
    const body = `<div class="card"><h1>${c.suspended_at ? 'Your internet service is paused' : invs.length ? 'Your account has a balance' : 'Your account is up to date'}</h1>
      <p class="sub">${esc(c.name)}</p>
      ${invs.length ? `<p class="tot">${money(st.balance)}</p><p class="muted">${c.suspended_at ? 'Pay below and your service comes back on within a few minutes — no need to call.' : st.suspendOn ? `Please pay by ${esc(st.suspendOn)} to avoid an interruption.` : ''}</p>${arrText}` : '<p class="muted">Nothing is owed. If you are still offline, restart your router or contact us.</p>'}</div>
      ${invs.length ? `<div class="card">${invs.map(i => `<div class="inv"><div><b>Invoice ${esc(i.number)}</b><div class="muted">due ${esc(i.due_date || '')}</div></div><div>${money(i.balance)} <a class="btn" href="/pay/${esc(i.pay_token)}">Pay</a></div></div>`).join('')}</div>` : ''}
      <p class="muted">Questions? ${phone ? `Call ${esc(phone)}.` : 'Reply to any of our emails.'}</p>`;
    res.type('html').send(pageShell('Your account', body));
  });

  // ---- staff API ----
  const who = (req) => (req.user && req.user.email) || 'staff';
  const customer = (id) => db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.http || 500).json({ error: e.message }); } };

  function summarize(c) {
    const st = standingFor(c);
    return { id: c.id, name: c.name, status: c.status, suspended_at: c.suspended_at, suspended_by: c.suspended_by, suspended_reason: c.suspended_reason,
      exempt: !!c.suspend_exempt, exempt_reason: c.suspend_exempt_reason, hold_until: c.suspend_hold_until, standing: st };
  }

  app.get('/api/suspension/report', requireNoc, (req, res) => {
    const custs = db.prepare(`SELECT c.* FROM customers c WHERE c.archived_at IS NULL AND (c.suspended_at IS NOT NULL OR c.suspend_exempt=1 OR c.suspend_hold_until IS NOT NULL OR EXISTS
      (SELECT 1 FROM bill_invoices i WHERE i.customer_id=c.id AND i.status IN ('sent','partial') AND i.balance>0 AND i.due_date < ?))`).all(today());
    const rows = custs.map(summarize);
    const devs = db.prepare(`SELECT sd.*, d.name AS device_name FROM suspension_devices sd LEFT JOIN devices d ON d.id=sd.device_id`).all();
    const devFor = (cid) => devs.filter(x => x.customer_id === cid);
    res.json({
      policy: policy(), auto: autoOn(),
      suspended: rows.filter(r => r.suspended_at).map(r => ({ ...r, routers: devFor(r.id) })),
      due: rows.filter(r => !r.suspended_at && (r.standing.due || r.standing.warn || r.standing.late)).sort((a, b) => String(a.standing.suspendOn).localeCompare(String(b.standing.suspendOn))),
      overrides: rows.filter(r => r.exempt || (r.hold_until && r.hold_until >= today())),
      arrangements: db.prepare(`SELECT a.*, c.name AS customer_name FROM payment_arrangements a JOIN customers c ON c.id=a.customer_id
        WHERE a.status='active' OR a.closed_at >= datetime('now','-30 days') ORDER BY a.status='active' DESC, a.id DESC`).all()
        .map(a => ({ ...a, installments: JSON.parse(a.installments_json || '[]'), invoice_ids: JSON.parse(a.invoice_ids || '[]') })),
      history: db.prepare(`SELECT l.*, c.name AS customer_name FROM suspension_log l LEFT JOIN customers c ON c.id=l.customer_id ORDER BY l.id DESC LIMIT 200`).all()
    });
  });

  app.get('/api/customers/:id/suspension', requireNoc, (req, res) => {
    const c = customer(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
    const arr = activeArrangement(c.id);
    res.json({ ...summarize(c), auto: autoOn(), policy: policy(),
      landing_url: pubBase() ? landingUrl(c) : null,
      arrangement: arr ? { ...arr, progress: arr.kind === 'installments' ? installmentProgress(arr.installments, arr.paid_since) : null } : null,
      routers: routersFor(c.id).map(d => ({ id: d.id, name: d.name, site: d.site_name, platform: d.platformKey, shared: d.shared,
        enforcement: db.prepare('SELECT want, state, detail, attempts, updated_at FROM suspension_devices WHERE device_id=?').get(d.id) || null })),
      open_invoices: openInvoices(c.id).map(i => ({ id: i.id, number: i.number, balance: i.balance, due_date: i.due_date })),
      log: db.prepare('SELECT * FROM suspension_log WHERE customer_id=? ORDER BY id DESC LIMIT 30').all(c.id) });
  });

  app.post('/api/customers/:id/service/suspend', requireNoc, wrap(async (req, res) => {
    const c = customer(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 300) || 'suspended by staff';
    const r = await suspend(c.id, { by: who(req), reason, notify: (req.body || {}).notify !== false });
    audit(req, 'suspend', 'customer#' + c.id, reason);
    res.json(r);
  }));

  // /service/…, not /restore: that path already means "un-archive this customer".
  app.post('/api/customers/:id/service/restore', requireNoc, wrap(async (req, res) => {
    const c = customer(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const reason = String(b.reason || '').trim().slice(0, 300) || 'restored by staff';
    // Restoring someone who still owes needs a hold, or the next hourly pass suspends them again.
    if (b.hold_until) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.hold_until) || b.hold_until < today()) return res.status(400).json({ error: 'The hold date must be today or later' });
      db.prepare('UPDATE customers SET suspend_hold_until=? WHERE id=?').run(b.hold_until, c.id);
    }
    const r = await restore(c.id, { by: who(req), reason: reason + (b.hold_until ? ` (held until ${b.hold_until})` : ''), notify: b.notify !== false });
    audit(req, 'restore', 'customer#' + c.id, reason);
    res.json(r);
  }));

  app.put('/api/customers/:id/suspension', requireNoc, wrap(async (req, res) => {
    const c = customer(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (b.exempt !== undefined) db.prepare('UPDATE customers SET suspend_exempt=?, suspend_exempt_reason=? WHERE id=?').run(b.exempt ? 1 : 0, b.exempt ? (String(b.exempt_reason || '').slice(0, 200) || null) : null, c.id);
    if (b.hold_until !== undefined) {
      if (b.hold_until && (!/^\d{4}-\d{2}-\d{2}$/.test(b.hold_until) || b.hold_until < today())) return res.status(400).json({ error: 'The hold date must be today or later' });
      db.prepare('UPDATE customers SET suspend_hold_until=? WHERE id=?').run(b.hold_until || null, c.id);
    }
    audit(req, 'edit', 'customer#' + c.id, `suspension override: ${JSON.stringify(b)}`);
    const r = await check(c.id);
    res.json({ ok: true, action: r && r.action });
  }));

  app.post('/api/customers/:id/suspension/retry', requireNoc, wrap(async (req, res) => {
    const c = customer(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
    await enforceCustomer(c.id);
    res.json({ ok: true });
  }));

  app.post('/api/customers/:id/arrangements', requireNoc, wrap(async (req, res) => {
    const c = customer(req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const open = openInvoices(c.id);
    if (!open.length) return res.status(400).json({ error: 'Nothing is owed, so there is nothing to arrange' });
    const balance = Math.round(open.reduce((n, i) => n + Number(i.balance), 0) * 100) / 100;
    let body = b;
    // Convenience: "split into N payments starting on D".
    if (b.kind === 'installments' && !Array.isArray(b.installments) && b.count) body = { ...b, installments: splitInstallments(balance, b.count, b.first_due || today(), Number(b.every_days) || 30) };
    const v = validateArrangement(body, { today: today(), balance });
    if (v.error) return res.status(400).json({ error: v.error });
    db.prepare("UPDATE payment_arrangements SET status='cancelled', closed_at=datetime('now'), closed_reason='replaced' WHERE customer_id=? AND status='active'").run(c.id);
    const info = db.prepare('INSERT INTO payment_arrangements (customer_id, kind, extend_until, invoice_ids, installments_json, balance_at_start, notes, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.id, v.arrangement.kind, v.arrangement.extend_until, JSON.stringify(open.map(i => i.id)), JSON.stringify(v.arrangement.installments), balance, String(b.notes || '').slice(0, 500) || null, who(req));
    log.run(c.id, 'arrangement', v.arrangement.kind === 'extension' ? `extension until ${v.arrangement.extend_until}` : `${v.arrangement.installments.length} installments`, balance, null, who(req));
    audit(req, 'create', 'arrangement#' + info.lastInsertRowid, `customer#${c.id} ${v.arrangement.kind}`);
    const r = await check(c.id);      // may restore them straight away
    res.json({ id: Number(info.lastInsertRowid), action: r && r.action });
  }));

  app.post('/api/arrangements/:id/cancel', requireNoc, wrap(async (req, res) => {
    const a = db.prepare('SELECT * FROM payment_arrangements WHERE id=?').get(req.params.id); if (!a) return res.status(404).json({ error: 'not found' });
    db.prepare("UPDATE payment_arrangements SET status='cancelled', closed_at=datetime('now'), closed_reason=? WHERE id=?").run(String((req.body || {}).reason || 'cancelled by staff').slice(0, 200), a.id);
    log.run(a.customer_id, 'arrangement', 'cancelled', null, null, who(req));
    audit(req, 'edit', 'arrangement#' + a.id, 'cancelled');
    await check(a.customer_id);
    res.json({ ok: true });
  }));

  // Run the pass now instead of waiting for the hour — after changing the policy, say.
  app.post('/api/suspension/run', requireNoc, wrap(async (req, res) => {
    await runAll();
    audit(req, 'run', 'suspension', 'manual pass');
    res.json({ ok: true });
  }));

  app.get('/api/suspension/settings', requireNoc, (req, res) => {
    res.json({ auto: autoOn(), ...policy(), garden: garden(), garden_setting: getSetting('suspend_garden') || '',
      captive_port: CAPTIVE_PORT, captive_redirect_ip: getSetting('captive_redirect_ip') || '', public_base_url: pubBase() });
  });
  app.put('/api/suspension/settings', requireNoc, (req, res) => {
    const b = req.body || {};
    const num = (k, v, max) => { if (v === undefined) return null; const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) return `${k} must be a whole number of days, 0–${max}`; setSetting(k, String(n)); return null; };
    const err = num('suspend_grace_days', b.graceDays, 120) || num('suspend_warn_days', b.warnDays, 30) || num('suspend_arrangement_grace_days', b.arrangementGraceDays, 30);
    if (err) return res.status(400).json({ error: err });
    if (b.auto !== undefined) setSetting('suspend_auto', b.auto ? '1' : '0');
    if (b.garden !== undefined) setSetting('suspend_garden', String(b.garden).slice(0, 2000));
    if (b.captive_redirect_ip !== undefined) {
      const ip = String(b.captive_redirect_ip).trim();
      if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: 'Captive redirect IP must be an IPv4 address' });
      setSetting('captive_redirect_ip', ip);
    }
    audit(req, 'edit', 'settings', 'suspension policy: ' + JSON.stringify(b));
    res.json({ ok: true });
  });
}
