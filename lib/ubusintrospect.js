// Asking a device what it can do, rather than assuming.
//
// This exists because of a specific mistake. Wanting 5G signal off a Katalyst, the capture tool
// hardcoded `modem.signal status` and `gl-clients get_list` — plausible names, invented by me. Both
// returned ubus status 3, method not found. The objects were right there; only the names were
// wrong. Two round trips to a customer's router to learn something the device would have said
// outright if asked.
//
// `ubus -v list` lists every object, every method, and the arguments each method expects. Reading
// that removes the guessing entirely — and it generalises: a vendor object nobody has seen before
// gets captured without anyone writing code for it first.
//
// The second half of this file is the safety filter, which matters more than the parser. Calling
// discovered methods blind means calling them on live customer hardware, and a vendor object may
// expose a reboot or a factory reset alongside its getters.

/**
 * Parse `ubus -v list`.
 *
 * The format is an object line, then one indented line per method:
 *
 *   'system' @1a2b3c4d
 *     "board":{}
 *     "info":{}
 *     "reboot":{}
 *
 * A method's `{}` is its argument signature — empty means it takes none, which is exactly the set
 * that can be called without inventing values.
 *
 * @returns {Object<string, Object<string, object>>} object → method → signature
 */
export function parseUbusVerboseList(text) {
  const out = {};
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const obj = line.match(/^'([^']+)'/);
    if (obj) { current = obj[1]; out[current] = {}; continue; }
    const m = line.match(/^\s+"([^"]+)"\s*:\s*(\{.*\})\s*$/);
    if (m && current) {
      let sig;
      try { sig = JSON.parse(m[2]); } catch { sig = {}; }
      out[current][m[1]] = sig;
    }
  }
  return out;
}

/**
 * Names that read as retrieval.
 *
 * Deliberately a prefix match: what a method DOES is conventionally its first word.
 */
const READ_NAME = /^(get|status|info|list|show|dump|read|stat|state|check|query|survey)/i;

/**
 * Split a method name into words: `get_and_reset_stats` → [get, and, reset, stats],
 * `getSignals` → [get, signals].
 *
 * Token matching rather than substring matching, because substring matching cannot tell
 * `get_signals` (a read) from `signal` (send a signal to a process). Both contain "signal"; only
 * one of them does anything. The first attempt at this blocklisted the substring and immediately
 * disqualified the 5G signal reader it was written to enable.
 */
export function methodWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

/**
 * Words that mean something changes — checked ANYWHERE in the name, not just at the start.
 *
 * That distinction is the whole safeguard. `get_and_reset_stats` and `status_reset` both begin with
 * a reading verb, and a prefix-only check would have called both. On a customer's router.
 */
/**
 * Verbs that mean something happens. Matched as whole WORDS anywhere in the name.
 *
 * `scan` is in here from experience, not theory. It reads like a retrieval and it is not: running
 * `repeater scan` on a live Katalyst performed a real site survey, which takes the radio off-channel
 * and briefly disturbs the customer's WiFi — and returned the neighbours' SSIDs and BSSIDs as a
 * bonus. The genuine read on that object is `surveys`, the cached result.
 */
const MUTATING = new Set([
  'set', 'add', 'del', 'delete', 'remove', 'write', 'reboot', 'restart', 'reload', 'reset',
  'stop', 'start', 'enable', 'disable', 'apply', 'commit', 'upgrade', 'update', 'factory',
  'format', 'clear', 'flush', 'kill', 'erase', 'wipe', 'reprovision', 'scan', 'probe',
  'connect', 'disconnect', 'bind', 'unbind', 'upload', 'sync', 'notify', 'teardown', 'setup',
  'send', 'exit', 'enter', 'save', 'rebind', 'subscribe'
]);

/**
 * Words that are an ACTION as the verb and a SUBJECT everywhere else.
 *
 * `signal` is the clearest case: `service signal` sends one to a process, while `get_signals` reads
 * 5G measurements. Same word, opposite meanings, told apart by position — a method's verb is its
 * first word, so an ambiguous word appearing later is the thing being read, not the thing being
 * done. Likewise `scan` (the action) against a hypothetical `get_scan_results` (the reading).
 *
 * This only ever loosens the rule for names that ALREADY start with a reading verb, since
 * isSafeMethod has tested that first.
 */
const ACTION_AS_VERB = new Set(['signal', 'scan', 'probe']);

/** Is this method safe to call blind on live hardware? */
export function isSafeMethod(name) {
  const n = String(name || '');
  if (!READ_NAME.test(n)) return false;      // must look like a reading in the first place
  const words = methodWords(n);
  if (!words.length) return false;
  if (words.some(w => MUTATING.has(w))) return false;        // mutating word anywhere disqualifies
  if (ACTION_AS_VERB.has(words[0])) return false;            // ambiguous word in the verb position
  return true;
}

/**
 * Decide what to do with one discovered method.
 *
 * Returns either {call: true} or {skip: '<reason>'}. A reason rather than a silent omission,
 * because "why did the capture not include this" is a question someone will ask.
 */
export function planMethodCall(name, signature) {
  if (!isSafeMethod(name)) return { skip: 'not obviously read-only — not called against a live device' };

  const args = signature && typeof signature === 'object' ? Object.keys(signature) : [];
  if (!args.length) return { call: true };

  // A ubus signature does NOT distinguish required arguments from optional ones — `service list`
  // advertises {name, verbose} and both are optional; `modem.signal get_signals` advertises
  // {time} and works without it. Refusing everything with a signature therefore skipped the two
  // things actually worth capturing on this hardware.
  //
  // Calling a READ-ONLY-NAMED method with no arguments is safe regardless: the name has already
  // been cleared of every mutating verb, so the worst outcome is ubus status 2, invalid argument.
  // An error costs nothing; the omission cost a round trip to a customer's router.
  //
  // Note this deliberately does NOT invent argument values — omitting an argument is safe, and
  // supplying a guessed one is not.
  return { call: true, argsOmitted: args };
}

/** ubus status codes. `exited 3` tells nobody anything; "method not found" tells them everything. */
export const UBUS_EXIT = {
  1: 'invalid command',
  2: 'invalid argument',
  3: 'METHOD NOT FOUND (the object exists; this method does not)',
  4: 'not found',
  5: 'no data',
  6: 'permission denied',
  7: 'timed out',
  8: 'not supported',
  9: 'unknown error',
  10: 'connection failed'
};

export const explainExit = (r) => (r && r.code && UBUS_EXIT[r.code]) || (r && r.error) || 'failed';
