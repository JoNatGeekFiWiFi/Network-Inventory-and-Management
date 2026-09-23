// Vendors and expenses, end to end through the API.
//
// What this guards, in order of how much it would cost to get wrong:
//   * money: totals in cents, voids out of every figure, P&L that adds up and counts nothing twice;
//   * recurring bills: generated once per period no matter how often the job runs;
//   * access: none of this is visible to field or support staff, and receipts are not public;
//   * the carrier merge: carriers are vendors, and the carrier pickers still offer only carriers.
const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const h = {};
  if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  const t = buf.toString('utf8'); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t, buf, headers: r.headers };
}
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const stamp = Date.now();
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

// ---- a vendor ----
let ven;
{
  const r = await call('/api/vendors', { body: { name: 'VEND-TEST Ubiquiti Dist ' + stamp, vendor_kind: 'distributor', email: `ap${stamp}@dist.example`, tin: '12-3456789', tin_type: 'ein', is_1099: false } });
  ok(r.status === 200 && r.json.id, 'a vendor can be created');
  ven = (await call('/api/vendors/' + r.json.id)).json;
  ok(ven.vendor_kind === 'distributor', 'with its type');
  ok(ven.tin_last4 === '6789', 'only the last four digits of the tax ID are kept');
  ok(!JSON.stringify(ven).includes('3456789'), 'and the full TIN appears nowhere in what the API returns');
  ok((await call('/api/vendors', { body: { name: ven.name.toLowerCase() } })).status === 409, 'a duplicate name (any case) is refused');
  ok((await call('/api/vendors', { body: { name: '  ' } })).status === 400, 'a blank name is refused');
}

// ---- carriers are vendors, and carrier pickers still only offer carriers ----
{
  const all = (await call('/api/vendors')).json;
  ok(all.some(v => v.name === 'Cox' && v.vendor_kind === 'carrier'), 'existing carriers appear in the vendor list as carriers');
  const carriers = (await call('/api/carriers')).json;
  ok(!carriers.some(c => c.id === ven.id), 'a distributor is NOT offered where a carrier is expected');
  const meta = (await call('/api/meta')).json;
  ok(!meta.providers.some(p => p.id === ven.id), 'nor in the provider picker');
  ok((await call('/api/vendors?kind=carrier')).json.every(v => v.vendor_kind === 'carrier'), 'the list can be filtered to carriers');
}

// ---- contacts ----
{
  const c = await call('/api/vendors/' + ven.id + '/contacts', { body: { name: 'Pat Rep', role: 'Sales rep', email: `PAT${stamp}@DIST.example` } });
  ok(c.status === 200, 'a contact can be added');
  const v = (await call('/api/vendors/' + ven.id)).json;
  ok(v.contacts.length === 1 && v.contacts[0].email === `pat${stamp}@dist.example`, 'emails are stored lower-case so mail can be matched to them');
  ok((await call('/api/vendors/' + ven.id + '/contacts', { body: { role: 'x' } })).status === 400, 'a contact needs a name');
}

// ---- one-off expenses ----
let e1, e2;
{
  const r = await call('/api/expenses', { body: { vendor_id: ven.id, date: daysAgo(10), due_date: daysAgo(3), amount: '$1,234.56', category: 'hardware', description: 'VEND-TEST radios', reference: 'INV-1' } });
  ok(r.status === 200, 'an unpaid bill can be entered');
  e1 = (await call('/api/expenses/' + r.json.id)).json;
  ok(e1.amount_cents === 123456, 'the amount is stored exactly, in cents');
  ok(e1.status === 'unpaid' && e1.overdue === true, 'a bill past its due date is flagged overdue');

  const r2 = await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: '19.99', category: 'office', paid: true } });
  e2 = (await call('/api/expenses/' + r2.json.id)).json;
  ok(e2.status === 'paid' && e2.paid_at === today, 'a purchase can be entered as already paid, dated the day it was made');

  ok((await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: '0' } })).status === 400, 'a zero amount is refused');
  ok((await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: '-5' } })).status === 400, 'a negative amount is refused');
  ok((await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: 'lots' } })).status === 400, 'nonsense is refused rather than stored as zero');
  ok((await call('/api/expenses', { body: { vendor_id: ven.id, date: today, due_date: daysAgo(5), amount: '5' } })).status === 400, 'a due date before the bill date is refused');
  ok((await call('/api/expenses', { body: { vendor_id: 99999999, date: today, amount: '5' } })).status === 400, 'an unknown vendor is refused');
  ok((await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: '5', parent_type: 'site', parent_id: 99999999 } })).status === 400,
    'a charge to a site that does not exist is refused, not stored as a dangling link');
}

