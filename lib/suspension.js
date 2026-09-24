// Suspension for nonpayment: who is late, when they get warned, when they get suspended, and what
// a payment arrangement changes. Pure functions — dates in, decisions out — so every rule can be
// tested without a database or a router.
//
// The policy, as set by the business:
//
//   * A customer is LATE from the due date of their oldest unpaid invoice (sent or part-paid, with a
//     balance). Drafts and voided invoices never count.
//   * They are due for suspension GRACE days after that (default 10), and warned WARN days before
//     (default 3). Suspension is automatic; restoring is automatic too, the moment the account is
//     back in good standing.
//   * A PAYMENT ARRANGEMENT protects them:
//       - an EXTENSION moves the suspension date to the agreed date;
//       - INSTALLMENTS split the balance into smaller payments on a schedule. While every
//         installment due so far has been covered, they are protected. Miss one by more than the
//         arrangement grace (default 3 days) and the arrangement is broken: they are due at once.
//     An arrangement covers the invoices that were open when it was made. A NEW invoice that comes
//     due while it runs is judged on its own, by the normal rule — otherwise an arrangement would
//     quietly become a permanent exemption.
//   * An EXEMPT customer is never suspended automatically (a hospital, a school, a partner).
//   * A HOLD keeps a customer on until a date — what staff use to override a suspension from the
//     report without setting up a formal arrangement.

export const DEFAULTS = { graceDays: 10, warnDays: 3, arrangementGraceDays: 3 };

const DAY = 86400000;
const toDay = (s) => (s ? Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') : null);
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day, n) => isoDay(toDay(day) + n * DAY);
const r2 = (n) => Math.round(n * 100) / 100;

/** An invoice that counts toward being late. */
export function isOpen(inv) {
  return (inv.status === 'sent' || inv.status === 'partial') && Number(inv.balance) > 0.004 && !!inv.due_date;
}

/**
 * Installment progress, derived from money actually paid rather than ticked by hand.
 *
 * `paidSince` is what has been paid toward the covered invoices since the arrangement began. The
 * installments are covered in order: the first $X paid covers the first installment, and so on. So
 * a customer who pays two installments' worth early is ahead, not confused.
 */
export function installmentProgress(installments, paidSince) {
  let cum = 0;
  return installments.map(i => {
    const before = cum;
    cum = r2(cum + Number(i.amount));
    const covered = r2(Math.max(0, Math.min(Number(i.amount), paidSince - before)));
    return { ...i, covered, paid: paidSince + 0.004 >= cum };
  });
}

/**
 * Where a customer stands on a given day.
 *
 *   invoices     — their invoices: { id, status, balance, due_date }
 *   arrangement  — the active one, or null: { kind: 'extension'|'installments', extend_until,
 *                  invoice_ids: [...], installments: [{ due_date, amount }], paid_since }
 *   today        — 'YYYY-MM-DD'
 *
 * Returns { late, overdueSince, daysLate, balance, suspendOn, warnOn, due, warn, protectedBy,
 *           arrangementBroken, arrangementDone, nextInstallment }.
 */
