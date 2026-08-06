// Support domain: the customer portal, trouble tickets, and the omnichannel messaging layer
// (outbound email/SMS/WhatsApp via Twilio or Telnyx, plus inbound webhooks and the IMAP poller).
// Registered from server.js; shared services arrive via ctx.
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { r2, todayStr, esc2, normPhone } from "../lib/core.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export default function registerSupport(app, ctx) {
  const { db, N, audit, requireNoc, getSetting, setSetting, sendMail, mailSafe,
          verifyPassword, parseCookies } = ctx;

  // ---------- Omnichannel messaging (email / SMS / WhatsApp via Twilio or Telnyx) ----------
  // email Reply-To woven with a per-ticket token: support+<token>@domain  (so inbound replies thread back)
  function emailReplyTo(token) {
    const from = (getSetting('mail_from') || '').trim(); const m = from.match(/<([^>]+)>/); const addr = m ? m[1] : from;
    const at = addr.indexOf('@'); if (at < 0 || !token) return addr || '';
    return addr.slice(0, at) + '+' + token + addr.slice(at);
  }
  // --- provider REST calls (no SDK; plain fetch) ---
  async function twilioSendMessage({ to, from, body, whatsapp }) {
    const sid = getSetting('twilio_sid'), tok = getSetting('twilio_token');
    if (!sid || !tok) return { ok: false, error: 'Twilio not configured' };
    const f = whatsapp ? ('whatsapp:' + from) : from, t = whatsapp ? ('whatsapp:' + to) : to;
    const params = new URLSearchParams({ To: t, From: f, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: params
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, id: j.sid } : { ok: false, error: j.message || ('Twilio HTTP ' + r.status) };
  }
  async function telnyxSendMessage({ to, from, body, whatsapp }) {
    const key = getSetting('telnyx_key'); if (!key) return { ok: false, error: 'Telnyx not configured' };
    const payload = { to, from, text: body };
    if (whatsapp) payload.type = 'whatsapp';
    const prof = getSetting('telnyx_profile'); if (prof) payload.messaging_profile_id = prof;
    const r = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, id: j.data && j.data.id } : { ok: false, error: (j.errors && j.errors[0] && j.errors[0].detail) || ('Telnyx HTTP ' + r.status) };
  }
  async function sendSms(to, body) {
    const prov = getSetting('sms_provider') || 'twilio';
    const from = prov === 'telnyx' ? getSetting('telnyx_sms_from') : getSetting('twilio_sms_from');
    if (!from) return { ok: false, error: 'No SMS sender number configured' };
    return prov === 'telnyx' ? telnyxSendMessage({ to, from, body }) : twilioSendMessage({ to, from, body });
  }
  async function sendWhatsApp(to, body) {
    const prov = getSetting('whatsapp_provider') || 'twilio';
    const from = prov === 'telnyx' ? getSetting('telnyx_wa_from') : getSetting('twilio_wa_from');
    if (!from) return { ok: false, error: 'No WhatsApp sender configured' };
    return prov === 'telnyx' ? telnyxSendMessage({ to, from, body, whatsapp: true }) : twilioSendMessage({ to, from, body, whatsapp: true });
  }
  // Dispatch one outbound message on a given channel. Returns {ok, external_id, to, error}.
  async function deliverOnChannel(t, channel, body) {
    const cust = db.prepare('SELECT billing_email, sms_number, whatsapp_number FROM customers WHERE id=?').get(t.customer_id) || {};
    if (channel === 'email') {
      const to = t.contact_email || cust.billing_email; if (!to) return { ok: false, error: 'No email on file', to: null };
      const pub = pubBase(); const rt = emailReplyTo(t.reply_token);
      const mid = await sendMail({ to, subject: `[${t.number}] ${t.subject}`, text: `${body}\n\nView your ticket: ${pub}/portal`, html: `<p>${nl2br(body)}</p><p style="color:#888;font-size:12px">Reply to this email to continue the conversation, or view it in the <a href="${pub}/portal">customer portal</a>.</p>`, replyTo: rt || undefined }).catch(e => ({ err: e.message }));
      return mid && !mid.err ? { ok: true, external_id: typeof mid === 'string' ? mid : null, to } : { ok: false, error: (mid && mid.err) || 'send failed', to };
    }
    if (channel === 'sms' || channel === 'whatsapp') {
      const to = normPhone(t.contact_phone || (channel === 'sms' ? cust.sms_number : cust.whatsapp_number) || cust.sms_number || cust.whatsapp_number);
      if (!to) return { ok: false, error: 'No phone number on file', to: null };
      const r = channel === 'sms' ? await sendSms(to, body) : await sendWhatsApp(to, body);
      return { ok: r.ok, external_id: r.id || null, error: r.error, to };
    }
    return { ok: true, to: null }; // portal/note: nothing to send externally
  }

  // ---- customer portal (separate auth: password OR magic link) ----
  function portalCookie(res, token) { res.setHeader('Set-Cookie', `psid=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`); }
  function portalCustomer(req) {
    const t = parseCookies(req).psid; if (!t) return null;
    const s = db.prepare("SELECT customer_id FROM portal_sessions WHERE token=? AND expires_at>datetime('now')").get(t);
    return s ? db.prepare('SELECT * FROM customers WHERE id=?').get(s.customer_id) : null;
  }
  function requirePortal(req, res, next) { const c = portalCustomer(req); if (!c) return res.status(401).json({ error: 'Please sign in' }); req.pcust = c; next(); }
  const pubBase = () => (getSetting('public_base_url') || '').replace(/\/+$/, '');
  app.get('/portal', (req, res) => res.sendFile(join(PUBLIC_DIR, 'portal.html')));
  app.post('/portal/login', (req, res) => {
    const b = req.body || {}; const email = String(b.email || '').trim().toLowerCase();
    const wait = loginThrottle(req, 'portal:' + email);
    if (wait) return res.status(429).json({ error: `Too many attempts — try again in ${wait} minute(s)` });
    const c = db.prepare("SELECT * FROM customers WHERE lower(billing_email)=? AND portal_enabled=1").get(email);
    if (!c || !c.portal_password || !verifyPassword(String(b.password || ''), c.portal_password)) return res.status(401).json({ error: 'Invalid email or password' });
    loginSucceeded(req, 'portal:' + email);
    const token = randomBytes(24).toString('hex');
    db.prepare("INSERT INTO portal_sessions (token,customer_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").run(token, c.id);
    portalCookie(res, token); res.json({ ok: true });
  });
  app.post('/portal/login-link', (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (loginThrottle(req, 'magic:' + email, { max: 5 })) return res.json({ ok: true }); // silently drop; never reveal existence
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
  const TICKET_CHANNELS = ['portal', 'email', 'sms', 'whatsapp', 'note'];
  function appendMessage(ticketId, { author_type, author, body, channel, direction, external_id, to_addr, from_addr, delivery_status }) {
    return db.prepare("INSERT INTO ticket_messages (ticket_id,author_type,author,body,channel,direction,external_id,to_addr,from_addr,delivery_status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(ticketId, author_type, author || '', body, TICKET_CHANNELS.includes(channel) ? channel : 'portal', direction === 'in' ? 'in' : 'out', N(external_id), N(to_addr), N(from_addr), N(delivery_status)).lastInsertRowid;
  }
  function createTicket({ customer_id, site_id, subject, body, priority, opened_by, author, channel, contact_email, contact_phone }) {
    const cust = db.prepare('SELECT billing_email, sms_number, whatsapp_number FROM customers WHERE id=?').get(customer_id) || {};
    const ch = TICKET_CHANNELS.includes(channel) ? channel : 'portal';
    const email = contact_email || cust.billing_email || null;
    const phone = normPhone(contact_phone || cust.sms_number || cust.whatsapp_number || '') || null;
    const token = randomUUID().replace(/-/g, '');
    const info = db.prepare("INSERT INTO tickets (customer_id,site_id,subject,priority,opened_by,channel,last_channel,contact_email,contact_phone,reply_token) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(customer_id, N(site_id), subject, TICKET_PRIO.includes(priority) ? priority : 'normal', opened_by || 'customer', ch, ch, email, phone, token);
    const id = info.lastInsertRowid;
    db.prepare('UPDATE tickets SET number=? WHERE id=?').run('TKT-' + (1000 + id), id);
    if (body) appendMessage(id, { author_type: opened_by || 'customer', author, body, channel: ch, direction: opened_by === 'staff' ? 'out' : 'in' });
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
  app.post('/api/tickets/:id/reply', requireNoc, async (req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
    const body = String((req.body || {}).body || '').trim(); if (!body) return res.status(400).json({ error: 'Enter a reply' });
    // reply goes out on the customer's channel (last inbound), overridable by the agent
    let channel = String((req.body || {}).channel || '').trim();
    if (!TICKET_CHANNELS.includes(channel)) channel = t.last_channel || t.channel || 'portal';
    let deliv = { ok: true, to: null };
    if (['email', 'sms', 'whatsapp'].includes(channel)) { try { deliv = await deliverOnChannel(t, channel, body); } catch (e) { deliv = { ok: false, error: e.message, to: null }; } }
    appendMessage(t.id, { author_type: 'staff', author: (req.user && req.user.email) || '', body, channel, direction: 'out', external_id: deliv.external_id, to_addr: deliv.to, delivery_status: deliv.ok ? (channel === 'portal' ? null : 'sent') : 'failed' });
    db.prepare("UPDATE tickets SET updated_at=datetime('now'), status=CASE WHEN status IN ('resolved','closed') THEN status ELSE 'waiting' END WHERE id=?").run(t.id);
    audit(req, 'reply', 'ticket#' + t.id, t.number + ' via ' + channel);
    res.json({ ok: true, channel, delivered: deliv.ok, error: deliv.ok ? undefined : deliv.error });
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
    t.messages = db.prepare("SELECT author_type, body, created_at, channel, direction FROM ticket_messages WHERE ticket_id=? AND channel!='note' ORDER BY id").all(t.id);
    res.json(t);
  });
  app.post('/portal/api/tickets/:id/reply', requirePortal, (req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=? AND customer_id=?').get(req.params.id, req.pcust.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const body = String((req.body || {}).body || '').trim(); if (!body) return res.status(400).json({ error: 'Enter a message' });
    appendMessage(t.id, { author_type: 'customer', author: req.pcust.name, body, channel: 'portal', direction: 'in' });
    db.prepare("UPDATE tickets SET updated_at=datetime('now'), last_channel='portal', status=CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END, closed_at=CASE WHEN status IN ('resolved','closed') THEN NULL ELSE closed_at END WHERE id=?").run(t.id);
    ticketNotify(`Reply on ${t.number}: ${t.subject}`, `${req.pcust.name} replied on ${t.number}:\n\n${body}`, `<p><b>${esc2(req.pcust.name)}</b> replied on <b>${esc2(t.number)}</b>:</p><p>${nl2br(body)}</p>`);
    res.json({ ok: true });
  });

  // ---------- Inbound ingestion: email / SMS / WhatsApp all thread into a ticket ----------
  const emailAddr = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
  const findCustomerByEmail = (email) => { email = emailAddr(email); return email ? (db.prepare('SELECT * FROM customers WHERE lower(billing_email)=? ORDER BY id LIMIT 1').get(email) || null) : null; };
  const findCustomerByPhone = (phone) => { const p = normPhone(phone); return p ? (db.prepare('SELECT * FROM customers WHERE sms_number=? OR whatsapp_number=? ORDER BY id LIMIT 1').get(p, p) || null) : null; };
  const openTicketForCustomer = (cid) => db.prepare("SELECT * FROM tickets WHERE customer_id=? AND status NOT IN ('resolved','closed') ORDER BY updated_at DESC LIMIT 1").get(cid) || null;
  function ingestInbound({ channel, from, to, subject, body, external_id }) {
    body = String(body || '').trim(); if (!body && !subject) return { skipped: 'empty' };
    if (external_id) { const dup = db.prepare('SELECT id FROM ticket_messages WHERE external_id=?').get(external_id); if (dup) return { skipped: 'duplicate' }; }
    let t = null, cust = null;
    if (channel === 'email') {
      const rt = (String(to || '') + ' ' + String(subject || '')).match(/\+([0-9a-f]{24,})@/i);
      if (rt) t = db.prepare('SELECT * FROM tickets WHERE reply_token=?').get(rt[1]);
      if (!t) { const m = String(subject || '').match(/TKT-(\d+)/i); if (m) t = db.prepare('SELECT * FROM tickets WHERE number=?').get('TKT-' + m[1]); }
      if (!t) cust = findCustomerByEmail(from);
    } else {
      cust = findCustomerByPhone(from);
      if (cust) t = openTicketForCustomer(cust.id);
    }
    if (!t) {
      if (!cust) { ticketNotify(`Unrecognized inbound ${channel}`, `From ${from}:\n\n${body}`, `<p>Unrecognized <b>${esc2(channel)}</b> from <b>${esc2(from)}</b> — no matching customer on file.</p><p>${nl2br(body)}</p>`); return { skipped: 'no-customer' }; }
      const subj = (subject && subject.trim()) || ((body.split('\n')[0] || (channel + ' message')).slice(0, 120));
      const id = createTicket({ customer_id: cust.id, subject: subj, body, priority: 'normal', opened_by: 'customer', author: from, channel, contact_email: channel === 'email' ? emailAddr(from) : null, contact_phone: channel !== 'email' ? normPhone(from) : null });
      if (external_id) db.prepare("UPDATE ticket_messages SET external_id=? WHERE id=(SELECT id FROM ticket_messages WHERE ticket_id=? ORDER BY id LIMIT 1)").run(external_id, id); // dedupe re-delivered opener
      const nt = db.prepare('SELECT number FROM tickets WHERE id=?').get(id);
      ticketNotify(`New ${channel} ticket ${nt.number}: ${subj}`, `${from} via ${channel}:\n\n${body}`, `<p>New <b>${esc2(channel)}</b> ticket <b>${esc2(nt.number)}</b> from ${esc2(from)}:</p><p>${nl2br(body)}</p>`);
      return { ticket_id: id, number: nt.number, created: true };
    }
    appendMessage(t.id, { author_type: 'customer', author: from, body, channel, direction: 'in', external_id, from_addr: channel === 'email' ? emailAddr(from) : normPhone(from) });
    db.prepare("UPDATE tickets SET updated_at=datetime('now'), last_channel=?, status=CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END, closed_at=CASE WHEN status IN ('resolved','closed') THEN NULL ELSE closed_at END WHERE id=?").run(channel, t.id);
    ticketNotify(`Reply on ${t.number}: ${t.subject}`, `${from} via ${channel}:\n\n${body}`, `<p><b>${esc2(from)}</b> replied via <b>${esc2(channel)}</b> on <b>${esc2(t.number)}</b>:</p><p>${nl2br(body)}</p>`);
    return { ticket_id: t.id, number: t.number };
  }
  const inboundSecretOk = (req) => { const s = getSetting('inbound_secret'); return !!s && req.params.secret === s; };
  // Twilio SMS + WhatsApp inbound (application/x-www-form-urlencoded). Empty TwiML reply = accepted, no auto-response.
  app.post('/inbound/twilio/:secret', (req, res) => {
    if (!inboundSecretOk(req)) return res.status(403).type('text/xml').send('<Response/>');
    const b = req.body || {}; const rawFrom = String(b.From || ''); const wa = rawFrom.startsWith('whatsapp:');
    try { ingestInbound({ channel: wa ? 'whatsapp' : 'sms', from: rawFrom.replace(/^whatsapp:/, ''), to: String(b.To || '').replace(/^whatsapp:/, ''), body: b.Body || '', external_id: b.MessageSid || b.SmsSid || null }); }
    catch (e) { console.warn('twilio inbound failed:', e.message); }
    res.type('text/xml').send('<Response/>');
  });
  // Telnyx SMS + WhatsApp inbound (JSON; registered with raw body up top). Secret path-gated.
  function inboundTelnyx(req, res) {
    const secret = getSetting('inbound_secret');
    if (secret && req.params.secret !== secret) return res.status(403).end();
    let payload = {}; try { payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body || '{}')); } catch { return res.status(400).end(); }
    const evt = payload.data || {}; if (evt.event_type && evt.event_type !== 'message.received') return res.status(200).end();
    const d = evt.payload || {};
    const from = (d.from && d.from.phone_number) || ''; const to = (Array.isArray(d.to) && d.to[0] && d.to[0].phone_number) || '';
    try { ingestInbound({ channel: d.type === 'whatsapp' ? 'whatsapp' : 'sms', from, to, body: d.text || '', external_id: d.id || null }); }
    catch (e) { console.warn('telnyx inbound failed:', e.message); }
    res.status(200).end();
  }
  // Email inbound webhook — provider-agnostic (Mailgun form, Postmark/SendGrid JSON). Secret path-gated.
  app.post('/inbound/email/:secret', (req, res) => {
    if (!inboundSecretOk(req)) return res.status(403).end();
    const b = req.body || {};
    const from = b.from || b.From || b.sender || b.FromFull && b.FromFull.Email || '';
    let to = b.to || b.To || b.recipient || '';
    if (!to && b.envelope) { try { to = (JSON.parse(b.envelope).to || [])[0] || ''; } catch {} }
    const subject = b.subject || b.Subject || '';
    const body = b['stripped-text'] || b.TextBody || b.text || b['body-plain'] || b.plain || '';
    const external_id = b['Message-Id'] || b.MessageID || b.MessageId || b['message-id'] || null;
    try { const r = ingestInbound({ channel: 'email', from, to, subject, body: String(body).trim(), external_id }); res.json({ ok: true, ...r }); }
    catch (e) { console.warn('email inbound failed:', e.message); res.status(500).json({ error: e.message }); }
  });
  // IMAP poller — pulls unseen mail from the support mailbox and threads it into tickets (runs from the sampler)
  let _imapBusy = false;
  async function pollImap() {
    if (getSetting('email_inbound_method') !== 'imap') return;
    const host = getSetting('imap_host'), user = getSetting('imap_user'), pass = getSetting('imap_pass');
    if (!host || !user || !pass || _imapBusy) return;
    _imapBusy = true;
    try {
      const { ImapFlow } = await import('imapflow');
      const { simpleParser } = await import('mailparser');
      const client = new ImapFlow({ host, port: parseInt(getSetting('imap_port'), 10) || 993, secure: getSetting('imap_tls') !== '0', auth: { user, pass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        for (const uid of (uids || []).slice(0, 50)) {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const p = await simpleParser(msg.source);
          const from = (p.from && p.from.text) || '';
          const to = ((p.to && p.to.text) || '') + ' ' + (p.headers.get('delivered-to') || '') + ' ' + (p.cc && p.cc.text || '');
          const body = (p.text || (p.html ? String(p.html).replace(/<[^>]+>/g, ' ') : '')).trim();
          try { ingestInbound({ channel: 'email', from, to, subject: p.subject || '', body, external_id: p.messageId || ('imap-' + uid) }); }
          catch (e) { console.warn('imap ingest:', e.message); }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      } finally { lock.release(); await client.logout().catch(() => {}); }
    } catch (e) { console.warn('IMAP poll failed:', e.message); }
    finally { _imapBusy = false; }
  }


  // exposed for server.js (raw-body route + sampler) and cross-domain callers
  ctx.jobs.pollImap = pollImap;
  ctx.jobs.inboundTelnyx = inboundTelnyx;
  ctx.requirePortal = requirePortal;
  ctx.pubBase = pubBase;
  ctx.deliverOnChannel = deliverOnChannel;
}
