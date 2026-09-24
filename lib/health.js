// Device health and alerting: the rules, the state machine, and the status a device is shown with.
//
// Pure functions only — no database, no clock — so every transition can be tested by feeding it
// numbers. domains/health.js stores the state and sends the notifications.
//
// The model (borrowed in spirit from OpenWISP Monitoring, written from scratch):
//
//   * A METRIC is something the sampler measures each minute: can we reach the device, can the
//     device reach the internet, how long its WAN ping takes. New metrics (CPU, memory, signal)
//     are one entry in METRICS.
//   * A RULE says when a metric is bad: an operator, a threshold, and a TOLERANCE — how many
//     minutes it must stay bad before anyone is told. The tolerance is what keeps a one-minute blip
//     from paging someone at 3am. Rules have a global default and can be overridden per device.
//   * Each (device, metric) has a STATE: its last value, when it started breaching, and whether an
//     alert is currently FIRING. An alert fires once when the breach outlasts the tolerance, and a
//     RECOVERY fires once when the value comes back. Nothing in between — a device that is down for
//     six hours sends two messages, not 360.
//   * A device's HEALTH is derived from its states: critical, problem, ok, unknown, or not
//     monitored / deactivated.

export const METRICS = {
  reachable: {
    label: 'Reachable', unit: '', bool: true, critical: true,
    help: 'Whether the platform can reach the device over the management network.',
    rule: { op: '<', threshold: 1, tolerance_min: 5 },
    alert: 'is unreachable', recovery: 'is reachable again'
  },
  wan_ping: {
    label: 'Internet (WAN ping)', unit: '', bool: true, critical: false,
    help: 'Whether the device itself can ping the internet. Down while reachable usually means the WAN is down and management is riding a failover or the overlay.',
    rule: { op: '<', threshold: 1, tolerance_min: 5 },
    alert: 'cannot reach the internet', recovery: 'can reach the internet again'
  },
  latency: {
    label: 'WAN latency', unit: 'ms', bool: false, critical: false,
    help: 'Average round-trip time of the device\'s own ping to the internet.',
    rule: { op: '>', threshold: 150, tolerance_min: 15 },
    alert: 'has high WAN latency', recovery: 'WAN latency is back to normal'
  }
};
export const METRIC_KEYS = Object.keys(METRICS);
export const OPS = ['<', '>'];

/** The rule in force for one metric on one device: device override, else global, else built-in. */
export function effectiveRule(metric, globalRules = {}, deviceRules = {}) {
  const base = { enabled: true, ...METRICS[metric].rule };
  const g = globalRules[metric] || {};
  const d = deviceRules[metric] || {};
  const pick = (k) => (d[k] !== undefined && d[k] !== null ? d[k] : g[k] !== undefined && g[k] !== null ? g[k] : base[k]);
  return { metric, enabled: !!pick('enabled'), op: pick('op'), threshold: Number(pick('threshold')), tolerance_min: Number(pick('tolerance_min')),
    source: Object.keys(d).length ? 'device' : Object.keys(g).length ? 'global' : 'default' };
}

export function breaches(rule, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return false;
  const v = Number(value);
  return rule.op === '>' ? v > rule.threshold : v < rule.threshold;
}

/**
 * One observation through the state machine.
 *
 * `state` is the stored row (or null the first time); `at` is milliseconds. Returns the new state
 * and, at most, one event. Times are kept as milliseconds here and turned into ISO text by the
 * caller.
 */
export function step(state, rule, value, at) {
  const s = { value: null, observed_at: null, breach_since: null, firing: 0, fired_at: null, ...(state || {}) };
  s.value = value; s.observed_at = at;
  if (!rule.enabled) {
    // Switching a rule off clears it quietly. A "recovered" message for something nobody fixed
    // would be a lie.
    s.breach_since = null; s.firing = 0; s.fired_at = null;
    return { state: s, event: null };
  }
  if (breaches(rule, value)) {
    if (s.breach_since == null) s.breach_since = at;
    if (!s.firing && at - s.breach_since >= rule.tolerance_min * 60000) {
      s.firing = 1; s.fired_at = at;
      return { state: s, event: { kind: 'alert', value, since: s.breach_since } };
    }
    return { state: s, event: null };
  }
  const wasFiring = !!s.firing;
  const since = s.fired_at;
  s.breach_since = null; s.firing = 0; s.fired_at = null;
  return { state: s, event: wasFiring ? { kind: 'recovery', value, since } : null };
}

export const HEALTH = {
  critical: { label: 'Critical', rank: 5 },
  problem: { label: 'Problem', rank: 4 },
  unknown: { label: 'Unknown', rank: 3 },
  ok: { label: 'OK', rank: 2 },
  unmonitored: { label: 'Not monitored', rank: 1 },
  deactivated: { label: 'Deactivated', rank: 0 }
};

/**
 * A device's health from its metric states.
 *
 *   deactivated  — archived; nothing is checked
 *   unmonitored  — nothing to check it with (in stock, provider-managed, no management address)
 *   critical     — a critical check (reachability) is firing
 *   problem      — any other check is firing
 *   unknown      — monitored, but no observation recently (sampler off, or a new device)
 *   ok           — observed recently and nothing firing
 *
 * A check that is failing but still inside its tolerance does not change the status. That is the
 * point of the tolerance; the device page still shows "failing for 3 min" against the check.
 */
export function healthOf({ archived, monitored }, states, now, { staleMin = 15 } = {}) {
  if (archived) return 'deactivated';
  if (!monitored) return 'unmonitored';
  const firing = states.filter(s => s.firing);
  if (firing.some(s => METRICS[s.metric] && METRICS[s.metric].critical)) return 'critical';
  if (firing.length) return 'problem';
  const last = Math.max(0, ...states.map(s => s.observed_at || 0));
  if (!last || now - last > staleMin * 60000) return 'unknown';
  return 'ok';
}

/** "Warehouse router is unreachable" / "… is reachable again", with the value where it helps. */
export function eventMessage(metric, kind, deviceName, value, rule) {
  const m = METRICS[metric] || { label: metric, unit: '', bool: true, alert: 'alert', recovery: 'recovered' };
  const base = `${deviceName} ${kind === 'alert' ? m.alert : m.recovery}`;
  if (m.bool || value == null) return base;
  return `${base} (${Math.round(Number(value))}${m.unit}${kind === 'alert' && rule ? `, limit ${rule.threshold}${m.unit}` : ''})`;
}

/** Validate a rule edit from the UI. Returns { rule } or { error }. */
export function validateRule(metric, b) {
  if (!METRICS[metric]) return { error: 'Unknown check' };
  const out = {};
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.op !== undefined) { if (!OPS.includes(b.op)) return { error: 'Operator must be < or >' }; out.op = b.op; }
  if (b.threshold !== undefined) { const t = Number(b.threshold); if (!Number.isFinite(t)) return { error: 'Threshold must be a number' }; out.threshold = t; }
  if (b.tolerance_min !== undefined) {
    const t = Number(b.tolerance_min);
    if (!Number.isInteger(t) || t < 0 || t > 1440) return { error: 'Tolerance must be whole minutes, 0 to 1440' };
    out.tolerance_min = t;
  }
  return { rule: out };
}