export function standing({ invoices = [], arrangement = null, exempt = false, holdUntil = null, today, policy = {} }) {
  const p = { ...DEFAULTS, ...policy };
  const open = invoices.filter(isOpen);
  const balance = r2(open.reduce((n, i) => n + Number(i.balance), 0));
  const out = { late: false, overdueSince: null, daysLate: 0, balance, suspendOn: null, warnOn: null, due: false, warn: false,
    protectedBy: null, arrangementBroken: false, arrangementDone: false, nextInstallment: null, exempt: !!exempt,
    held: !!(holdUntil && today <= holdUntil), holdUntil: holdUntil || null };
  if (!open.length) { if (arrangement) out.arrangementDone = true; return out; }

  const todayMs = toDay(today);
  const covered = new Set(arrangement ? (arrangement.invoice_ids || []).map(Number) : []);
  const pastDue = open.filter(i => toDay(i.due_date) < todayMs);
  const oldest = (list) => list.reduce((m, i) => (m == null || i.due_date < m ? i.due_date : m), null);

  // Invoices outside the arrangement follow the normal rule.
  const uncovered = open.filter(i => !covered.has(Number(i.id)));
  let suspendOn = null;
  if (uncovered.length) suspendOn = addDays(oldest(uncovered), p.graceDays);

  // Invoices inside it follow the arrangement.
  const inside = open.filter(i => covered.has(Number(i.id)));
  if (arrangement && inside.length) {
    let arrDate;
    if (arrangement.kind === 'extension') {
      arrDate = addDays(arrangement.extend_until, 1);
      out.protectedBy = today <= arrangement.extend_until ? 'extension' : null;
      if (!out.protectedBy) out.arrangementBroken = true;
    } else {
      const prog = installmentProgress(arrangement.installments || [], Number(arrangement.paid_since) || 0);
      const missed = prog.find(i => !i.paid && addDays(i.due_date, p.arrangementGraceDays) < today);
      out.nextInstallment = prog.find(i => !i.paid) || null;
      if (missed) {
        out.arrangementBroken = true;
        arrDate = addDays(missed.due_date, p.arrangementGraceDays + 1);
      } else {
        out.protectedBy = 'installments';
        // Protected until the next unpaid installment's own grace runs out.
        const next = prog.find(i => !i.paid);
        arrDate = next ? addDays(next.due_date, p.arrangementGraceDays + 1) : null;
      }
    }
    if (arrDate && (!suspendOn || arrDate < suspendOn)) suspendOn = arrDate;
  } else if (arrangement && !inside.length) {
    out.arrangementDone = true;
  }

  if (pastDue.length) {
    out.late = true;
    out.overdueSince = oldest(pastDue);
    out.daysLate = Math.round((todayMs - toDay(out.overdueSince)) / DAY);
  }
  out.suspendOn = suspendOn;
  out.warnOn = suspendOn ? addDays(suspendOn, -p.warnDays) : null;
  // A HOLD is a person saying "leave them on until this date" — the override from the report.
  const blocked = !!exempt || out.held;
  out.due = !blocked && !!suspendOn && today >= suspendOn;
  out.warn = !blocked && !!suspendOn && !out.due && today >= out.warnOn;
  return out;
}

/**
 * What to do about one customer today. `state` is what we already did: { suspended, suspendedBy,
 * warnedFor } where warnedFor is the suspendOn date a warning was already sent for.
 *
 * Returns one of: 'suspend', 'restore', 'warn', or null. Only AUTOMATIC suspensions are lifted
 * automatically; a suspension a person made by hand stays until a person lifts it.
 */
export function decide(st, state = {}, { auto = true } = {}) {
  if (state.suspended) {
    if (state.suspendedBy === 'auto' && !st.due) return 'restore';
    return null;
  }
  if (!auto) return null;
  if (st.due) return 'suspend';
  if (st.warn && state.warnedFor !== st.suspendOn) return 'warn';
  return null;
}

/** Split a balance into n near-equal installments, cents exact, the remainder on the last one. */
export function splitInstallments(total, n, firstDue, everyDays = 30) {
  const cents = Math.round(Number(total) * 100);
  n = Math.max(1, Math.min(24, Math.floor(Number(n) || 1)));
  if (!(cents > 0)) return [];
  const each = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => ({
    due_date: addDays(firstDue, i * everyDays),
    amount: (i === n - 1 ? cents - each * (n - 1) : each) / 100
  }));
}

/** Validate an arrangement from the UI. Returns { arrangement } or { error }. */
export function validateArrangement(b, { today, balance }) {
  const kind = b.kind;
  if (kind === 'extension') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.extend_until || '')) || isNaN(toDay(b.extend_until))) return { error: 'Pick the date they have until' };
    if (b.extend_until < today) return { error: 'The extension date is in the past' };
    return { arrangement: { kind, extend_until: b.extend_until, installments: [] } };
  }
  if (kind === 'installments') {
    const list = Array.isArray(b.installments) ? b.installments : [];
    if (!list.length) return { error: 'Add at least one installment' };
    let total = 0;
    for (const i of list) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.due_date || ''))) return { error: 'Every installment needs a due date' };
      const a = Number(i.amount);
      if (!(a > 0)) return { error: 'Every installment needs an amount' };
      total += a;
    }
    const sorted = [...list].sort((x, y) => (x.due_date < y.due_date ? -1 : 1)).map(i => ({ due_date: i.due_date, amount: r2(Number(i.amount)) }));
    if (balance != null && r2(total) + 0.004 < balance) return { error: `The installments add up to $${r2(total).toFixed(2)}, less than the $${balance.toFixed(2)} owed` };
    return { arrangement: { kind, extend_until: null, installments: sorted } };
  }
  return { error: 'Choose an extension or installments' };
}
