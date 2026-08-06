// Billing domain: products, invoices, quotes, payments, recurring schedules, Stripe,
// the public pay/quote pages, per-account P&L, and the Invoice Ninja importer.
// Registered from server.js; shared services arrive via ctx so this module owns no globals.
import express from "express";
import { randomBytes } from "node:crypto";
import { r2, todayStr, esc2, normPhone } from "../lib/core.js";

export default function registerBilling(app, ctx) {
  const { db, N, audit, requireNoc, role, getSetting, setSetting, mailSafe,
          setCustomerAccounts, accountCustomers } = ctx;

  // ---- Invoice Ninja import (JSON export or API-shaped payload) ----
  // Backup exports nest differently between versions, so hunt for the first array of objects under a key.
  function findEntityArray(root, key) {
    const seen = new Set(); const stack = [root];
    while (stack.length) {
      const node = stack.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) { for (const v of node) if (v && typeof v === 'object') stack.push(v); continue; }
      const direct = node[key];
      if (Array.isArray(direct) && direct.every(x => x && typeof x === 'object')) return direct;
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    return [];
  }
  const IN_STATUS = { 1: 'draft', 2: 'sent', 3: 'partial', 4: 'paid', 5: 'void', 6: 'void' };
  function ninjaClientFields(c) {
    const contacts = Array.isArray(c.contacts) ? c.contacts : [];
    const c0 = contacts[0] || {};
    const name = (c.name || c.display_name || [c0.first_name, c0.last_name].filter(Boolean).join(' ') || '').trim();
    const email = String(c.email || c0.email || '').trim().toLowerCase();
    const phone = String(c.phone || c0.phone || '').trim();
    const notes = [c.public_notes, c.private_notes].filter(Boolean).join('\n').trim();
    return { name, email, phone, notes };
  }
  function importNinja(data, accountId, commit) {
    const clients = findEntityArray(data, 'clients');
    const invoices = findEntityArray(data, 'invoices');
    const payments = findEntityArray(data, 'payments');
    const res = { customers_created: 0, customers_matched: 0, invoices_created: 0, invoices_skipped: 0, payments_created: 0, warnings: [], samples: { customers: [], invoices: [] } };
    const custMap = {}; // ninja client id -> our customer id

    for (const c of clients) {
      const f = ninjaClientFields(c);
      if (!f.name && !f.email) { res.warnings.push('Skipped a client with no name or email'); continue; }
      const label = f.name || f.email;
      let existing = null;
      if (f.email) existing = db.prepare('SELECT id FROM customers WHERE lower(billing_email)=?').get(f.email);
      if (!existing) existing = db.prepare('SELECT id FROM customers WHERE lower(name)=?').get(label.toLowerCase());
      if (existing) {
        res.customers_matched++; custMap[c.id] = existing.id;
        if (commit) { // fill in blanks only — never overwrite what's already there
          const cur = db.prepare('SELECT billing_email, sms_number, notes FROM customers WHERE id=?').get(existing.id);
          if (f.email && !cur.billing_email) db.prepare('UPDATE customers SET billing_email=? WHERE id=?').run(f.email, existing.id);
          if (f.phone && !cur.sms_number) db.prepare('UPDATE customers SET sms_number=? WHERE id=?').run(normPhone(f.phone), existing.id);
          if (f.notes && !cur.notes) db.prepare('UPDATE customers SET notes=? WHERE id=?').run(f.notes, existing.id);
        }
      } else {
        res.customers_created++;
        if (res.samples.customers.length < 5) res.samples.customers.push({ name: label, email: f.email || null });
        if (commit) {
          const info = db.prepare('INSERT INTO customers (account_id,name,status,notes,billing_email,sms_number) VALUES (?,?,?,?,?,?)')
            .run(accountId, label, 'Active', f.notes || null, f.email || null, normPhone(f.phone) || null);
          setCustomerAccounts(info.lastInsertRowid, [accountId]);
          custMap[c.id] = info.lastInsertRowid;
        } else custMap[c.id] = 'preview'; // placeholder so the dry-run counts their invoices too
      }
    }

    // payments grouped by the invoice they apply to
    const payByInvoice = {};
    for (const p of payments) {
      const links = Array.isArray(p.paymentables) && p.paymentables.length
        ? p.paymentables.filter(x => x.invoice_id || x.invoice_id === 0).map(x => ({ invoice_id: x.invoice_id, amount: Number(x.amount != null ? x.amount : p.amount) || 0 }))
        : (p.invoice_id ? [{ invoice_id: p.invoice_id, amount: Number(p.amount) || 0 }] : []);
      for (const l of links) {
        (payByInvoice[l.invoice_id] = payByInvoice[l.invoice_id] || []).push({
          date: (p.date || p.created_at || todayStr()).slice(0, 10), amount: r2(l.amount),
          reference: p.transaction_reference || (p.type_id ? 'Invoice Ninja type ' + p.type_id : 'Invoice Ninja import')
        });
      }
    }

    for (const inv of invoices) {
      const number = String(inv.number || '').trim();
      if (!number) { res.warnings.push('Skipped an invoice with no number'); continue; }
      const custId = custMap[inv.client_id];
      if (!custId) { res.warnings.push(`Invoice ${number}: no matching client in the file — skipped`); res.invoices_skipped++; continue; }
      if (db.prepare('SELECT id FROM bill_invoices WHERE number=?').get(number)) { res.invoices_skipped++; continue; } // already imported
      const rawItems = Array.isArray(inv.line_items) ? inv.line_items : [];
      const items = rawItems.map(it => ({
        description: String(it.notes || it.product_key || 'Item').slice(0, 300),
        quantity: Number(it.quantity != null ? it.quantity : 1) || 0,
        unit_price: Number(it.cost != null ? it.cost : 0) || 0,
        taxable: (Number(it.tax_rate1) > 0 || it.tax_name1) ? 1 : 0
      }));
      const taxRate = Number(inv.tax_rate1 || (rawItems[0] && rawItems[0].tax_rate1) || 0) || 0;
      const computed = computeTotals(items, taxRate);
      const subtotal = computed.subtotal;
      const total = inv.amount != null && Number(inv.amount) ? r2(Number(inv.amount)) : computed.total;
      const tax = r2(Math.max(0, total - subtotal));
      const pays = payByInvoice[inv.id] || [];
      const paid = r2(pays.reduce((n, p) => n + p.amount, 0));
      // balance: derive from imported payments when we have them, else trust Invoice Ninja's balance
      const balance = pays.length ? r2(Math.max(0, total - paid)) : (inv.balance != null ? r2(Number(inv.balance)) : total);
      let status = IN_STATUS[inv.status_id] || 'sent';
      if (status !== 'draft' && status !== 'void') status = balance <= 0 ? 'paid' : (balance < total ? 'partial' : status);
      res.invoices_created++;
      if (res.samples.invoices.length < 5) res.samples.invoices.push({ number, total, balance, status, items: items.length });
      if (commit) {
        const info = db.prepare(`INSERT INTO bill_invoices (number,customer_id,email,date,due_date,status,tax_rate,subtotal,tax,total,balance,notes,pay_token)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, custId, N(inv.email) || null, (inv.date || todayStr()).slice(0, 10), inv.due_date ? String(inv.due_date).slice(0, 10) : null,
          status, taxRate, subtotal, tax, total, balance, N(inv.public_notes) || null, randomBytes(18).toString('hex'));
        const invId = info.lastInsertRowid;
        const insItem = db.prepare('INSERT INTO bill_items (invoice_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
        for (const it of items) insItem.run(invId, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
        const insPay = db.prepare("INSERT INTO bill_payments (invoice_id,date,amount,method,reference,notes) VALUES (?,?,?,'other',?,'Imported from Invoice Ninja')");
        for (const p of pays) { insPay.run(invId, p.date, p.amount, p.reference); res.payments_created++; }
      } else {
        res.payments_created += pays.length;
      }
    }
    res.counts = { clients_in_file: clients.length, invoices_in_file: invoices.length, payments_in_file: payments.length };
    return res;
  }
  app.post('/api/import/invoiceninja', requireNoc, (req, res) => {
    const b = req.body || {};
    let data = b.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return res.status(400).json({ error: 'Could not parse that JSON: ' + e.message }); } }
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'No JSON data provided' });
    const accountId = Number(b.account_id);
    if (!db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)) return res.status(400).json({ error: 'Pick a valid account to attach imported clients to' });
    try {
      const out = importNinja(data, accountId, !!b.commit);
      if (b.commit) audit(req, 'import', 'invoiceninja', `${out.customers_created} customers, ${out.invoices_created} invoices, ${out.payments_created} payments`);
      res.json({ ok: true, committed: !!b.commit, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- profit & loss (per account: cost of accounts+sub-accounts vs recurring client revenue) ----
  const MONTHLY_FACTOR = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, semiannual: 1 / 6, yearly: 1 / 12 };
  const monthlyize = (amt, freq) => r2(Number(amt || 0) * (MONTHLY_FACTOR[freq] || 1));
  // monthly recurring revenue per customer (pre-tax subtotal — tax is pass-through, not income)
  function customerMonthlyRevenue() {
    const map = {}; // customer_id -> monthly subtotal
    for (const r of db.prepare('SELECT customer_id, frequency, items_json, tax_rate FROM bill_recurring WHERE active=1').all()) {
      let items = []; try { items = JSON.parse(r.items_json || '[]'); } catch {}
      map[r.customer_id] = r2((map[r.customer_id] || 0) + monthlyize(computeTotals(items, 0).subtotal, r.frequency));
    }
    return map;
  }
  // full P&L across accounts. Revenue is attributed to each account serving a customer, split evenly.
  function computePnl() {
    const custRev = customerMonthlyRevenue();
    const accounts = db.prepare('SELECT id, name, status, monthly_cost FROM accounts ORDER BY name').all();
    const acc = {}; for (const a of accounts) acc[a.id] = { account_id: a.id, name: a.name, status: a.status, base_cost: r2(a.monthly_cost || 0), sub_cost: 0, revenue: 0, customer_count: 0 };
    // sub-account costs
    for (const s of db.prepare('SELECT account_id, monthly_cost FROM account_subaccounts').all()) if (acc[s.account_id]) acc[s.account_id].sub_cost = r2(acc[s.account_id].sub_cost + (s.monthly_cost || 0));
    // revenue: split each customer's monthly revenue evenly across the accounts serving it
    for (const [cid, rev] of Object.entries(custRev)) {
      const ids = db.prepare('SELECT account_id FROM account_customers WHERE customer_id=?').all(cid).map(r => r.account_id).filter(id => acc[id]);
      if (!ids.length) continue;
      const share = r2(rev / ids.length);
      for (const id of ids) { acc[id].revenue = r2(acc[id].revenue + share); acc[id].customer_count++; }
    }
    const rows = Object.values(acc).map(a => { const cost = r2(a.base_cost + a.sub_cost); return { ...a, cost, margin: r2(a.revenue - cost), margin_pct: a.revenue ? r2(((a.revenue - cost) / a.revenue) * 100) : null }; });
    const totals = rows.reduce((t, r) => ({ base_cost: r2(t.base_cost + r.base_cost), sub_cost: r2(t.sub_cost + r.sub_cost), cost: r2(t.cost + r.cost), revenue: r2(t.revenue + r.revenue), margin: r2(t.margin + r.margin) }), { base_cost: 0, sub_cost: 0, cost: 0, revenue: 0, margin: 0 });
    return { rows, totals };
  }
  app.get('/api/pnl', requireNoc, (req, res) => res.json(computePnl()));
  app.get('/api/accounts/:id/pnl', requireNoc, (req, res) => {
    const a = db.prepare('SELECT id, name, monthly_cost FROM accounts WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    const subs = db.prepare('SELECT id, name, monthly_cost, status FROM account_subaccounts WHERE account_id=? ORDER BY id').all(a.id);
    const sub_cost = r2(subs.reduce((n, s) => n + (s.monthly_cost || 0), 0));
    const base_cost = r2(a.monthly_cost || 0); const cost = r2(base_cost + sub_cost);
    const custRev = customerMonthlyRevenue();
    const custs = accountCustomers(a.id).map(c => {
      const ids = db.prepare('SELECT account_id FROM account_customers WHERE customer_id=?').all(c.id).map(r => r.account_id);
      const full = custRev[c.id] || 0; const share = ids.length ? r2(full / ids.length) : 0;
      return { id: c.id, name: c.name, monthly_revenue: share, shared: ids.length > 1, accounts: ids.length };
    }).filter(c => c.monthly_revenue > 0);
    const revenue = r2(custs.reduce((n, c) => n + c.monthly_revenue, 0));
    res.json({ account_id: a.id, name: a.name, base_cost, sub_cost, cost, revenue, margin: r2(revenue - cost), margin_pct: revenue ? r2(((revenue - cost) / revenue) * 100) : null, subaccounts: subs, customers: custs });
  });


  // ---- billing: standalone invoicing (Stripe processes card/ACH; card data never touches this server) ----
  function computeTotals(items, taxRate) {
    const line = it => Number(it.quantity || 1) * Number(it.unit_price || 0);
    const subtotal = r2(items.reduce((n, it) => n + line(it), 0));
    const taxableBase = r2(items.filter(it => it.taxable !== 0 && it.taxable !== false).reduce((n, it) => n + line(it), 0));
    const tax = r2(taxableBase * (Number(taxRate || 0) / 100));
    return { subtotal, tax, total: r2(subtotal + tax) };
  }
  function nextInvoiceNumber() {
    const prefix = getSetting('bill_prefix') || 'INV-';
    const seq = parseInt(getSetting('bill_next'), 10) || 1001;
    setSetting('bill_next', String(seq + 1));
    return prefix + seq;
  }
  function cleanItems(raw) {
    return (Array.isArray(raw) ? raw : []).map(it => ({
      description: String(it.description || '').slice(0, 400),
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unit_price: r2(it.unit_price),
      taxable: (it.taxable === 0 || it.taxable === false) ? 0 : 1
    })).filter(it => it.description || it.unit_price);
  }
  function insertInvoice({ customer_id, email, date, due_date, tax_rate, notes, items, status, terms }) {
    const t = computeTotals(items, tax_rate);
    const info = db.prepare(`INSERT INTO bill_invoices (number,customer_id,email,date,due_date,status,tax_rate,subtotal,tax,total,balance,notes,terms,pay_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nextInvoiceNumber(), customer_id, N(email), date || todayStr(), N(due_date), status || 'draft',
           Number(tax_rate || 0), t.subtotal, t.tax, t.total, t.total, N(notes), N(terms), randomBytes(18).toString('hex'));
    const ins = db.prepare('INSERT INTO bill_items (invoice_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
    for (const it of items) ins.run(info.lastInsertRowid, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
    return info.lastInsertRowid;
  }
  function loadInvoice(id) {
    const inv = db.prepare(`SELECT i.*, c.name AS customer_name, c.billing_email FROM bill_invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=?`).get(id);
    if (!inv) return null;
    inv.items = db.prepare('SELECT * FROM bill_items WHERE invoice_id=? ORDER BY id').all(id);
    inv.payments = db.prepare('SELECT * FROM bill_payments WHERE invoice_id=? ORDER BY date, id').all(id);
    const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
    inv.pay_url = pub && inv.pay_token ? `${pub}/pay/${inv.pay_token}` : null;
    return inv;
  }
  // Record a payment and roll the invoice status forward. Idempotent per Stripe payment-intent.
  function applyPayment(invId, { amount, method, reference, stripe_pi, date, notes }) {
    const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(invId);
    if (!inv) throw Object.assign(new Error('invoice not found'), { http: 404 });
    if (stripe_pi && db.prepare('SELECT id FROM bill_payments WHERE stripe_pi=?').get(stripe_pi)) return { duplicate: true };
    const amt = r2(amount);
    if (!(amt > 0)) throw Object.assign(new Error('amount must be > 0'), { http: 400 });
    db.prepare('INSERT INTO bill_payments (invoice_id,date,amount,method,reference,stripe_pi,notes) VALUES (?,?,?,?,?,?,?)')
      .run(invId, date || todayStr(), amt, method || 'other', N(reference), N(stripe_pi), N(notes));
    const balance = r2(Math.max(0, inv.balance - amt));
    const status = balance <= 0 ? 'paid' : 'partial';
    db.prepare('UPDATE bill_invoices SET balance=?, status=? WHERE id=?').run(balance, status, invId);
    return { balance, status };
  }
  // Email an invoice (uses the SMTP settings) with the public pay link when available
  function emailInvoice(inv) {
    const to = inv.email || inv.billing_email;
    if (!to) return false;
    const company = getSetting('bill_company') || 'Network Inventory';
    const lines = inv.items.map(it => ` - ${it.description}  x${it.quantity}  $${it.amount.toFixed(2)}`).join('\n');
    const rows = inv.items.map(it => `<tr><td style="padding:4px 12px 4px 0">${esc2(it.description)}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
    const payBit = inv.pay_url ? `\n\nPay online (card or bank/ACH): ${inv.pay_url}` : '';
    const payBtn = inv.pay_url ? `<p style="margin:18px 0"><a href="${inv.pay_url}" style="background:#378ADD;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none">Pay invoice online</a><br><span style="color:#777;font-size:12px">Card or bank transfer (ACH), processed securely by Stripe.</span></p>` : '';
    mailSafe({
      to, subject: `Invoice ${inv.number} from ${company} — $${inv.total.toFixed(2)}${inv.due_date ? ' due ' + inv.due_date : ''}`,
      text: `Invoice ${inv.number} from ${company}\nDate: ${inv.date}${inv.due_date ? '\nDue: ' + inv.due_date : ''}\n\n${lines}\n\nTotal: $${inv.total.toFixed(2)}\nBalance due: $${inv.balance.toFixed(2)}${payBit}${inv.notes ? '\n\n' + inv.notes : ''}`,
      html: `<h2>Invoice ${esc2(inv.number)}</h2><p>${esc2(company)} · ${esc2(inv.date)}${inv.due_date ? ' · due <b>' + esc2(inv.due_date) + '</b>' : ''}</p>
        <table style="border-collapse:collapse">${rows}<tr><td style="padding:8px 12px 0 0"><b>Total</b></td><td></td><td align="right"><b>$${inv.total.toFixed(2)}</b></td></tr></table>
        ${payBtn}${inv.notes ? `<p style="color:#555">${esc2(inv.notes)}</p>` : ''}`
    });
    return true;
  }
  // ---- Stripe (REST via fetch; no SDK) ----
  async function stripeReq(method, path, params) {
    const key = getSetting('stripe_secret');
    if (!key) throw Object.assign(new Error('Set the Stripe secret key in Settings first'), { http: 400 });
    const r = await fetch('https://api.stripe.com' + path, {
      method,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params ? new URLSearchParams(params).toString() : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error('Stripe: ' + ((j.error && j.error.message) || ('HTTP ' + r.status))), { http: 502 });
    return j;
  }
  function verifyStripeSig(rawBody, sigHeader, secret) {
    if (!sigHeader || !secret) return false;
    let t = null; const v1s = [];
    for (const part of String(sigHeader).split(',')) {
      const [k, v] = part.split('=');
      if (k === 't') t = v; else if (k === 'v1') v1s.push(v);
    }
    if (!t || !v1s.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min replay tolerance
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return v1s.some(v => { try { return v.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch { return false; } });
  }
  function stripeWebhook(req, res) {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!verifyStripeSig(raw, req.headers['stripe-signature'], getSetting('stripe_webhook_secret'))) return res.status(400).json({ error: 'bad signature' });
    let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad payload' }); }
    try {
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) {
        const s = ev.data.object;
        const invId = Number(s.metadata && s.metadata.invoice_id);
        // cards are paid at completion; ACH completes now and settles later via async_payment_succeeded
        if (invId && s.payment_status === 'paid') {
          const out = applyPayment(invId, { amount: (s.amount_total || 0) / 100, method: 'stripe', reference: s.payment_intent, stripe_pi: s.payment_intent });
          if (!out.duplicate) db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)')
            .run('stripe', 'system', 'payment', 'invoice#' + invId, `$${((s.amount_total || 0) / 100).toFixed(2)} via Stripe (${ev.type})`);
        }
      } else if (ev.type === 'checkout.session.async_payment_failed') {
        const s = ev.data.object;
        const invId = Number(s.metadata && s.metadata.invoice_id);
        if (invId) db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)')
          .run('stripe', 'system', 'payment_failed', 'invoice#' + invId, 'ACH payment failed');
      }
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
  // ---- billing API (NOC/Admin) ----
  app.get('/api/billing/summary', requireNoc, (req, res) => {
    const today = todayStr();
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    res.json({
      stripe: !!getSetting('stripe_secret'),
      outstanding: db.prepare("SELECT COALESCE(SUM(balance),0) v FROM bill_invoices WHERE status IN ('sent','partial')").get().v,
      overdue: db.prepare("SELECT COALESCE(SUM(balance),0) v FROM bill_invoices WHERE status IN ('sent','partial') AND due_date IS NOT NULL AND due_date<?").get(today).v,
      overdue_count: db.prepare("SELECT COUNT(*) v FROM bill_invoices WHERE status IN ('sent','partial') AND due_date IS NOT NULL AND due_date<?").get(today).v,
      collected_30d: db.prepare('SELECT COALESCE(SUM(amount),0) v FROM bill_payments WHERE date>=?').get(monthAgo).v,
      draft_count: db.prepare("SELECT COUNT(*) v FROM bill_invoices WHERE status='draft'").get().v
    });
  });
  app.get('/api/billing/products', requireNoc, (req, res) => {
    res.json(db.prepare('SELECT * FROM bill_products WHERE active=1 ORDER BY name').all());
  });
  app.post('/api/billing/products', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Name required' });
    const info = db.prepare('INSERT INTO bill_products (name,description,price,taxable) VALUES (?,?,?,?)').run(b.name, N(b.description), r2(b.price), b.taxable === false ? 0 : 1);
    audit(req, 'create', 'product#' + info.lastInsertRowid, b.name);
    res.json({ id: info.lastInsertRowid });
  });
  app.put('/api/billing/products/:id', requireNoc, (req, res) => {
    const b = req.body || {};
    const ex = db.prepare('SELECT * FROM bill_products WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE bill_products SET name=?, description=?, price=?, taxable=? WHERE id=?')
      .run(N(b.name, ex.name), N(b.description, ex.description), b.price === undefined ? ex.price : r2(b.price),
           b.taxable === undefined ? ex.taxable : (b.taxable ? 1 : 0), req.params.id);
    audit(req, 'edit', 'product#' + req.params.id, b.name || ex.name);
    res.json({ ok: true });
  });
  app.delete('/api/billing/products/:id', requireNoc, (req, res) => {
    db.prepare('UPDATE bill_products SET active=0 WHERE id=?').run(req.params.id); // soft delete: past invoice lines stay intact
    audit(req, 'delete', 'product#' + req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/billing/invoices', requireNoc, (req, res) => {
    const q = '%' + String(req.query.q || '').trim() + '%';
    let sql = `SELECT i.id, i.number, i.customer_id, i.date, i.due_date, i.status, i.total, i.balance, c.name AS customer_name
      FROM bill_invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE (i.number LIKE ? OR c.name LIKE ?)`;
    const args = [q, q];
    if (req.query.status) { sql += ' AND i.status=?'; args.push(String(req.query.status)); }
    sql += ' ORDER BY i.id DESC LIMIT 300';
    res.json(db.prepare(sql).all(...args));
  });
  app.get('/api/billing/invoices/:id', requireNoc, (req, res) => {
    const inv = loadInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    res.json(inv);
  });
  app.post('/api/billing/invoices', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.customer_id) return res.status(400).json({ error: 'Pick a customer' });
    const items = cleanItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
    const id = insertInvoice({ customer_id: Number(b.customer_id), email: b.email, date: b.date, due_date: b.due_date, tax_rate: b.tax_rate, notes: b.notes, items, status: 'draft', terms: getSetting('invoice_terms') });
    let emailed = false;
    if (b.send) {
      emailed = emailInvoice(loadInvoice(id));
      db.prepare("UPDATE bill_invoices SET status='sent', sent_at=datetime('now') WHERE id=?").run(id);
    }
    const num = db.prepare('SELECT number FROM bill_invoices WHERE id=?').get(id).number;
    audit(req, 'create', 'invoice#' + id, num + (b.send ? ' (sent)' : ' (draft)'));
    res.json({ id, number: num, emailed });
  });
  app.put('/api/billing/invoices/:id', requireNoc, (req, res) => {
    const b = req.body || {};
    const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.status !== 'draft') return res.status(409).json({ error: 'Only draft invoices can be edited' });
    const items = cleanItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
    const t = computeTotals(items, b.tax_rate === undefined ? inv.tax_rate : b.tax_rate);
    db.prepare('UPDATE bill_invoices SET customer_id=?, email=?, date=?, due_date=?, tax_rate=?, subtotal=?, tax=?, total=?, balance=?, notes=? WHERE id=?')
      .run(Number(b.customer_id || inv.customer_id), N(b.email, inv.email), b.date || inv.date, N(b.due_date, inv.due_date),
           Number(b.tax_rate === undefined ? inv.tax_rate : b.tax_rate), t.subtotal, t.tax, t.total, t.total, N(b.notes, inv.notes), inv.id);
    db.prepare('DELETE FROM bill_items WHERE invoice_id=?').run(inv.id);
    const ins = db.prepare('INSERT INTO bill_items (invoice_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
    for (const it of items) ins.run(inv.id, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
    audit(req, 'edit', 'invoice#' + inv.id, inv.number);
    res.json({ ok: true });
  });
  app.post('/api/billing/invoices/:id/send', requireNoc, (req, res) => {
    const inv = loadInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (['paid', 'void'].includes(inv.status)) return res.status(409).json({ error: 'Invoice is ' + inv.status });
    const emailed = emailInvoice(inv);
    if (inv.status === 'draft') db.prepare("UPDATE bill_invoices SET status='sent', sent_at=datetime('now') WHERE id=?").run(inv.id);
    audit(req, 'edit', 'invoice#' + inv.id, inv.number + (emailed ? ' emailed' : ' marked sent (no email on file)'));
    res.json({ ok: true, emailed });
  });
  app.post('/api/billing/invoices/:id/pay', requireNoc, (req, res) => {
    const b = req.body || {};
    try {
      const out = applyPayment(Number(req.params.id), { amount: b.amount, method: b.method || 'other', reference: b.reference, date: b.date, notes: b.notes });
      audit(req, 'payment', 'invoice#' + req.params.id, `$${r2(b.amount).toFixed(2)} ${b.method || 'other'}${b.reference ? ' · ' + b.reference : ''}`);
      res.json({ ok: true, ...out });
    } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
  });
  app.post('/api/billing/invoices/:id/void', requireNoc, (req, res) => {
    const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.status === 'paid') return res.status(409).json({ error: 'Paid invoices cannot be voided' });
    db.prepare("UPDATE bill_invoices SET status='void', balance=0 WHERE id=?").run(inv.id);
    audit(req, 'edit', 'invoice#' + inv.id, inv.number + ' voided');
    res.json({ ok: true });
  });
  app.delete('/api/billing/invoices/:id', requireNoc, (req, res) => {
    const inv = db.prepare('SELECT * FROM bill_invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (!['draft', 'void'].includes(inv.status)) return res.status(409).json({ error: 'Only draft or void invoices can be deleted — void it first' });
    db.prepare('DELETE FROM bill_items WHERE invoice_id=?').run(inv.id);
    db.prepare('DELETE FROM bill_payments WHERE invoice_id=?').run(inv.id);
    db.prepare('DELETE FROM bill_invoices WHERE id=?').run(inv.id);
    audit(req, 'delete', 'invoice#' + inv.id, inv.number);
    res.json({ ok: true });
  });
  app.get('/api/billing/payments', requireNoc, (req, res) => {
    res.json(db.prepare(`SELECT p.*, i.number AS invoice_number, c.name AS customer_name
      FROM bill_payments p JOIN bill_invoices i ON i.id=p.invoice_id LEFT JOIN customers c ON c.id=i.customer_id
      ORDER BY p.date DESC, p.id DESC LIMIT 300`).all());
  });
  // ---- recurring schedules ----
  const FREQS = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', yearly: 'Yearly' };
  const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
  function advanceDate(dateStr, freq) {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + (FREQ_MONTHS[freq] || 1));
    return d.toISOString().slice(0, 10);
  }
  app.get('/api/billing/recurring', requireNoc, (req, res) => {
    const rows = db.prepare(`SELECT r.*, c.name AS customer_name FROM bill_recurring r LEFT JOIN customers c ON c.id=r.customer_id ORDER BY r.active DESC, c.name`).all();
    for (const r of rows) {
      try { r.items = JSON.parse(r.items_json); } catch { r.items = []; }
      r.amount = computeTotals(r.items, r.tax_rate).total;
      r.frequency_label = FREQS[r.frequency] || r.frequency;
      delete r.items_json;
    }
    res.json(rows);
  });
  app.post('/api/billing/recurring', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.customer_id) return res.status(400).json({ error: 'Pick a customer' });
    const items = cleanItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
    if (!b.next_date) return res.status(400).json({ error: 'Set the next invoice date' });
    const freq = FREQS[b.frequency] ? b.frequency : 'monthly';
    const info = db.prepare('INSERT INTO bill_recurring (customer_id,frequency,next_date,tax_rate,items_json,auto_send,active) VALUES (?,?,?,?,?,?,1)')
      .run(Number(b.customer_id), freq, b.next_date, Number(b.tax_rate || 0), JSON.stringify(items), b.auto_send === false ? 0 : 1);
    audit(req, 'create', 'recurring#' + info.lastInsertRowid, `customer#${b.customer_id} ${freq}`);
    res.json({ id: info.lastInsertRowid });
  });
  app.put('/api/billing/recurring/:id', requireNoc, (req, res) => {
    const b = req.body || {};
    const ex = db.prepare('SELECT * FROM bill_recurring WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const items = b.items !== undefined ? cleanItems(b.items) : null;
    db.prepare('UPDATE bill_recurring SET customer_id=?, frequency=?, next_date=?, tax_rate=?, items_json=?, auto_send=?, active=? WHERE id=?')
      .run(Number(b.customer_id || ex.customer_id), FREQS[b.frequency] ? b.frequency : ex.frequency, b.next_date || ex.next_date,
           Number(b.tax_rate === undefined ? ex.tax_rate : b.tax_rate), items ? JSON.stringify(items) : ex.items_json,
           b.auto_send === undefined ? ex.auto_send : (b.auto_send ? 1 : 0),
           b.active === undefined ? ex.active : (b.active ? 1 : 0), ex.id);
    audit(req, 'edit', 'recurring#' + ex.id);
    res.json({ ok: true });
  });
  app.delete('/api/billing/recurring/:id', requireNoc, (req, res) => {
    db.prepare('DELETE FROM bill_recurring WHERE id=?').run(req.params.id);
    audit(req, 'delete', 'recurring#' + req.params.id);
    res.json({ ok: true });
  });
  // Generate invoices for due schedules (sampler runs this hourly; button exposes it too)
  function runRecurringBilling() {
    const due = db.prepare('SELECT * FROM bill_recurring WHERE active=1 AND next_date<=?').all(todayStr());
    let made = 0;
    for (const r of due) {
      let items = []; try { items = JSON.parse(r.items_json); } catch {}
      if (!items.length) continue;
      const cust = db.prepare('SELECT billing_email FROM customers WHERE id=?').get(r.customer_id);
      if (!cust) { // customer is gone (legacy orphan) — deactivate instead of billing into the void
        db.prepare('UPDATE bill_recurring SET active=0 WHERE id=?').run(r.id);
        db.prepare("INSERT INTO audit_log (actor,role,action,target,details) VALUES ('system','system','edit',?,?)").run('recurring#' + r.id, 'deactivated: customer no longer exists');
        continue;
      }
      const id = insertInvoice({ customer_id: r.customer_id, email: cust.billing_email, date: r.next_date, due_date: advanceDate(r.next_date, 'monthly'), tax_rate: r.tax_rate, items, status: r.auto_send ? 'sent' : 'draft', terms: getSetting('recurring_invoice_terms') || getSetting('invoice_terms') });
      if (r.auto_send) { emailInvoice(loadInvoice(id)); db.prepare("UPDATE bill_invoices SET sent_at=datetime('now') WHERE id=?").run(id); }
      db.prepare('UPDATE bill_recurring SET next_date=? WHERE id=?').run(advanceDate(r.next_date, r.frequency), r.id);
      db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)')
        .run('system', 'system', 'create', 'invoice#' + id, 'recurring#' + r.id + (r.auto_send ? ' (auto-sent)' : ' (draft)'));
      made++;
    }
    return made;
  }
  app.post('/api/billing/recurring/run', requireNoc, (req, res) => {
    const made = runRecurringBilling();
    audit(req, 'edit', 'billing', `recurring run: ${made} invoice(s) generated`);
    res.json({ made });
  });
  app.post('/api/billing/stripe-test', requireNoc, async (req, res) => {
    try {
      const j = await stripeReq('GET', '/v1/balance');
      res.json({ ok: true, livemode: !!j.livemode, currency: (j.available && j.available[0] && j.available[0].currency) || 'usd' });
    } catch (e) { res.status(e.http || 502).json({ error: e.message }); }
  });
  // per-customer billing rollup (customer page card)
  app.get('/api/customers/:id/billing', requireNoc, (req, res) => {
    const invoices = db.prepare('SELECT id, number, date, due_date, status, total, balance FROM bill_invoices WHERE customer_id=? ORDER BY id DESC LIMIT 12').all(req.params.id);
    const outstanding = db.prepare("SELECT COALESCE(SUM(balance),0) v FROM bill_invoices WHERE customer_id=? AND status IN ('sent','partial')").get(req.params.id).v;
    res.json({ any: invoices.length > 0, outstanding, invoices });
  });
  // full billing backup / restore (all bill_* tables + numbering)
  app.get('/api/billing/backup', requireNoc, (req, res) => {
    const dump = {
      format: 'netinv-billing-backup', version: 2, exported_at: new Date().toISOString(),
      bill_prefix: getSetting('bill_prefix') || 'INV-', bill_next: getSetting('bill_next') || '1001',
      products: db.prepare('SELECT * FROM bill_products').all(),
      invoices: db.prepare('SELECT * FROM bill_invoices').all(),
      items: db.prepare('SELECT * FROM bill_items').all(),
      payments: db.prepare('SELECT * FROM bill_payments').all(),
      recurring: db.prepare('SELECT * FROM bill_recurring').all(),
      quotes: db.prepare('SELECT * FROM bill_quotes').all(),
      quote_items: db.prepare('SELECT * FROM bill_quote_items').all()
    };
    audit(req, 'billing_backup', 'billing', `${dump.invoices.length} invoices, ${dump.payments.length} payments`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="billing-backup-${todayStr()}.json"`);
    res.send(JSON.stringify(dump));
  });
  app.post('/api/billing/restore', requireNoc, (req, res) => {
    const b = req.body || {};
    if (b.format !== 'netinv-billing-backup' || b.version !== 2 || !Array.isArray(b.invoices)) return res.status(400).json({ error: 'Not a billing backup file' });
    db.exec('BEGIN');
    try {
      const tables = { bill_products: b.products, bill_invoices: b.invoices, bill_items: b.items, bill_payments: b.payments, bill_recurring: b.recurring, bill_quotes: b.quotes, bill_quote_items: b.quote_items };
      const counts = {};
      for (const [table, rows] of Object.entries(tables)) {
        db.exec(`DELETE FROM ${table}`);
        const list = Array.isArray(rows) ? rows : [];
        if (list.length) {
          const cols = Object.keys(list[0]);
          const ins = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
          for (const row of list) ins.run(...cols.map(c => row[c] === undefined ? null : row[c]));
        }
        counts[table.replace('bill_', '')] = list.length;
      }
      if (b.bill_prefix) setSetting('bill_prefix', String(b.bill_prefix));
      if (b.bill_next) setSetting('bill_next', String(b.bill_next));
      db.exec('COMMIT');
      audit(req, 'billing_restore', 'billing', Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '));
      res.json({ ok: true, counts });
    } catch (e) { db.exec('ROLLBACK'); res.status(500).json({ error: 'Restore failed: ' + e.message }); }
  });
  // ---- public pay page (tokenized link; no login) ----
  function payPage(inv, msg) {
    const company = esc2(getSetting('bill_company') || 'Network Inventory');
    const canPay = inv.balance > 0 && inv.status !== 'void' && !!getSetting('stripe_secret');
    const anyUntaxed = inv.tax > 0 && inv.items.some(it => it.taxable === 0);
    const rows = inv.items.map(it => `<tr><td>${esc2(it.description)}${anyUntaxed && it.taxable === 0 ? ' <span style="color:#9aa6b2;font-size:12px">· no tax</span>' : ''}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
    const statusTxt = inv.status === 'void' ? 'VOID' : inv.balance <= 0 ? 'PAID — thank you' : (inv.status === 'partial' ? `$${inv.balance.toFixed(2)} remaining` : `$${inv.balance.toFixed(2)} due${inv.due_date ? ' by ' + esc2(inv.due_date) : ''}`);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invoice ${esc2(inv.number)}</title>
  <style>:root{--bg:#0f1216;--card:#171c22;--line:#2a323c;--text:#e6eaf0;--muted:#9aa6b2;--accent:#378ADD;--ok:#1D9E75}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5}
  .wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
  h1{font-size:20px;margin:0 0 2px}.sub{color:var(--muted);font-size:14px;margin:0 0 18px}table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:7px 0;border-bottom:1px solid var(--line)}.tot td{border-bottom:0;padding-top:12px;font-weight:600}
  .status{display:inline-block;margin:14px 0;padding:6px 14px;border-radius:20px;font-weight:600;font-size:14px;background:#0e1318;border:1px solid var(--line)}
  .paid{color:var(--ok)}.due{color:#f0ad4e}.msg{margin:0 0 14px;padding:10px 14px;border-radius:9px;background:#0e1318;border:1px solid var(--line);font-size:14px}
  .pay{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
  .hint{color:var(--muted);font-size:12px;margin-top:8px;text-align:center}</style></head><body><div class="wrap"><div class="card">
  <h1>Invoice ${esc2(inv.number)}</h1><p class="sub">${company} · ${esc2(inv.date)}${inv.customer_name ? ' · ' + esc2(inv.customer_name) : ''}</p>
  ${msg ? `<div class="msg">${msg}</div>` : ''}
  <table>${rows}${inv.tax > 0 ? `<tr><td>Tax (${inv.tax_rate}%)</td><td></td><td align="right">$${inv.tax.toFixed(2)}</td></tr>` : ''}<tr class="tot"><td>Total</td><td></td><td align="right">$${inv.total.toFixed(2)}</td></tr></table>
  <div class="status ${inv.balance <= 0 ? 'paid' : 'due'}">${statusTxt}</div>
  ${inv.notes ? `<p class="sub">${esc2(inv.notes)}</p>` : ''}
  ${canPay ? `<button class="pay" onclick="pay(this)">Pay $${inv.balance.toFixed(2)} online</button><div class="hint">Card or US bank transfer (ACH) — processed securely by Stripe. This site never sees your card or bank details.</div>` : ''}
  ${inv.terms ? `<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--line)"><div style="color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px">TERMS &amp; BILLING AGREEMENT</div><div style="color:var(--muted);font-size:12px;white-space:pre-wrap">${esc2(inv.terms)}</div></div>` : ''}
  </div></div>
  <script>async function pay(btn){btn.disabled=true;btn.textContent='Redirecting to secure payment…';
  try{const r=await fetch(location.pathname+'/checkout',{method:'POST'});const j=await r.json();
  if(j.url)location.href=j.url;else{alert(j.error||'Could not start payment');btn.disabled=false;btn.textContent='Pay online';}}
  catch(e){alert('Could not start payment');btn.disabled=false;btn.textContent='Pay online';}}</script></body></html>`;
  }
  const invByToken = (token) => { const row = db.prepare('SELECT id FROM bill_invoices WHERE pay_token=?').get(String(token || '')); return row ? loadInvoice(row.id) : null; };
  app.get('/pay/:token', (req, res) => {
    const inv = invByToken(req.params.token);
    if (!inv) return res.status(404).type('text/plain').send('Invoice not found');
    let msg = null;
    if (req.query.result === 'success') msg = inv.balance <= 0 ? 'Payment received — thank you!' : 'Payment submitted. Bank (ACH) payments take a few business days to clear; this page will update once it does.';
    else if (req.query.result === 'cancel') msg = 'Payment was cancelled — you can try again below.';
    res.type('html').send(payPage(inv, msg));
  });
  app.post('/pay/:token/checkout', async (req, res) => {
    const inv = invByToken(req.params.token);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.balance <= 0 || inv.status === 'void') return res.status(409).json({ error: 'Nothing to pay on this invoice' });
    const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
    if (!pub) return res.status(400).json({ error: 'Online payment not configured' });
    try {
      const company = getSetting('bill_company') || 'Invoice';
      const session = await stripeReq('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        'payment_method_types[0]': 'card',
        'payment_method_types[1]': 'us_bank_account',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Invoice ${inv.number} — ${company}`,
        'line_items[0][price_data][unit_amount]': String(Math.round(inv.balance * 100)),
        'line_items[0][quantity]': '1',
        success_url: `${pub}/pay/${inv.pay_token}?result=success`,
        cancel_url: `${pub}/pay/${inv.pay_token}?result=cancel`,
        'metadata[invoice_id]': String(inv.id),
        ...(inv.email || inv.billing_email ? { customer_email: inv.email || inv.billing_email } : {})
      });
      res.json({ url: session.url });
    } catch (e) { res.status(e.http || 502).json({ error: e.message }); }
  });

  // ---- quotes (mirror invoices; convert to invoice) ----
  function nextQuoteNumber() {
    const prefix = getSetting('quote_prefix') || 'QUO-';
    const seq = parseInt(getSetting('quote_next'), 10) || 1001;
    setSetting('quote_next', String(seq + 1));
    return prefix + seq;
  }
  function insertQuote({ customer_id, email, date, expiry_date, tax_rate, notes, items, status, terms }) {
    const t = computeTotals(items, tax_rate);
    const info = db.prepare(`INSERT INTO bill_quotes (number,customer_id,email,date,expiry_date,status,tax_rate,subtotal,tax,total,notes,terms,view_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nextQuoteNumber(), customer_id, N(email), date || todayStr(), N(expiry_date), status || 'draft',
           Number(tax_rate || 0), t.subtotal, t.tax, t.total, N(notes), N(terms), randomBytes(18).toString('hex'));
    const ins = db.prepare('INSERT INTO bill_quote_items (quote_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
    for (const it of items) ins.run(info.lastInsertRowid, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
    return info.lastInsertRowid;
  }
  function loadQuote(id) {
    const q = db.prepare(`SELECT q.*, c.name AS customer_name, c.billing_email FROM bill_quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=?`).get(id);
    if (!q) return null;
    q.items = db.prepare('SELECT * FROM bill_quote_items WHERE quote_id=? ORDER BY id').all(id);
    const pub = (getSetting('public_base_url') || '').replace(/\/+$/, '');
    q.view_url = pub && q.view_token ? `${pub}/quote/${q.view_token}` : null;
    return q;
  }
  function emailQuote(q) {
    const to = q.email || q.billing_email; if (!to) return false;
    const company = getSetting('bill_company') || 'Network Inventory';
    const lines = q.items.map(it => ` - ${it.description}  x${it.quantity}  $${it.amount.toFixed(2)}`).join('\n');
    const rows = q.items.map(it => `<tr><td style="padding:4px 12px 4px 0">${esc2(it.description)}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
    const viewBtn = q.view_url ? `<p style="margin:18px 0"><a href="${q.view_url}" style="background:#378ADD;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none">View &amp; respond to quote</a></p>` : '';
    mailSafe({
      to, subject: `Quote ${q.number} from ${company} — $${q.total.toFixed(2)}`,
      text: `Quote ${q.number} from ${company}\nDate: ${q.date}${q.expiry_date ? '\nValid until: ' + q.expiry_date : ''}\n\n${lines}\n\nTotal: $${q.total.toFixed(2)}${q.view_url ? '\n\nView & respond: ' + q.view_url : ''}${q.notes ? '\n\n' + q.notes : ''}`,
      html: `<h2>Quote ${esc2(q.number)}</h2><p>${esc2(company)} · ${esc2(q.date)}${q.expiry_date ? ' · valid until <b>' + esc2(q.expiry_date) + '</b>' : ''}</p>
        <table style="border-collapse:collapse">${rows}<tr><td style="padding:8px 12px 0 0"><b>Total</b></td><td></td><td align="right"><b>$${q.total.toFixed(2)}</b></td></tr></table>${viewBtn}${q.notes ? `<p style="color:#555">${esc2(q.notes)}</p>` : ''}`
    });
    return true;
  }
  app.get('/api/billing/quotes', requireNoc, (req, res) => {
    const q = '%' + String(req.query.q || '').trim() + '%';
    const st = String(req.query.status || '');
    let sql = `SELECT q.id, q.number, q.date, q.expiry_date, q.status, q.total, q.converted_invoice_id, c.name AS customer_name
      FROM bill_quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE (q.number LIKE ? OR c.name LIKE ?)`;
    const params = [q, q];
    if (st) { sql += ' AND q.status=?'; params.push(st); }
    sql += ' ORDER BY q.id DESC LIMIT 300';
    res.json(db.prepare(sql).all(...params));
  });
  app.get('/api/billing/quotes/:id', requireNoc, (req, res) => {
    const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'not found' });
    res.json(q);
  });
  app.post('/api/billing/quotes', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.customer_id) return res.status(400).json({ error: 'Pick a customer' });
    const items = cleanItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
    const id = insertQuote({ customer_id: Number(b.customer_id), email: b.email, date: b.date, expiry_date: b.expiry_date, tax_rate: b.tax_rate, notes: b.notes, items, status: 'draft', terms: getSetting('invoice_terms') });
    let emailed = false;
    if (b.send) { emailed = emailQuote(loadQuote(id)); db.prepare("UPDATE bill_quotes SET status='sent', sent_at=datetime('now') WHERE id=?").run(id); }
    const num = db.prepare('SELECT number FROM bill_quotes WHERE id=?').get(id).number;
    audit(req, 'create', 'quote#' + id, num + (b.send ? ' (sent)' : ' (draft)'));
    res.json({ id, number: num, emailed });
  });
  app.put('/api/billing/quotes/:id', requireNoc, (req, res) => {
    const b = req.body || {};
    const q = db.prepare('SELECT * FROM bill_quotes WHERE id=?').get(req.params.id);
    if (!q) return res.status(404).json({ error: 'not found' });
    if (['converted', 'accepted'].includes(q.status)) return res.status(409).json({ error: 'This quote can no longer be edited' });
    const items = cleanItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'Add at least one line item' });
    const t = computeTotals(items, b.tax_rate === undefined ? q.tax_rate : b.tax_rate);
    db.prepare('UPDATE bill_quotes SET customer_id=?, email=?, date=?, expiry_date=?, tax_rate=?, subtotal=?, tax=?, total=?, notes=? WHERE id=?')
      .run(Number(b.customer_id || q.customer_id), N(b.email, q.email), b.date || q.date, N(b.expiry_date, q.expiry_date),
           Number(b.tax_rate === undefined ? q.tax_rate : b.tax_rate), t.subtotal, t.tax, t.total, N(b.notes, q.notes), q.id);
    db.prepare('DELETE FROM bill_quote_items WHERE quote_id=?').run(q.id);
    const ins = db.prepare('INSERT INTO bill_quote_items (quote_id,description,quantity,unit_price,amount,taxable) VALUES (?,?,?,?,?,?)');
    for (const it of items) ins.run(q.id, it.description, it.quantity, it.unit_price, r2(it.quantity * it.unit_price), it.taxable);
    audit(req, 'edit', 'quote#' + q.id, q.number);
    res.json({ ok: true });
  });
  app.post('/api/billing/quotes/:id/send', requireNoc, (req, res) => {
    const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'not found' });
    if (['converted'].includes(q.status)) return res.status(409).json({ error: 'Quote already converted' });
    const emailed = emailQuote(q);
    if (q.status === 'draft') db.prepare("UPDATE bill_quotes SET status='sent', sent_at=datetime('now') WHERE id=?").run(q.id);
    audit(req, 'edit', 'quote#' + q.id, q.number + (emailed ? ' emailed' : ' marked sent'));
    res.json({ ok: true, emailed });
  });
  app.post('/api/billing/quotes/:id/status', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!['accepted', 'declined', 'sent', 'expired'].includes(b.status)) return res.status(400).json({ error: 'bad status' });
    const q = db.prepare('SELECT * FROM bill_quotes WHERE id=?').get(req.params.id);
    if (!q) return res.status(404).json({ error: 'not found' });
    if (q.status === 'converted') return res.status(409).json({ error: 'Quote already converted' });
    db.prepare('UPDATE bill_quotes SET status=? WHERE id=?').run(b.status, q.id);
    audit(req, 'edit', 'quote#' + q.id, q.number + ' → ' + b.status);
    res.json({ ok: true });
  });
  app.post('/api/billing/quotes/:id/convert', requireNoc, (req, res) => {
    const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'not found' });
    if (q.status === 'converted') return res.status(409).json({ error: 'Quote already converted to invoice #' + q.converted_invoice_id });
    const items = q.items.map(it => ({ description: it.description, quantity: it.quantity, unit_price: it.unit_price, taxable: it.taxable }));
    if (!items.length) return res.status(400).json({ error: 'Quote has no line items' });
    const invId = insertInvoice({ customer_id: q.customer_id, email: q.email || q.billing_email, date: todayStr(), tax_rate: q.tax_rate, notes: q.notes, items, status: 'draft', terms: getSetting('invoice_terms') });
    db.prepare("UPDATE bill_quotes SET status='converted', converted_invoice_id=? WHERE id=?").run(invId, q.id);
    const num = db.prepare('SELECT number FROM bill_invoices WHERE id=?').get(invId).number;
    audit(req, 'edit', 'quote#' + q.id, q.number + ' → invoice ' + num);
    res.json({ ok: true, invoice_id: invId, invoice_number: num });
  });
  app.delete('/api/billing/quotes/:id', requireNoc, (req, res) => {
    const q = db.prepare('SELECT * FROM bill_quotes WHERE id=?').get(req.params.id);
    if (!q) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM bill_quote_items WHERE quote_id=?').run(q.id);
    db.prepare('DELETE FROM bill_quotes WHERE id=?').run(q.id);
    audit(req, 'delete', 'quote#' + q.id, q.number);
    res.json({ ok: true });
  });
  // public quote view (tokenized; no login) — accept/decline
  function quotePage(q, msg) {
    const company = esc2(getSetting('bill_company') || 'Network Inventory');
    const rows = q.items.map(it => `<tr><td>${esc2(it.description)}</td><td align="center">${it.quantity}</td><td align="right">$${it.amount.toFixed(2)}</td></tr>`).join('');
    const canRespond = ['draft', 'sent'].includes(q.status);
    const statusTxt = { accepted: 'Accepted — thank you', declined: 'Declined', converted: 'Accepted', expired: 'Expired' }[q.status] || (q.expiry_date ? 'Valid until ' + esc2(q.expiry_date) : 'Awaiting your response');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Quote ${esc2(q.number)}</title>
  <style>:root{--bg:#0f1216;--card:#171c22;--line:#2a323c;--text:#e6eaf0;--muted:#9aa6b2;--accent:#378ADD;--ok:#1D9E75;--danger:#dc3545}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5}
  .wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
  h1{font-size:20px;margin:0 0 2px}.sub{color:var(--muted);font-size:14px;margin:0 0 18px}table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:7px 0;border-bottom:1px solid var(--line)}.tot td{border-bottom:0;padding-top:12px;font-weight:600}
  .status{display:inline-block;margin:14px 0;padding:6px 14px;border-radius:20px;font-weight:600;font-size:14px;background:#0e1318;border:1px solid var(--line)}
  .msg{margin:0 0 14px;padding:10px 14px;border-radius:9px;background:#0e1318;border:1px solid var(--line);font-size:14px}
  .btns{display:flex;gap:10px;margin-top:18px}.b{flex:1;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
  .acc{background:var(--ok);color:#fff}.dec{background:#0e1318;color:var(--text);border:1px solid var(--line)}</style></head><body><div class="wrap"><div class="card">
  <h1>Quote ${esc2(q.number)}</h1><p class="sub">${company} · ${esc2(q.date)}${q.customer_name ? ' · ' + esc2(q.customer_name) : ''}</p>
  ${msg ? `<div class="msg">${msg}</div>` : ''}
  <table>${rows}${q.tax > 0 ? `<tr><td>Tax (${q.tax_rate}%)</td><td></td><td align="right">$${q.tax.toFixed(2)}</td></tr>` : ''}<tr class="tot"><td>Total</td><td></td><td align="right">$${q.total.toFixed(2)}</td></tr></table>
  <div class="status">${statusTxt}</div>
  ${q.notes ? `<p class="sub">${esc2(q.notes)}</p>` : ''}
  ${canRespond ? `<div class="btns"><button class="b acc" onclick="respond('accept',this)">Accept quote</button><button class="b dec" onclick="respond('decline',this)">Decline</button></div>` : ''}
  ${q.terms ? `<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--line)"><div style="color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px">TERMS &amp; BILLING AGREEMENT</div><div style="color:var(--muted);font-size:12px;white-space:pre-wrap">${esc2(q.terms)}</div></div>` : ''}
  </div></div>
  <script>async function respond(action,btn){btn.disabled=true;btn.parentElement.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const r=await fetch(location.pathname+'/respond',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const j=await r.json();
  if(j.ok)location.href=location.pathname+'?result='+action;else{alert(j.error||'Could not submit');btn.disabled=false;}}catch(e){alert('Could not submit');btn.disabled=false;}}</script></body></html>`;
  }
  const quoteByToken = (token) => { const row = db.prepare('SELECT id FROM bill_quotes WHERE view_token=?').get(String(token || '')); return row ? loadQuote(row.id) : null; };
  app.get('/quote/:token', (req, res) => {
    const q = quoteByToken(req.params.token);
    if (!q) return res.status(404).type('text/plain').send('Quote not found');
    let msg = null;
    if (req.query.result === 'accept') msg = 'Thank you — your acceptance has been recorded.';
    else if (req.query.result === 'decline') msg = 'You have declined this quote.';
    res.type('html').send(quotePage(q, msg));
  });
  app.post('/quote/:token/respond', express.json(), (req, res) => {
    const q = quoteByToken(req.params.token);
    if (!q) return res.status(404).json({ error: 'not found' });
    if (!['draft', 'sent'].includes(q.status)) return res.status(409).json({ error: 'This quote can no longer be responded to' });
    const action = (req.body || {}).action;
    const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : null;
    if (!status) return res.status(400).json({ error: 'bad action' });
    db.prepare('UPDATE bill_quotes SET status=? WHERE id=?').run(status, q.id);
    db.prepare('INSERT INTO audit_log (actor,role,action,target,details) VALUES (?,?,?,?,?)').run(q.email || 'customer', 'public', 'quote_' + status, 'quote#' + q.id, q.number);
    const notify = getSetting('access_notify_email') || getSetting('mail_from');
    if (notify) mailSafe({ to: notify, subject: `Quote ${q.number} ${status}`, text: `Quote ${q.number} for ${q.customer_name || ''} was ${status}.`, html: `<p>Quote <b>${esc2(q.number)}</b> for ${esc2(q.customer_name || '')} was <b>${status}</b>.</p>` });
    res.json({ ok: true, status });
  });


  // exposed for the sampler + cross-domain callers
  ctx.jobs.runRecurringBilling = runRecurringBilling;
  ctx.jobs.stripeWebhook = stripeWebhook;
}
