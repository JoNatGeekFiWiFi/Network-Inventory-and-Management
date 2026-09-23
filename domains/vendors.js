// Vendors and expenses.
//
// A vendor is anyone the company pays: the carriers (Cox, Zayo) that were already here, and the
// distributors, contractors, colos, utilities and software the business runs on. They live in the
// existing upstream_providers table — see the note in db.js — with `vendor_kind` telling them apart.
//
// An expense is one bill or purchase from a vendor. It can be a one-off, or generated from a
// recurring schedule; it can be unpaid with a due date, or paid; it can carry a receipt; and it can
// say which customer, site or POP the money went on, which is how it reaches Profit & Loss.
//
// Everything here is NOC/Admin only. This is the company's spending — who it pays, how much, and
// where — and field staff have no use for it.
//
// Nothing is deleted. A vendor is deactivated; an expense is voided; a schedule is paused. The one
// exception is a vendor CONTACT, which is an address-book entry rather than a business record.
import { existsSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import {
  toCents, fmtCents, monthlyCents, isDate, addDays, dueDates, nextOccurrence, attributeRecurring,
  EXPENSE_CATEGORIES, VENDOR_KINDS, FREQUENCIES, categoryOr, vendorKindOr, frequencyOr
} from '../lib/expenses.js';

// Receipts: photos and PDFs. Deliberately narrower than general attachments — a receipt is a
// picture of a piece of paper or a PDF bill, and nothing else needs to be accepted here.
const RECEIPT_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf' };
const RECEIPT_MAX = 15 * 1024 * 1024;
const EXPENSE_PARENTS = ['customer', 'site', 'pop'];
const today = () => new Date().toISOString().slice(0, 10);

export default function registerVendors(app, ctx) {
  const { db, N, audit, requireNoc, files } = ctx;
  const who = (req) => (req.user && req.user.email) || null;

  // ---- helpers -------------------------------------------------------------------------------------

  const vendorRow = (id) => db.prepare('SELECT * FROM upstream_providers WHERE id=?').get(Number(id));

  function parentLabel(type, id) {
    if (!type || !id) return null;
    const table = { customer: 'customers', site: 'sites', pop: 'pops' }[type];
    if (!table) return null;
    const r = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(Number(id));
    return r ? r.name : `${type} #${id} (missing)`;
  }

  /** A parent the caller named must exist. Silently storing a dangling link is how costs go missing. */
  function checkParent(type, id) {
    if (!type) return { type: null, id: null };
    if (!EXPENSE_PARENTS.includes(type)) return { error: 'An expense can be tied to a customer, site or POP' };
    const table = { customer: 'customers', site: 'sites', pop: 'pops' }[type];
    if (!id || !db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(Number(id))) return { error: `That ${type} does not exist` };
    return { type, id: Number(id) };
  }

  /** The public shape of an expense. Cents stay cents; the page formats them. */
  function shapeExpense(e) {
    const overdue = e.status === 'unpaid' && e.due_date && e.due_date < today();
    return {
      id: e.id, vendor_id: e.vendor_id, vendor_name: e.vendor_name,
      date: e.date, due_date: e.due_date, amount_cents: e.amount_cents,
      category: e.category, description: e.description, reference: e.reference,
      status: e.status, overdue: !!overdue,
      paid_at: e.paid_at, paid_method: e.paid_method, paid_reference: e.paid_reference,
      parent_type: e.parent_type, parent_id: e.parent_id, parent_label: parentLabel(e.parent_type, e.parent_id),
      has_receipt: !!e.receipt_stored, receipt_name: e.receipt_name, receipt_mime: e.receipt_mime,
      recurring_id: e.recurring_id, period: e.period,
      void_reason: e.void_reason, voided_at: e.voided_at, voided_by: e.voided_by,
      created_by: e.created_by, created_at: e.created_at
    };
  }

  /**
   * Save a receipt into the VENDOR's own folder, under receipts/.
   *
   * The vendor, not the customer or site the cost was charged to: the receipt is the vendor's
   * document, and "show me everything we hold from Ubiquiti" is the question it is filed to answer.
   * The data arrives base64 in JSON, the same way every other upload in the platform does.
   */
  function saveReceipt(vendor, receipt) {
    if (!receipt || !receipt.data) return null;
    const mime = String(receipt.mime || '');
    if (!RECEIPT_MIME[mime]) throw Object.assign(new Error('A receipt must be a photo (JPEG, PNG, WebP, HEIC) or a PDF'), { status: 400 });
    let raw = String(receipt.data);
    const comma = raw.indexOf(',');
    if (raw.startsWith('data:') && comma !== -1) raw = raw.slice(comma + 1);
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) throw Object.assign(new Error('The receipt file is empty'), { status: 400 });
    if (buf.length > RECEIPT_MAX) throw Object.assign(new Error('Receipt too large (max 15 MB)'), { status: 413 });
    const target = files.place('vendor', vendor.id, vendor.name, 'receipts', receipt.name || 'receipt', { ext: RECEIPT_MIME[mime] });
    writeFileSync(target.absolute, buf);
    return { stored: target.stored, name: String(receipt.name || 'receipt').slice(0, 120), mime, size: buf.length };
  }

  // ---- vendors ---------------------------------------------------------------------------------------

  app.get('/api/vendors/meta', requireNoc, (req, res) => {
    res.json({ kinds: VENDOR_KINDS, categories: EXPENSE_CATEGORIES, frequencies: FREQUENCIES });
  });

  app.get('/api/vendors', requireNoc, (req, res) => {
    const where = [];
    const args = [];
    const mode = String(req.query.archived || '').toLowerCase();
    if (mode === '1' || mode === 'only' || mode === 'true') where.push('p.archived_at IS NOT NULL');
    else if (mode !== 'all') where.push('p.archived_at IS NULL');
    if (req.query.kind) { where.push("COALESCE(p.vendor_kind,'carrier')=?"); args.push(String(req.query.kind)); }
    const yearStart = today().slice(0, 4) + '-01-01';
    const rows = db.prepare(`
      SELECT p.id, p.name, COALESCE(p.vendor_kind,'carrier') AS vendor_kind, p.email, p.phone, p.website,
             p.is_1099, p.w9_received_at, p.archived_at, p.archived_reason,
        (SELECT COUNT(*) FROM accounts a WHERE a.carrier_id=p.id AND a.archived_at IS NULL) AS account_count,
        (SELECT COALESCE(SUM(a.monthly_cost),0) FROM accounts a WHERE a.carrier_id=p.id AND a.archived_at IS NULL) AS account_monthly,
        (SELECT COUNT(*) FROM expenses e WHERE e.vendor_id=p.id AND e.status='unpaid') AS unpaid_count,
        (SELECT COALESCE(SUM(e.amount_cents),0) FROM expenses e WHERE e.vendor_id=p.id AND e.status='unpaid') AS unpaid_cents,
        (SELECT COALESCE(SUM(e.amount_cents),0) FROM expenses e WHERE e.vendor_id=p.id AND e.status<>'void' AND e.date>=?) AS ytd_cents,
        (SELECT COUNT(*) FROM vendor_contacts c WHERE c.vendor_id=p.id) AS contact_count
      FROM upstream_providers p
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (p.archived_at IS NOT NULL), p.name COLLATE NOCASE`).all(yearStart, ...args);
    // Recurring run-rate per vendor, computed in JS so the frequency maths lives in one place.
    const rec = db.prepare('SELECT vendor_id, amount_cents, frequency FROM expense_recurring WHERE active=1').all();
    const monthly = new Map();
    for (const r of rec) monthly.set(r.vendor_id, (monthly.get(r.vendor_id) || 0) + monthlyCents(r.amount_cents, r.frequency));
    for (const r of rows) r.recurring_monthly_cents = monthly.get(r.id) || 0;
    res.json(rows);
  });

  app.get('/api/vendors/:id', requireNoc, (req, res) => {
    const v = vendorRow(req.params.id);
    if (!v) return res.status(404).json({ error: 'not found' });
    v.vendor_kind = v.vendor_kind || 'carrier';
    v.contacts = db.prepare('SELECT * FROM vendor_contacts WHERE vendor_id=? ORDER BY name COLLATE NOCASE').all(v.id);
    // A carrier's accounts are already costed in P&L from the account itself. They are shown here so
    // the vendor page is complete, and so nobody enters the same Cox bill again as a recurring expense.
    v.accounts = db.prepare(`SELECT id, name, account_number, monthly_cost, status, archived_at FROM accounts
      WHERE carrier_id=? ORDER BY (archived_at IS NOT NULL), name`).all(v.id);
    v.account_monthly = v.accounts.filter(a => !a.archived_at).reduce((n, a) => n + (Number(a.monthly_cost) || 0), 0);
    v.recurring = db.prepare('SELECT * FROM expense_recurring WHERE vendor_id=? ORDER BY active DESC, next_date').all(v.id)
      .map(r => ({ ...r, monthly_cents: monthlyCents(r.amount_cents, r.frequency), parent_label: parentLabel(r.parent_type, r.parent_id) }));
    v.expenses = db.prepare(`SELECT e.*, ? AS vendor_name FROM expenses e WHERE e.vendor_id=?
      ORDER BY e.date DESC, e.id DESC LIMIT 300`).all(v.name, v.id).map(shapeExpense);
    const yearStart = today().slice(0, 4) + '-01-01';
    const yearAgo = addDays(today(), -365);
    const sum = (sql, ...a) => db.prepare(sql).get(...a).n || 0;
    v.totals = {
      unpaid_cents: sum("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE vendor_id=? AND status='unpaid'", v.id),
      overdue_cents: sum("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE vendor_id=? AND status='unpaid' AND due_date IS NOT NULL AND due_date<?", v.id, today()),
      ytd_cents: sum("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE vendor_id=? AND status<>'void' AND date>=?", v.id, yearStart),
      last12_cents: sum("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE vendor_id=? AND status<>'void' AND date>=?", v.id, yearAgo),
      recurring_monthly_cents: v.recurring.filter(r => r.active).reduce((n, r) => n + r.monthly_cents, 0)
    };
    v.attachments = ctx.attachmentsFor ? ctx.attachmentsFor('vendor', v.id) : [];
    v.w9 = v.w9_attachment_id ? v.attachments.find(a => a.id === v.w9_attachment_id) || null : null;
    v.message_count = db.prepare('SELECT COUNT(*) n FROM vendor_messages WHERE vendor_id=?').get(v.id).n;
    res.json(v);
  });

  /** Fields a vendor form may set. TIN is last-four only — see the note in db.js. */
  function vendorFields(b, ex = {}) {
    const pick = (k, max = 200) => (b[k] === undefined ? ex[k] ?? null : (N(String(b[k] ?? '').trim().slice(0, max)) || null));
    let tinLast4 = ex.tin_last4 ?? null;
    if (b.tin !== undefined || b.tin_last4 !== undefined) {
      const digits = String(b.tin ?? b.tin_last4 ?? '').replace(/\D/g, '');
      tinLast4 = digits ? digits.slice(-4) : null;
    }
    return {
      name: b.name === undefined ? ex.name : String(b.name || '').trim().slice(0, 120),
      vendor_kind: b.vendor_kind === undefined ? (ex.vendor_kind || 'other') : vendorKindOr(b.vendor_kind),
      email: pick('email'), phone: pick('phone', 40), website: pick('website'), address: pick('address', 300),
      our_account_number: pick('our_account_number', 80), payment_terms: pick('payment_terms', 80),
      notes: pick('notes', 4000),
      tax_classification: pick('tax_classification', 40),
      tin_type: b.tin_type === undefined ? (ex.tin_type ?? null) : (['ein', 'ssn'].includes(b.tin_type) ? b.tin_type : null),
      tin_last4: tinLast4,
      is_1099: b.is_1099 === undefined ? (ex.is_1099 || 0) : (b.is_1099 ? 1 : 0),
      w9_received_at: b.w9_received_at === undefined ? (ex.w9_received_at ?? null) : (isDate(b.w9_received_at) ? b.w9_received_at : null)
    };
  }

  app.post('/api/vendors', requireNoc, (req, res) => {
    const b = req.body || {};
    const f = vendorFields({ vendor_kind: 'other', ...b });
    if (!f.name) return res.status(400).json({ error: 'Vendor name required' });
    const dupe = db.prepare('SELECT id, name, archived_at FROM upstream_providers WHERE LOWER(name)=LOWER(?)').get(f.name);
    if (dupe) return res.status(409).json({ error: dupe.archived_at ? `"${dupe.name}" already exists but is deactivated — reactivate it instead` : `"${dupe.name}" already exists`, id: dupe.id });
    const info = db.prepare(`INSERT INTO upstream_providers (name, provider_type, vendor_kind, email, phone, website, address,
        our_account_number, payment_terms, notes, tax_classification, tin_type, tin_last4, is_1099, w9_received_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`).run(
      f.name, f.vendor_kind === 'carrier' ? 'Carrier' : null, f.vendor_kind, f.email, f.phone, f.website, f.address,
      f.our_account_number, f.payment_terms, f.notes, f.tax_classification, f.tin_type, f.tin_last4, f.is_1099, f.w9_received_at);
    audit(req, 'create', 'vendor#' + info.lastInsertRowid, `${f.name} (${f.vendor_kind})`);
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/vendors/:id', requireNoc, (req, res) => {
    const ex = vendorRow(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const f = vendorFields(req.body || {}, ex);
    if (!f.name) return res.status(400).json({ error: 'Vendor name required' });
    const dupe = db.prepare('SELECT id FROM upstream_providers WHERE LOWER(name)=LOWER(?) AND id<>?').get(f.name, ex.id);
    if (dupe) return res.status(409).json({ error: `"${f.name}" already exists` });
    // A carrier with accounts cannot quietly stop being a carrier: those accounts would vanish from
    // every carrier picker while still pointing at it.
    const wasCarrier = (ex.vendor_kind || 'carrier') === 'carrier';
    if (wasCarrier && f.vendor_kind !== 'carrier') {
      const n = db.prepare('SELECT COUNT(*) n FROM accounts WHERE carrier_id=?').get(ex.id).n
        + db.prepare('SELECT COUNT(*) n FROM devices WHERE carrier_id=?').get(ex.id).n;
      if (n) return res.status(409).json({ error: `${ex.name} has carrier accounts or hardware linked to it, so it has to stay a Carrier` });
    }
    db.prepare(`UPDATE upstream_providers SET name=?, vendor_kind=?, email=?, phone=?, website=?, address=?,
        our_account_number=?, payment_terms=?, notes=?, tax_classification=?, tin_type=?, tin_last4=?, is_1099=?, w9_received_at=?
      WHERE id=?`).run(f.name, f.vendor_kind, f.email, f.phone, f.website, f.address, f.our_account_number,
      f.payment_terms, f.notes, f.tax_classification, f.tin_type, f.tin_last4, f.is_1099, f.w9_received_at, ex.id);
    audit(req, 'edit', 'vendor#' + ex.id, f.name);
    res.json({ ok: true });
  });

  /**
   * Deactivate. Recurring schedules pause, exactly as a deactivated customer's billing does: a
   * vendor we have stopped using must not keep generating bills.
   */
  app.delete('/api/vendors/:id', requireNoc, (req, res) => {
    const ex = vendorRow(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    if (ex.archived_at) return res.status(409).json({ error: 'Already deactivated' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200) || null;
    db.prepare("UPDATE upstream_providers SET archived_at=datetime('now'), archived_by=?, archived_reason=? WHERE id=?").run(who(req), reason, ex.id);
    const paused = db.prepare('UPDATE expense_recurring SET active=0 WHERE vendor_id=? AND active=1').run(ex.id).changes;
    audit(req, 'archive', 'vendor#' + ex.id, `${ex.name}${reason ? ' — ' + reason : ''}${paused ? ` (${paused} recurring bill(s) paused)` : ''}`);
    res.json({ ok: true, archived: true, recurring_paused: paused });
  });

  app.post('/api/vendors/:id/restore', requireNoc, (req, res) => {
    const ex = vendorRow(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE upstream_providers SET archived_at=NULL, archived_by=NULL, archived_reason=NULL WHERE id=?').run(ex.id);
    audit(req, 'edit', 'vendor#' + ex.id, `restored from archive: ${ex.name}`);
    res.json({ ok: true, archived: false, note: 'Recurring bills stay paused — switch them back on from the vendor page if they should continue.' });
  });

  /** Mark one of the vendor's files as the W-9 on record. */
  app.post('/api/vendors/:id/w9', requireNoc, (req, res) => {
    const ex = vendorRow(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const attId = (req.body || {}).attachment_id == null ? null : Number(req.body.attachment_id);
    if (attId) {
      const a = db.prepare("SELECT id FROM note_attachments WHERE id=? AND parent_type='vendor' AND parent_id=?").get(attId, ex.id);
      if (!a) return res.status(400).json({ error: "That file isn't one of this vendor's files" });
    }
    db.prepare('UPDATE upstream_providers SET w9_attachment_id=?, w9_received_at=COALESCE(?, w9_received_at) WHERE id=?')
      .run(attId, attId ? today() : null, ex.id);
    if (!attId) db.prepare('UPDATE upstream_providers SET w9_received_at=NULL WHERE id=?').run(ex.id);
    audit(req, 'edit', 'vendor#' + ex.id, attId ? `W-9 on file: attachment #${attId}` : 'W-9 cleared');
    res.json({ ok: true });
  });

  // ---- contacts ---------------------------------------------------------------------------------------

  const contactFields = (b) => ({
    name: String(b.name || '').trim().slice(0, 120),
    role: N(String(b.role || '').trim().slice(0, 80)) || null,
    email: N(String(b.email || '').trim().toLowerCase().slice(0, 200)) || null,
    phone: N(String(b.phone || '').trim().slice(0, 40)) || null,
    notes: N(String(b.notes || '').trim().slice(0, 1000)) || null
  });
  app.post('/api/vendors/:id/contacts', requireNoc, (req, res) => {
    const v = vendorRow(req.params.id);
    if (!v) return res.status(404).json({ error: 'not found' });
    const f = contactFields(req.body || {});
    if (!f.name) return res.status(400).json({ error: 'Contact name required' });
    const info = db.prepare('INSERT INTO vendor_contacts (vendor_id,name,role,email,phone,notes) VALUES (?,?,?,?,?,?)')
      .run(v.id, f.name, f.role, f.email, f.phone, f.notes);
    audit(req, 'create', 'vendor#' + v.id, `contact: ${f.name}`);
    res.json({ id: info.lastInsertRowid });
  });
  app.put('/api/vendor-contacts/:id', requireNoc, (req, res) => {
    const c = db.prepare('SELECT * FROM vendor_contacts WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const f = contactFields({ ...c, ...(req.body || {}) });
    if (!f.name) return res.status(400).json({ error: 'Contact name required' });
    db.prepare('UPDATE vendor_contacts SET name=?, role=?, email=?, phone=?, notes=? WHERE id=?').run(f.name, f.role, f.email, f.phone, f.notes, c.id);
    audit(req, 'edit', 'vendor#' + c.vendor_id, `contact: ${f.name}`);
    res.json({ ok: true });
  });
  app.delete('/api/vendor-contacts/:id', requireNoc, (req, res) => {
    const c = db.prepare('SELECT * FROM vendor_contacts WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM vendor_contacts WHERE id=?').run(c.id);
    audit(req, 'delete', 'vendor#' + c.vendor_id, `contact: ${c.name}`);
    res.json({ ok: true });
  });

  // ---- expenses ---------------------------------------------------------------------------------------

  app.get('/api/expenses', requireNoc, (req, res) => {
    const where = [];
    const args = [];
    const q = req.query;
    if (q.vendor_id) { where.push('e.vendor_id=?'); args.push(Number(q.vendor_id)); }
    if (q.status === 'overdue') { where.push("e.status='unpaid' AND e.due_date IS NOT NULL AND e.due_date<?"); args.push(today()); }
    else if (['unpaid', 'paid', 'void'].includes(q.status)) { where.push('e.status=?'); args.push(q.status); }
    else if (q.status !== 'all') where.push("e.status<>'void'");
    if (isDate(q.from)) { where.push('e.date>=?'); args.push(q.from); }
    if (isDate(q.to)) { where.push('e.date<=?'); args.push(q.to); }
    if (q.category) { where.push('e.category=?'); args.push(categoryOr(q.category)); }
    if (EXPENSE_PARENTS.includes(q.parent_type) && q.parent_id) { where.push('e.parent_type=? AND e.parent_id=?'); args.push(q.parent_type, Number(q.parent_id)); }
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 500, 1), 2000);
    const rows = db.prepare(`SELECT e.*, p.name AS vendor_name FROM expenses e LEFT JOIN upstream_providers p ON p.id=e.vendor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date DESC, e.id DESC LIMIT ${limit}`).all(...args);
    res.json(rows.map(shapeExpense));
  });

  /**
   * The numbers the Expenses page opens with: what we owe, what is late, what we have spent.
   * Void expenses are excluded from every figure.
   */
  app.get('/api/expenses/summary', requireNoc, (req, res) => {
    const t = today();
    const one = (sql, ...a) => db.prepare(sql).get(...a).n || 0;
    const monthStart = t.slice(0, 8) + '01';
    const yearStart = t.slice(0, 4) + '-01-01';
    const from12 = (() => { const d = new Date(monthStart + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 11); return d.toISOString().slice(0, 10); })();
    const byMonth = db.prepare(`SELECT substr(date,1,7) AS month, SUM(amount_cents) AS cents FROM expenses
      WHERE status<>'void' AND date>=? GROUP BY month ORDER BY month`).all(from12);
    const byCategory = db.prepare(`SELECT category, SUM(amount_cents) AS cents FROM expenses
      WHERE status<>'void' AND date>=? GROUP BY category ORDER BY cents DESC`).all(from12);
    const recurring = db.prepare('SELECT amount_cents, frequency FROM expense_recurring WHERE active=1').all();
    res.json({
      unpaid_cents: one("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE status='unpaid'"),
      unpaid_count: one("SELECT COUNT(*) n FROM expenses WHERE status='unpaid'"),
      overdue_cents: one("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE status='unpaid' AND due_date IS NOT NULL AND due_date<?", t),
      overdue_count: one("SELECT COUNT(*) n FROM expenses WHERE status='unpaid' AND due_date IS NOT NULL AND due_date<?", t),
      due_7d_cents: one("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE status='unpaid' AND due_date>=? AND due_date<=?", t, addDays(t, 7)),
      month_cents: one("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE status<>'void' AND date>=?", monthStart),
      ytd_cents: one("SELECT COALESCE(SUM(amount_cents),0) n FROM expenses WHERE status<>'void' AND date>=?", yearStart),
      recurring_monthly_cents: recurring.reduce((n, r) => n + monthlyCents(r.amount_cents, r.frequency), 0),
      by_month: byMonth, by_category: byCategory
    });
  });

  app.get('/api/expenses/:id', requireNoc, (req, res) => {
    const e = db.prepare('SELECT e.*, p.name AS vendor_name FROM expenses e LEFT JOIN upstream_providers p ON p.id=e.vendor_id WHERE e.id=?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    res.json(shapeExpense(e));
  });

  /** Validate the editable fields of an expense. Returns { f } or { error }. */
  function expenseFields(b, ex = null) {
    const vendorId = Number(b.vendor_id ?? (ex && ex.vendor_id));
    const v = vendorId ? vendorRow(vendorId) : null;
    if (!v) return { error: 'Pick a vendor' };
    const amount = b.amount !== undefined ? toCents(b.amount) : (b.amount_cents !== undefined ? Number(b.amount_cents) : ex && ex.amount_cents);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'Enter an amount greater than zero' };
    const date = b.date !== undefined ? b.date : ex && ex.date;
    if (!isDate(date)) return { error: 'Enter the date of the bill or purchase' };
    const due = b.due_date !== undefined ? (b.due_date || null) : (ex ? ex.due_date : null);
    if (due && !isDate(due)) return { error: 'The due date is not a valid date' };
    if (due && due < date) return { error: 'The due date is before the bill date' };
    const p = b.parent_type !== undefined ? checkParent(b.parent_type || null, b.parent_id) : { type: ex ? ex.parent_type : null, id: ex ? ex.parent_id : null };
    if (p.error) return { error: p.error };
    return {
      v,
      f: {
        vendor_id: v.id, date, due_date: due, amount_cents: amount,
        category: b.category !== undefined ? categoryOr(b.category) : (ex ? ex.category : 'other'),
        description: b.description !== undefined ? (N(String(b.description || '').trim().slice(0, 500)) || null) : (ex ? ex.description : null),
        reference: b.reference !== undefined ? (N(String(b.reference || '').trim().slice(0, 80)) || null) : (ex ? ex.reference : null),
        parent_type: p.type, parent_id: p.id
      }
    };
  }

  app.post('/api/expenses', requireNoc, (req, res) => {
    const b = req.body || {};
    const { f, v, error } = expenseFields(b);
    if (error) return res.status(400).json({ error });
    let receipt = null;
    try { receipt = saveReceipt(v, b.receipt); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    const paid = !!b.paid;
    const paidAt = paid ? (isDate(b.paid_at) ? b.paid_at : f.date) : null;
    const info = db.prepare(`INSERT INTO expenses (vendor_id,date,due_date,amount_cents,category,description,reference,status,
        paid_at,paid_method,paid_reference,parent_type,parent_id,receipt_stored,receipt_name,receipt_mime,receipt_size,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.vendor_id, f.date, f.due_date, f.amount_cents, f.category, f.description, f.reference, paid ? 'paid' : 'unpaid',
      paidAt, paid ? (N(b.paid_method) || null) : null, paid ? (N(b.paid_reference) || null) : null,
      f.parent_type, f.parent_id,
      receipt && receipt.stored, receipt && receipt.name, receipt && receipt.mime, receipt && receipt.size, who(req));
    audit(req, 'create', 'expense#' + info.lastInsertRowid, `${v.name} ${fmtCents(f.amount_cents)}${paid ? ' (paid)' : ''}`);
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/expenses/:id', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    // A voided expense is part of the record exactly as it was voided. Changing it afterwards would
    // make the void reason describe a bill that no longer looks like that.
    if (ex.status === 'void') return res.status(409).json({ error: 'This expense is void — it stays as it was. Enter a new one instead.' });
    const { f, error } = expenseFields(req.body || {}, ex);
    if (error) return res.status(400).json({ error });
    db.prepare(`UPDATE expenses SET vendor_id=?, date=?, due_date=?, amount_cents=?, category=?, description=?, reference=?,
        parent_type=?, parent_id=? WHERE id=?`).run(f.vendor_id, f.date, f.due_date, f.amount_cents, f.category, f.description,
      f.reference, f.parent_type, f.parent_id, ex.id);
    const changed = ex.amount_cents !== f.amount_cents ? ` amount ${fmtCents(ex.amount_cents)} → ${fmtCents(f.amount_cents)}` : '';
    audit(req, 'edit', 'expense#' + ex.id, `edited${changed}`);
    res.json({ ok: true });
  });

  app.post('/api/expenses/:id/pay', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    if (ex.status === 'void') return res.status(409).json({ error: 'A void expense cannot be paid' });
    if (ex.status === 'paid') return res.status(409).json({ error: 'Already marked paid' });
    const b = req.body || {};
    const paidAt = isDate(b.paid_at) ? b.paid_at : today();
    db.prepare("UPDATE expenses SET status='paid', paid_at=?, paid_method=?, paid_reference=? WHERE id=?")
      .run(paidAt, N(String(b.method || '').slice(0, 40)) || null, N(String(b.reference || '').slice(0, 80)) || null, ex.id);
    audit(req, 'edit', 'expense#' + ex.id, `paid ${fmtCents(ex.amount_cents)} on ${paidAt}${b.method ? ' by ' + b.method : ''}`);
    res.json({ ok: true });
  });

  app.post('/api/expenses/:id/unpay', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    if (ex.status !== 'paid') return res.status(409).json({ error: 'Only a paid expense can be marked unpaid' });
    db.prepare("UPDATE expenses SET status='unpaid', paid_at=NULL, paid_method=NULL, paid_reference=NULL WHERE id=?").run(ex.id);
    audit(req, 'edit', 'expense#' + ex.id, `marked unpaid (was paid ${ex.paid_at || ''})`);
    res.json({ ok: true });
  });

  /** Void: the expense stays, marked, and drops out of every total. A reason is required. */
  app.post('/api/expenses/:id/void', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    if (ex.status === 'void') return res.status(409).json({ error: 'Already void' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
    // Required here, unlike deactivating a customer: a void changes the books, and "why did this
    // $1,400 bill disappear from March?" is the question an accountant will ask.
    if (!reason) return res.status(400).json({ error: 'Say why it is being voided — entered twice, wrong vendor, refunded…' });
    db.prepare("UPDATE expenses SET status='void', void_reason=?, voided_at=datetime('now'), voided_by=? WHERE id=?").run(reason, who(req), ex.id);
    audit(req, 'void', 'expense#' + ex.id, `${fmtCents(ex.amount_cents)} — ${reason}`);
    res.json({ ok: true });
  });

  app.post('/api/expenses/:id/receipt', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const v = vendorRow(ex.vendor_id);
    let r;
    try { r = saveReceipt(v, req.body || {}); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    if (!r) return res.status(400).json({ error: 'No file received' });
    // The previous receipt, if any, is left on disk. Replacing a receipt is not a reason to destroy
    // the one it replaced; the audit line records both names.
    db.prepare('UPDATE expenses SET receipt_stored=?, receipt_name=?, receipt_mime=?, receipt_size=? WHERE id=?').run(r.stored, r.name, r.mime, r.size, ex.id);
    audit(req, 'attach', 'expense#' + ex.id, ex.receipt_name ? `receipt replaced: ${ex.receipt_name} → ${r.name}` : `receipt: ${r.name}`);
    res.json({ ok: true });
  });

  app.get('/api/expenses/:id/receipt', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex || !ex.receipt_stored) return res.status(404).json({ error: 'No receipt on this expense' });
    let fp;
    try { fp = files.resolveStored(ex.receipt_stored); } catch { return res.status(404).json({ error: 'Receipt missing' }); }
    if (!existsSync(fp)) return res.status(404).json({ error: 'Receipt missing' });
    // Only the types accepted on upload are served inline. nosniff stops the browser reinterpreting
    // the bytes as anything else, whatever the stored name says.
    const mime = RECEIPT_MIME[ex.receipt_mime] ? ex.receipt_mime : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', statSync(fp).size);
    res.setHeader('Content-Disposition', `${mime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${String(ex.receipt_name || 'receipt').replace(/[^\w.\- ]+/g, '_')}"`);
    createReadStream(fp).pipe(res);
  });

  // ---- recurring bills ----------------------------------------------------------------------------------

  function recurringFields(b, ex = null) {
    const vendorId = Number(b.vendor_id ?? (ex && ex.vendor_id));
    const v = vendorId ? vendorRow(vendorId) : null;
    if (!v) return { error: 'Pick a vendor' };
    const amount = b.amount !== undefined ? toCents(b.amount) : (ex && ex.amount_cents);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { error: 'Enter an amount greater than zero' };
    const next = b.next_date !== undefined ? b.next_date : ex && ex.next_date;
    if (!isDate(next)) return { error: 'Set the date of the next bill' };
    const freq = b.frequency !== undefined ? frequencyOr(b.frequency) : (ex ? ex.frequency : 'monthly');
    const p = b.parent_type !== undefined ? checkParent(b.parent_type || null, b.parent_id) : { type: ex ? ex.parent_type : null, id: ex ? ex.parent_id : null };
    if (p.error) return { error: p.error };
    const dueDays = b.due_days !== undefined ? Math.max(0, Math.min(120, parseInt(b.due_days, 10) || 0)) : (ex ? ex.due_days : 0);
    return {
      v,
      f: {
        vendor_id: v.id, amount_cents: amount, frequency: freq, next_date: next,
        // The anchor follows the next date whenever the date is set, so moving a schedule from the
        // 1st to the 15th moves every future bill with it.
        anchor_day: b.next_date !== undefined || !ex ? Number(next.slice(8, 10)) : ex.anchor_day,
        due_days: dueDays,
        autopay: b.autopay !== undefined ? (b.autopay ? 1 : 0) : (ex ? ex.autopay : 0),
        category: b.category !== undefined ? categoryOr(b.category) : (ex ? ex.category : 'other'),
        description: b.description !== undefined ? (N(String(b.description || '').trim().slice(0, 300)) || null) : (ex ? ex.description : null),
        parent_type: p.type, parent_id: p.id,
        active: b.active !== undefined ? (b.active ? 1 : 0) : (ex ? ex.active : 1)
      }
    };
  }

  app.get('/api/expense-recurring', requireNoc, (req, res) => {
    const rows = db.prepare(`SELECT r.*, p.name AS vendor_name FROM expense_recurring r LEFT JOIN upstream_providers p ON p.id=r.vendor_id
      ${req.query.vendor_id ? 'WHERE r.vendor_id=?' : ''} ORDER BY r.active DESC, r.next_date`).all(...(req.query.vendor_id ? [Number(req.query.vendor_id)] : []));
    res.json(rows.map(r => ({ ...r, monthly_cents: monthlyCents(r.amount_cents, r.frequency), parent_label: parentLabel(r.parent_type, r.parent_id) })));
  });

  app.post('/api/expense-recurring', requireNoc, (req, res) => {
    const { f, v, error } = recurringFields(req.body || {});
    if (error) return res.status(400).json({ error });
    const info = db.prepare(`INSERT INTO expense_recurring (vendor_id,description,category,amount_cents,frequency,anchor_day,next_date,
        due_days,autopay,parent_type,parent_id,active,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.vendor_id, f.description, f.category, f.amount_cents, f.frequency, f.anchor_day, f.next_date,
      f.due_days, f.autopay, f.parent_type, f.parent_id, f.active, who(req));
    audit(req, 'create', 'expense-recurring#' + info.lastInsertRowid, `${v.name} ${fmtCents(f.amount_cents)} ${f.frequency}`);
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/expense-recurring/:id', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM expense_recurring WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const { f, v, error } = recurringFields(req.body || {}, ex);
    if (error) return res.status(400).json({ error });
    if (f.active && v.archived_at) return res.status(409).json({ error: `${v.name} is deactivated — reactivate the vendor before resuming its bills` });
    db.prepare(`UPDATE expense_recurring SET vendor_id=?, description=?, category=?, amount_cents=?, frequency=?, anchor_day=?,
        next_date=?, due_days=?, autopay=?, parent_type=?, parent_id=?, active=? WHERE id=?`).run(
      f.vendor_id, f.description, f.category, f.amount_cents, f.frequency, f.anchor_day, f.next_date,
      f.due_days, f.autopay, f.parent_type, f.parent_id, f.active, ex.id);
    audit(req, 'edit', 'expense-recurring#' + ex.id, ex.active !== f.active ? (f.active ? 'resumed' : 'paused') : 'edited');
    res.json({ ok: true });
  });

  /**
   * Turn every schedule that has come due into real expenses.
   *
   * Idempotent by construction: each generated expense carries (recurring_id, period) and a unique
   * index refuses a second one, so a restart mid-run, two runs at once or a clock change cannot bill
   * the same month twice. `INSERT OR IGNORE` plus the index is the guarantee; the next_date bookkeeping
   * is only an optimisation on top of it.
   *
   * A schedule far in the past catches up at most 24 bills per run and says so, rather than silently
   * filling a year of history in one tick.
   */
  function runRecurringExpenses(asOf = today()) {
    const due = db.prepare(`SELECT r.*, p.name AS vendor_name, p.archived_at AS vendor_archived FROM expense_recurring r
      JOIN upstream_providers p ON p.id=r.vendor_id WHERE r.active=1 AND r.next_date<=?`).all(asOf);
    const ins = db.prepare(`INSERT OR IGNORE INTO expenses (vendor_id,date,due_date,amount_cents,category,description,status,paid_at,paid_method,
        parent_type,parent_id,recurring_id,period,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'schedule')`);
    let created = 0;
    const truncated = [];
    for (const r of due) {
      if (r.vendor_archived) continue;       // a deactivated vendor bills nothing, even if its schedule was switched back on
      const { dates, next, truncated: more } = dueDates(r.next_date, r.frequency, r.anchor_day, asOf);
      db.exec('BEGIN');
      try {
        for (const d of dates) {
          const info = ins.run(r.vendor_id, d, r.due_days ? addDays(d, r.due_days) : (r.autopay ? null : d), r.amount_cents,
            r.category, r.description, r.autopay ? 'paid' : 'unpaid', r.autopay ? d : null, r.autopay ? 'autopay' : null,
            r.parent_type, r.parent_id, r.id, d);
          created += info.changes;
        }
        db.prepare('UPDATE expense_recurring SET next_date=? WHERE id=?').run(next, r.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); console.warn('recurring expense', r.id, e.message); }
      if (more) truncated.push({ id: r.id, vendor: r.vendor_name, next });
    }
    return { created, schedules: due.length, truncated };
  }
  ctx.jobs.runRecurringExpenses = runRecurringExpenses;

  app.post('/api/expense-recurring/run', requireNoc, (req, res) => {
    const r = runRecurringExpenses();
    if (r.created) audit(req, 'create', 'expenses', `generated ${r.created} recurring bill(s)`);
    res.json(r);
  });

  // ---- Profit & Loss hook -------------------------------------------------------------------------------
  //
  // billing.js owns the P&L; this supplies the expense side of it. Only ACTIVE recurring schedules
  // count, because P&L here is a monthly run-rate — a one-off router purchase is real spending, and
  // it is on the Expenses page, but it is not part of what an account costs each month.
  ctx.recurringExpenseAttribution = function recurringExpenseAttribution() {
    const schedules = db.prepare(`SELECT r.amount_cents, r.frequency, r.parent_type, r.parent_id, r.category
      FROM expense_recurring r JOIN upstream_providers p ON p.id=r.vendor_id
      WHERE r.active=1 AND p.archived_at IS NULL`).all();
    const siteQ = db.prepare('SELECT account_id FROM sites WHERE id=?');
    const custQ = db.prepare('SELECT account_id FROM account_customers WHERE customer_id=? ORDER BY account_id');
    return attributeRecurring(schedules,
      (id) => (siteQ.get(Number(id)) || {}).account_id || null,
      (id) => custQ.all(Number(id)).map(r => r.account_id));
  };

  // ---- vendor mail ----------------------------------------------------------------------------------------

  /** Which vendor an address belongs to: the vendor's own email, or one of its contacts. */
  function vendorForAddress(addr) {
    const a = String(addr || '').trim().toLowerCase();
    if (!a) return null;
    const direct = db.prepare('SELECT id FROM upstream_providers WHERE lower(email)=?').get(a);
    if (direct) return direct.id;
    const viaContact = db.prepare('SELECT vendor_id FROM vendor_contacts WHERE lower(email)=? ORDER BY id LIMIT 1').get(a);
    return viaContact ? viaContact.vendor_id : null;
  }
  ctx.vendorForAddress = vendorForAddress;

  /** File one inbound message on a vendor's page. De-duplicated on Message-ID. */
  ctx.fileVendorMail = function fileVendorMail({ vendor_id, from, to, subject, body, external_id }) {
    const r = db.prepare(`INSERT OR IGNORE INTO vendor_messages (vendor_id,direction,from_addr,to_addr,subject,body,external_id)
      VALUES (?, 'in', ?,?,?,?,?)`).run(vendor_id, from || null, to || null, subject || null, String(body || '').slice(0, 100000), external_id || null);
    return r.changes > 0;
  };

  app.get('/api/vendors/:id/messages', requireNoc, (req, res) => {
    const v = vendorRow(req.params.id);
    if (!v) return res.status(404).json({ error: 'not found' });
    res.json(db.prepare('SELECT * FROM vendor_messages WHERE vendor_id=? ORDER BY id DESC LIMIT 200').all(v.id));
  });

  app.post('/api/vendors/:id/messages', requireNoc, async (req, res) => {
    const v = vendorRow(req.params.id);
    if (!v) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const to = String(b.to || v.email || '').trim();
    const subject = String(b.subject || '').trim().slice(0, 200);
    const body = String(b.body || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Pick an email address to send to' });
    if (!subject || !body) return res.status(400).json({ error: 'A subject and a message are both required' });
    if (!ctx.sendMailBest) return res.status(503).json({ error: 'Email is not set up yet (Settings → Email)' });
    // The vendor mailbox if there is one — a quote request should come from the address the vendor
    // replies to, not from support@, or the reply lands in the customer queue.
    const sent = await ctx.sendMailBest({ to, subject, text: body, purpose: 'vendor', from: b.from || undefined });
    if (!sent.ok) return res.status(502).json({ error: sent.error || 'The message could not be sent' });
    db.prepare(`INSERT INTO vendor_messages (vendor_id,direction,from_addr,to_addr,subject,body,author,delivery)
      VALUES (?, 'out', ?,?,?,?,?,?)`).run(v.id, sent.from || null, to, subject, body, who(req), sent.via || null);
    audit(req, 'message', 'vendor#' + v.id, `email to ${to}: ${subject}`);
    res.json({ ok: true, via: sent.via, from: sent.from || null });
  });
}