// ---- totals ----
{
  const v = (await call('/api/vendors/' + ven.id)).json;
  ok(v.totals.unpaid_cents === 123456, 'unpaid total');
  ok(v.totals.overdue_cents === 123456, 'overdue total');
  ok(v.totals.last12_cents === 123456 + 1999, 'spend over the last 12 months counts paid and unpaid');
  const s = (await call('/api/expenses/summary')).json;
  ok(s.unpaid_cents >= 123456 && s.overdue_count >= 1, 'the company summary includes them');
}

// ---- pay, unpay, void ----
{
  ok((await call('/api/expenses/' + e1.id + '/pay', { body: { method: 'check', reference: '1042', paid_at: today } })).status === 200, 'a bill can be marked paid');
  let e = (await call('/api/expenses/' + e1.id)).json;
  ok(e.status === 'paid' && e.paid_method === 'check' && e.paid_reference === '1042', 'with how and a reference');
  ok((await call('/api/expenses/' + e1.id + '/pay', { body: {} })).status === 409, 'paying twice is refused');
  ok((await call('/api/expenses/' + e1.id + '/unpay', { body: {} })).status === 200, 'and it can be put back to unpaid if that was a mistake');

  ok((await call('/api/expenses/' + e2.id + '/void', { body: {} })).status === 400, 'voiding requires a reason');
  ok((await call('/api/expenses/' + e2.id + '/void', { body: { reason: 'Entered twice' } })).status === 200, 'with one, it voids');
  e = (await call('/api/expenses/' + e2.id)).json;
  ok(e.status === 'void' && e.void_reason === 'Entered twice' && e.voided_by, 'the void keeps who, when and why');
  const v = (await call('/api/vendors/' + ven.id)).json;
  ok(v.totals.last12_cents === 123456, 'a void drops out of every total');
  ok(v.expenses.some(x => x.id === e2.id), 'but it is still listed — nothing is deleted');
  ok((await call('/api/expenses/' + e2.id, { method: 'PUT', body: { amount: '1' } })).status === 409, 'a void expense cannot be edited afterwards');
  ok((await call('/api/expenses/' + e2.id + '/pay', { body: {} })).status === 409, 'or paid');
  ok((await call('/api/expenses/' + e2.id, { method: 'DELETE' })).status === 404, 'there is no delete route for expenses at all');
}

// ---- receipts ----
{
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  ok((await call('/api/expenses/' + e1.id + '/receipt', { body: { name: 'receipt.png', mime: 'image/png', data: png } })).status === 200, 'a photo receipt can be attached');
  const got = await call('/api/expenses/' + e1.id + '/receipt');
  ok(got.status === 200 && got.headers.get('content-type') === 'image/png' && got.buf[0] === 0x89, 'and served back as the image');
  ok(got.headers.get('x-content-type-options') === 'nosniff', 'with nosniff, so it cannot be reinterpreted as script');
  ok((await call('/api/expenses/' + e1.id + '/receipt', { body: { name: 'x.html', mime: 'text/html', data: 'PGgxPmhpPC9oMT4=' } })).status === 400,
    'an HTML "receipt" is refused — only photos and PDFs');
  ok((await call('/api/expenses/' + e2.id + '/receipt')).status === 404, 'an expense without a receipt is a 404, not an error');
}

// ---- recurring bills, and that they never double-bill ----
let rec;
{
  // Monthly on the 1st, starting three months ago: catching up should create exactly three or four.
  const start = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 3); d.setUTCDate(1); return d.toISOString().slice(0, 10); })();
  const r = await call('/api/expense-recurring', { body: { vendor_id: ven.id, amount: '100', frequency: 'monthly', next_date: start, category: 'software', description: 'VEND-TEST SaaS', due_days: 15 } });
  ok(r.status === 200, 'a recurring bill can be set up');
  rec = r.json.id;

  const first = (await call('/api/expense-recurring/run', { body: {} })).json;
  const mine = () => call('/api/expenses?vendor_id=' + ven.id + '&status=all').then(x => x.json.filter(e => e.recurring_id === rec));
  const n1 = (await mine()).length;
  ok(n1 >= 3 && n1 <= 4, `running it catches up every missed month (${n1})`);
  ok(first.created >= n1, 'and reports what it created');

  await call('/api/expense-recurring/run', { body: {} });
  await call('/api/expense-recurring/run', { body: {} });
  ok((await mine()).length === n1, 'running it again — twice — creates nothing more: one bill per period, always');

  // Winding next_date back must not re-create bills that already exist either. This is the case
  // the unique index exists for: the bookkeeping is wrong, and the database still refuses.
  await call('/api/expense-recurring/' + rec, { method: 'PUT', body: { next_date: start } });
  await call('/api/expense-recurring/run', { body: {} });
  ok((await mine()).length === n1, 'even with its next date wound back, no period is billed twice');

  const bills = await mine();
  ok(bills.every(b => b.status === 'unpaid' && b.due_date > b.date), 'generated bills are unpaid and due 15 days after their date');
}

