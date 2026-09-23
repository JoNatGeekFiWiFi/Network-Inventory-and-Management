// The arithmetic behind expenses, tested without a server.
//
// These are the functions that decide what a typed amount means, when the next bill falls, and
// which account a cost lands on. Each assertion names a specific way money code goes wrong, because
// the failures here are not crashes — they are totals that are a few cents or a whole bill off, and
// nobody notices until the books do not reconcile.
import { toCents, fmtCents, monthlyCents, nextOccurrence, dueDates, attributeRecurring, addDays, isDate } from '../lib/expenses.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- what a typed amount means ----
ok(toCents('80') === 8000, 'a whole number is dollars');
ok(toCents('$1,234.56') === 123456, 'dollar signs and thousands separators are what people type');
ok(toCents('  19.5 ') === 1950, 'one decimal place and stray spaces');
ok(toCents('19.999') === 2000, 'a third decimal rounds half-up rather than being truncated');
ok(toCents('1.005') === 101, '1.005 is $1.01 — the float route (1.005*100 = 100.4999…) gets this wrong');
ok(toCents(1.005) === 101, 'and a numeric 1.005 is handled the same way');
ok(toCents(0.1) + toCents(0.2) === toCents(0.3), 'integer cents add up where 0.1 + 0.2 does not');
ok(toCents('abc') === null && toCents('') === null && toCents(null) === null, 'nonsense and blanks are null, not zero');
ok(toCents('1.2.3') === null && toCents('12e3') === null, 'malformed numbers are refused rather than half-parsed');
ok(toCents(Infinity) === null && toCents(NaN) === null, 'non-finite numbers are refused');

ok(fmtCents(123456) === '$1,234.56', 'cents format with separators and two places');
ok(fmtCents(8000) === '$80.00', '$80.00, never $80 next to $79.99');
ok(fmtCents(5) === '$0.05', 'single-digit cents are zero-padded');

// ---- run-rate ----
ok(monthlyCents(1200, 'monthly') === 1200, 'monthly is itself');
ok(monthlyCents(12000, 'yearly') === 1000, 'yearly is a twelfth');
ok(monthlyCents(3000, 'quarterly') === 1000, 'quarterly is a third');
ok(monthlyCents(1200, 'weekly') === 5200, 'weekly is 52/12 of a week, not four weeks');
ok(monthlyCents(1000, 'nonsense') === 1000, 'an unknown frequency is treated as monthly rather than dropped');

// ---- when the next bill falls ----
ok(nextOccurrence('2026-01-15', 'monthly') === '2026-02-15', 'the 15th stays the 15th');
ok(nextOccurrence('2026-01-31', 'monthly', 31) === '2026-02-28', '31 January → 28 February (not 3 March)');
ok(nextOccurrence('2026-02-28', 'monthly', 31) === '2026-03-31', 'and back to the 31st in March — the anchor is what makes that possible');
ok(nextOccurrence('2028-01-31', 'monthly', 31) === '2028-02-29', 'a leap year gets the 29th');
ok(nextOccurrence('2026-11-30', 'quarterly', 30) === '2027-02-28', 'quarterly across a year end, clamped');
ok(nextOccurrence('2026-12-15', 'yearly') === '2027-12-15', 'yearly');
ok(nextOccurrence('2026-12-29', 'weekly') === '2027-01-05', 'weekly across a year end');

{
  // Walk a month-end schedule for a year and make sure it never drifts off the end of the month.
  let d = '2026-01-31'; const seen = [d];
  for (let i = 0; i < 12; i++) { d = nextOccurrence(d, 'monthly', 31); seen.push(d); }
  const lastDays = seen.every(x => { const n = new Date(x + 'T00:00:00Z'); n.setUTCDate(n.getUTCDate() + 1); return n.getUTCDate() === 1; });
  ok(lastDays, 'a schedule on the 31st lands on the last day of every month for a year, no drift');
}

{
  const r = dueDates('2026-01-01', 'monthly', 1, '2026-03-15');
  ok(r.dates.join() === '2026-01-01,2026-02-01,2026-03-01', 'catching up yields every missed bill date, in order');
  ok(r.next === '2026-04-01' && !r.truncated, 'and the next date after them');
  const none = dueDates('2026-05-01', 'monthly', 1, '2026-03-15');
  ok(none.dates.length === 0 && none.next === '2026-05-01', 'nothing is due before the first date');
  const big = dueDates('2020-01-01', 'weekly', null, '2026-01-01', 24);
  ok(big.dates.length === 24 && big.truncated, 'a schedule years in the past is capped per run and says it was capped');
}

ok(addDays('2026-02-27', 3) === '2026-03-02', 'adding days crosses month ends');
ok(isDate('2026-02-28') && !isDate('2026-2-8') && !isDate('yesterday'), 'dates are YYYY-MM-DD only');

// ---- where a cost lands ----
{
  const siteAccount = (id) => ({ 10: 1, 11: 2 }[id] || null);
  const customerAccounts = (id) => ({ 100: [1, 2, 3], 101: [2], 102: [] }[id] || []);
  const a = attributeRecurring([
    { amount_cents: 5000, frequency: 'monthly', parent_type: 'site', parent_id: 10, category: 'power' },
    { amount_cents: 1000, frequency: 'monthly', parent_type: 'customer', parent_id: 100, category: 'install' },
    { amount_cents: 12000, frequency: 'yearly', parent_type: 'customer', parent_id: 101, category: 'software' },
    { amount_cents: 30000, frequency: 'monthly', parent_type: 'pop', parent_id: 5, category: 'colocation' },
    { amount_cents: 2500, frequency: 'monthly', parent_type: null, parent_id: null, category: 'software' },
    { amount_cents: 700, frequency: 'monthly', parent_type: 'site', parent_id: 999, category: 'other' },
    { amount_cents: 400, frequency: 'monthly', parent_type: 'customer', parent_id: 102, category: 'other' }
  ], siteAccount, customerAccounts);

  ok(a.byAccount.get(1) === 5000 + 334, "a site's cost goes to the account the site is on");
  ok(a.byAccount.get(2) === 333 + 1000, "a customer's cost is split across their accounts, the way their revenue is");
  ok(a.byAccount.get(3) === 333, 'every serving account takes a share');
  // $10.00 across three accounts is 334 + 333 + 333: the parts add back to the whole.
  ok([1, 2, 3].reduce((n, id) => n + (a.byAccount.get(id) || 0), 0) === 5000 + 1000 + 1000,
    'split costs add back to the exact total — no cent is lost to rounding');
  ok(a.overhead === 30000 + 2500 + 700 + 400, 'a POP, nothing, a vanished site and a customer with no accounts all land in overhead');
  ok(a.overheadByCategory.colocation === 30000, 'overhead keeps its category so the P&L can say what it is');
  const attributed = [...a.byAccount.values()].reduce((n, c) => n + c, 0);
  ok(attributed + a.overhead === a.total, 'EVERY cost lands somewhere: attributed + overhead = total');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
