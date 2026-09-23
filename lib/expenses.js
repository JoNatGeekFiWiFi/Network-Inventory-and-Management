// Expense arithmetic: money, dates and where a cost lands in Profit & Loss.
//
// Kept free of the database and of Express so every rule here can be tested directly, with no
// server running. Nearly everything that goes wrong with money goes wrong in exactly these few
// functions — a float that does not add up, a month-end that drifts, a cost counted twice — so they
// are the ones worth being able to test in isolation.

/** What an expense can be. Plain words, because they end up on a P&L someone reads. */
export const EXPENSE_CATEGORIES = [
  ['bandwidth', 'Bandwidth & transit'],
  ['colocation', 'Colocation & rack space'],
  ['hardware', 'Hardware & equipment'],
  ['install', 'Installation & contractors'],
  ['power', 'Power & utilities'],
  ['software', 'Software & subscriptions'],
  ['vehicle', 'Vehicle & travel'],
  ['insurance', 'Insurance'],
  ['professional', 'Professional services'],
  ['office', 'Office & supplies'],
  ['permits', 'Permits & fees'],
  ['other', 'Other']
];
const CATEGORY_KEYS = new Set(EXPENSE_CATEGORIES.map(([k]) => k));
export const categoryOr = (c) => (CATEGORY_KEYS.has(String(c || '')) ? String(c) : 'other');

/** What kind of company a vendor is. "carrier" is the one the rest of the platform filters on. */
export const VENDOR_KINDS = [
  ['carrier', 'Carrier'],
  ['distributor', 'Distributor / supplier'],
  ['contractor', 'Contractor'],
  ['colocation', 'Colocation / data centre'],
  ['utility', 'Utility'],
  ['software', 'Software / SaaS'],
  ['professional', 'Professional services'],
  ['other', 'Other']
];
const KIND_KEYS = new Set(VENDOR_KINDS.map(([k]) => k));
export const vendorKindOr = (k) => (KIND_KEYS.has(String(k || '')) ? String(k) : 'other');

export const FREQUENCIES = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', yearly: 'Yearly' };
const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
export const frequencyOr = (f) => (FREQUENCIES[f] ? f : 'monthly');

// ---- money --------------------------------------------------------------------------------------

/**
 * Dollars in, integer cents out — or null if it is not a sensible amount.
 *
 * Accepts what people actually type: "$1,234.56", "1234.5", "  80 ". Rounds half-up to the cent
 * rather than truncating, so 19.999 is $20.00 and not $19.99. Parsing goes through the string, not
 * through `Math.round(x * 100)` on a float — 1.005 * 100 is 100.49999999999999, and that rounds the
 * wrong way.
 */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    v = v.toFixed(6);
  }
  const s = String(v).trim().replace(/[$,\s]/g, '');
  const m = s.match(/^(-)?(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = (m[3] || '').padEnd(3, '0');
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] ? -cents : cents;
}

/** Cents to "$1,234.56". Always two places; a ledger that shows $80 next to $79.99 reads as an error. */
export function fmtCents(c) {
  const n = Number(c) || 0;
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** A recurring amount expressed per month, in cents, rounded once at the end. */
export function monthlyCents(amountCents, freq) {
  const a = Number(amountCents) || 0;
  switch (frequencyOr(freq)) {
    case 'weekly': return Math.round((a * 52) / 12);
    case 'quarterly': return Math.round(a / 3);
    case 'semiannual': return Math.round(a / 6);
    case 'yearly': return Math.round(a / 12);
    default: return a;
  }
}

// ---- dates --------------------------------------------------------------------------------------

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/**
 * The next bill date after `dateStr`.
 *
 * Month-based schedules keep an ANCHOR DAY. Adding a month with setUTCMonth turns 31 January into
 * 3 March, and from then on every bill lands on the 3rd; clamping without an anchor turns it into
 * 28 February and then the 28th for ever. With the anchor it goes 31 Jan → 28 Feb → 31 Mar → 30 Apr,
 * which is what the colo's own invoices do.
 */
export function nextOccurrence(dateStr, freq, anchorDay) {
  const f = frequencyOr(freq);
  if (f === 'weekly') return addDays(dateStr, 7);
  const d = new Date(dateStr + 'T00:00:00Z');
  const anchor = Number(anchorDay) || d.getUTCDate();
  const total = d.getUTCMonth() + FREQ_MONTHS[f];
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m0 = total % 12;
  const day = Math.min(anchor, daysInMonth(y, m0));
  return new Date(Date.UTC(y, m0, day)).toISOString().slice(0, 10);
}

/**
 * Every bill date a schedule owes, up to and including `today`, starting at `nextDate`.
 *
 * Capped, because a schedule created with a next date years in the past would otherwise generate
 * hundreds of bills in one tick. The cap is reported, not hidden: the caller says how many were left.
 */
export function dueDates(nextDate, freq, anchorDay, today, cap = 24) {
  const out = [];
  let d = nextDate;
  while (d <= today && out.length < cap) { out.push(d); d = nextOccurrence(d, freq, anchorDay); }
  return { dates: out, next: d, truncated: d <= today };
}

// ---- Profit & Loss ------------------------------------------------------------------------------

/**
 * Where each recurring expense lands.
 *
 *   * tied to a SITE     → the account that site is served on
 *   * tied to a CUSTOMER → split evenly across the accounts serving that customer — exactly the
 *                          rule revenue already uses, so a customer's cost and income land in the
 *                          same places and their margin is not smeared across unrelated accounts
 *   * tied to a POP, or to nothing → company OVERHEAD. A POP serves many accounts at once, and
 *                          dividing its rent by some guessed ratio would put a number on each
 *                          account's line that nobody could explain. Overhead is shown as its own
 *                          line and comes off the company total, not off any one account.
 *
 * A customer with no accounts, or a site that has vanished, falls to overhead rather than
 * disappearing: an expense must always land somewhere, or the totals quietly stop adding up.
 *
 * @param schedules        [{ amount_cents, frequency, parent_type, parent_id, category }]
 * @param siteAccount      (siteId) → accountId | null
 * @param customerAccounts (customerId) → [accountId]
 * @returns { byAccount: Map<accountId, cents>, overhead: cents, overheadByCategory: {cat: cents}, total }
 */
export function attributeRecurring(schedules, siteAccount, customerAccounts) {
  const byAccount = new Map();
  let overhead = 0;
  const overheadByCategory = {};
  let total = 0;
  const toOverhead = (c, cat) => { overhead += c; overheadByCategory[cat] = (overheadByCategory[cat] || 0) + c; };

  for (const s of schedules) {
    const monthly = monthlyCents(s.amount_cents, s.frequency);
    if (!monthly) continue;
    total += monthly;
    const cat = categoryOr(s.category);
    if (s.parent_type === 'site') {
      const acct = siteAccount(s.parent_id);
      if (acct) { byAccount.set(acct, (byAccount.get(acct) || 0) + monthly); continue; }
    } else if (s.parent_type === 'customer') {
      const accts = customerAccounts(s.parent_id) || [];
      if (accts.length) {
        // Split so the parts add back to the whole: the first accounts take the leftover cents.
        const base = Math.floor(monthly / accts.length);
        let rem = monthly - base * accts.length;
        for (const a of accts) {
          const share = base + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
          byAccount.set(a, (byAccount.get(a) || 0) + share);
        }
        continue;
      }
    }
    toOverhead(monthly, cat);
  }
  return { byAccount, overhead, overheadByCategory, total };
}