// ---- P&L: expenses land on the right account, overhead is separate, nothing counts twice ----
{
  const before = (await call('/api/pnl')).json;
  const acct = (await call('/api/meta')).json.accounts[0];
  const cust = (await call('/api/customers', { body: { name: 'VEND-TEST PnL Cust ' + stamp, account_ids: [acct.id] } })).json;
  const site = (await call('/api/sites', { body: { customer_id: cust.id, name: 'VEND-TEST PnL Site ' + stamp, service_address: '1 Cost Rd, Mesa, AZ' } })).json;
  const siteAcct = (await call('/api/sites/' + site.id)).json.account.id;

  const future = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
  await call('/api/expense-recurring', { body: { vendor_id: ven.id, amount: '120', frequency: 'yearly', next_date: future, parent_type: 'site', parent_id: site.id } });
  await call('/api/expense-recurring', { body: { vendor_id: ven.id, amount: '50', frequency: 'monthly', next_date: future } });

  const after = (await call('/api/pnl')).json;
  const row = (d) => d.rows.find(r => r.account_id === siteAcct) || { expense_cost: 0, cost: 0 };
  ok(Math.abs(row(after).expense_cost - row(before).expense_cost - 10) < 0.001, "a $120/yr bill on a site adds $10/mo to that site's account");
  ok(Math.abs(after.totals.overhead - before.totals.overhead - 50) < 0.001, 'an untied $50/mo bill is overhead, not charged to an account');
  const expectMargin = before.totals.margin - 10 - 50;
  ok(Math.abs(after.totals.margin - expectMargin) < 0.01, 'the company margin falls by exactly the new monthly cost: nothing counted twice');

  // The per-account card and the company page must agree.
  const card = (await call('/api/accounts/' + siteAcct + '/pnl')).json;
  ok(Math.abs(card.expense_cost - row(after).expense_cost) < 0.001, "the account's own P&L card shows the same expense figure as the company page");

  // One-off expenses are spending, not run-rate.
  await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: '5000', parent_type: 'site', parent_id: site.id } });
  const oneoff = (await call('/api/pnl')).json;
  ok(Math.abs(row(oneoff).expense_cost - row(after).expense_cost) < 0.001, 'a one-off purchase does not change the monthly run-rate');
}

// ---- deactivating a vendor pauses its bills ----
{
  const d = await call('/api/vendors/' + ven.id, { method: 'DELETE', body: { reason: 'Switched suppliers' } });
  ok(d.status === 200 && d.json.recurring_paused >= 1, 'deactivating a vendor pauses its recurring bills');
  ok((await call('/api/vendors')).json.every(v => v.id !== ven.id), 'it leaves the vendor list');
  ok((await call('/api/vendors?archived=1')).json.some(v => v.id === ven.id), 'and is still reachable');
  ok((await call('/api/expenses?vendor_id=' + ven.id + '&status=all')).json.length > 0, 'its expenses are all still there');

  // Even a schedule switched back on by hand bills nothing while the vendor is deactivated.
  ok((await call('/api/expense-recurring/' + rec, { method: 'PUT', body: { active: 1 } })).status === 409,
    'a bill cannot be resumed while its vendor is deactivated');

  const r = await call('/api/vendors/' + ven.id + '/restore', { body: {} });
  ok(r.status === 200 && /paused/i.test(r.json.note || ''), 'reactivating says the bills stay paused, rather than restarting them silently');
}

// ---- search ----
{
  const s = (await call('/api/search?q=' + encodeURIComponent('Pat Rep'))).json;
  const g = (s.groups || []).find(x => x.type === 'vendor');
  ok(g && g.items.some(i => i.id === ven.id), 'a vendor is found by the name of one of its contacts');
}

// ---- access: this is spending, and field / support staff do not see it ----
{
  const receiptUrl = '/api/expenses/' + e1.id + '/receipt';
  cookie = '';
  ok((await call('/api/vendors')).status === 401, 'anonymous: no vendor list');
  ok((await call(receiptUrl)).status === 401, 'anonymous: receipts are not public');
  await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await call('/api/vendors')).status === 403, 'support staff cannot list vendors');
  ok((await call('/api/expenses')).status === 403, 'or expenses');
  ok((await call(receiptUrl)).status === 403, 'or open a receipt');
  ok((await call('/api/expenses', { body: { vendor_id: ven.id, date: today, amount: '1' } })).status === 403, 'or enter one');
  const s = (await call('/api/search?q=' + encodeURIComponent('VEND-TEST'))).json;
  ok(!(s.groups || []).some(x => x.type === 'vendor'), 'and vendors do not appear in their search results');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
