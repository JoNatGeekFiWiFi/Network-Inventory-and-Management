#!/usr/bin/env node
//
// Dump what an OpenWrt device actually returns, so the driver is tested against real output.
//
//   node tools/capture-device.mjs 10.241.80.78 --user root --pass 'thepassword' > capture.json
//
// Read-only. It calls a fixed list of ubus objects and records the raw payloads.
//
// WHY THIS EXISTS. The probe answers "can we talk to it". This answers "and what does it say" —
// which is the part that decides whether the parsers are right. My fixtures were written from the
// OpenWrt documentation; a vendor build on an old release will differ in ways no documentation
// predicts (a missing field, a string where a number was expected, an object keyed differently).
// Capturing the real thing turns each of those from a bug discovered in production into a test case.
//
// The output is safe to share: it is device telemetry, and the two things that would not be are
// removed — WiFi passphrases and any UCI secret are never requested, and the sanitiser below strips
// anything that looks like a key or password in case a build volunteers one.

import { sshExec } from '../lib/sshexec.js';
import { parseUbusVerboseList, planMethodCall, explainExit } from '../lib/ubusintrospect.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['user', 'pass']);
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : d; };
const host = (() => {
  const consumed = new Set();
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--') && VALUE_FLAGS.has(args[i].slice(2))) consumed.add(i + 1);
  for (let i = 0; i < args.length; i++) if (!args[i].startsWith('--') && !consumed.has(i)) return args[i];
  return null;
})();

if (!host) {
  console.error('Usage: node tools/capture-device.mjs <address> --user root --pass secret > capture.json');
  process.exit(1);
}

const username = flag('user', 'root');
const password = flag('pass', '');
const run = (argv, timeoutMs = 15000) => sshExec({ host, username, password, argv, timeoutMs });

/** ubus objects worth capturing, and why each one matters to the driver. */
const CALLS = [
  ['system', 'board', {}, 'model, vendor and version'],
  ['system', 'info', {}, 'uptime, load, memory'],
  ['network.device', 'status', {}, 'ports: link state, MAC, speed, byte counters'],
  ['network.interface', 'dump', {}, 'logical interfaces and their addresses'],
  ['iwinfo', 'devices', {}, 'which radios exist'],
  ['luci-rpc', 'getDHCPLeases', {}, 'leases, if LuCI is installed'],
  ['uci', 'get', { config: 'network' }, 'whether uci is reachable at all']
];

/**
 * Vendor objects worth exploring, and why.
 *
 * Their METHOD NAMES ARE NOT GUESSED. A first attempt hardcoded `modem.signal status` and
 * `gl-clients get_list`, and every one came back with ubus status 3 — method not found. The objects
 * were right there; the names were invented. So the tool now reads the signatures off the device
 * with `ubus -v list` and calls what actually exists, which also means a vendor object nobody has
 * seen before gets captured without another round trip to the customer's router.
 */
const EXPLORE = [
  ['modem.signal', '5G/LTE signal — RSRP/RSRQ/SINR, the difference between "the internet is slow" and "the signal dropped 12 dB on Tuesday"'],
  ['modem', 'the modem itself: carrier, band, registration state'],
  ['gl-clients', "the vendor's own client list, which often knows more than DHCP does"],
  ['gl-cloud', 'whether this unit is still phoning home to the vendor cloud'],
  ['mtk-wifi', "MediaTek's own WiFi object, where the driver keeps what iwinfo does not expose"],
  ['repeater', 'the client/repeater side of the radios'],
  ['network.wireless', 'the write path for WiFi, if it is ever added'],
  ['service', 'what is running']
];

/** Commands with no ubus object behind them. */
const SHELL = [
  [['cat', '/tmp/dhcp.leases'], 'the dnsmasq lease file, the fallback when luci-rpc is absent'],
  [['cat', '/etc/openwrt_release'], 'the release strings, including anything the vendor changed'],
  [['logread', '-l', '25'], 'log format, for failed-login harvesting later']
];

/**
 * Remove anything secret before this leaves the device.
 *
 * Not expected to fire — nothing above asks for a passphrase — but a vendor build that returns more
 * than it was asked for should not turn a diagnostic capture into a credential leak.
 */
const SECRET_KEY = /^(key|password|passwd|passphrase|psk|private_key|privkey|secret|token|auth)$/i;
function sanitise(v) {
  if (Array.isArray(v)) return v.map(sanitise);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[removed]' : sanitise(val);
    return out;
  }
  return v;
}

const why = explainExit;

const capture = { host, captured_at: new Date().toISOString(), ubus_list: null, ubus_methods: null, calls: {}, explored: {}, shell: {} };

const list = await run(['ubus', 'list']);
if (!list.ok) {
  console.error(`Could not reach the device: ${list.error}`);
  process.exit(1);
}
capture.ubus_list = String(list.stdout).split('\n').map(s => s.trim()).filter(Boolean);
console.error(`${capture.ubus_list.length} ubus objects available`);

// The method inventory. This is the thing that removes guesswork: every object, every method it
// exposes, and the arguments each one expects.
const verbose = await run(['ubus', '-v', 'list'], 20000);
if (verbose.ok) {
  capture.ubus_methods = parseUbusVerboseList(verbose.stdout);
  const n = Object.values(capture.ubus_methods).reduce((a, m) => a + Object.keys(m).length, 0);
  console.error(`${n} methods across those objects`);
} else {
  console.error(`  note: could not read method signatures (${why(verbose)}) — falling back to the fixed list only`);
}

// `note`, not `why`: destructuring a loop variable called `why` shadowed the explainExit helper of
// the same name, so the error line called a string as a function. Renamed rather than made to work.
for (const [object, method, params, note] of CALLS) {
  const argv = ['ubus', '-S', 'call', object, method];
  if (Object.keys(params).length) argv.push(JSON.stringify(params));
  const r = await run(argv);
  let parsed = null, parseError = null;
  if (r.ok) { try { parsed = sanitise(JSON.parse(String(r.stdout).trim() || '{}')); } catch (e) { parseError = e.message; } }
  capture.calls[`${object}.${method}`] = {
    why: note, ok: r.ok,
    error: r.ok ? null : why(r),
    parse_error: parseError,
    // Kept when it would not parse: an unparseable payload is the most useful thing here, because
    // it is the case the driver currently gets wrong.
    raw: parsed ? null : String(r.stdout || '').slice(0, 4000),
    data: parsed
  };
  console.error(`  ${r.ok ? 'ok  ' : 'FAIL'} ${object} ${method}${r.ok ? '' : ' — ' + why(r)}`);
}

// ---- vendor objects, by discovery rather than by guesswork -------------------------------------
for (const [object, note] of EXPLORE) {
  if (!capture.ubus_list.includes(object)) { capture.explored[object] = { note, present: false }; continue; }

  const methods = (capture.ubus_methods && capture.ubus_methods[object]) || null;
  if (!methods) { capture.explored[object] = { note, present: true, methods: null, reason: 'no signatures available' }; continue; }

  const entry = { note, present: true, methods: Object.keys(methods), signatures: methods, results: {} };
  console.error(`  -- ${object}: ${Object.keys(methods).join(', ') || '(no methods)'}`);

  for (const [name, sig] of Object.entries(methods)) {
    // Whether to call it, and if not, why not — decided in lib/ubusintrospect.js so the rule is
    // testable rather than buried in a script that only runs against real hardware.
    const plan = planMethodCall(name, sig);
    if (plan.skip) { entry.results[name] = { skipped: plan.skip, signature: sig }; continue; }
    const r = await run(['ubus', '-S', 'call', object, name]);
    let parsed = null;
    if (r.ok) { try { parsed = sanitise(JSON.parse(String(r.stdout).trim() || '{}')); } catch {} }
    entry.results[name] = {
      ok: r.ok, error: r.ok ? null : why(r), data: parsed,
      raw: parsed ? null : String(r.stdout || '').slice(0, 2000),
      // Recorded so a failure here is readable: if this errored, the omitted argument is the reason,
      // and the signature says what it wanted.
      args_omitted: plan.argsOmitted || null, signature: plan.argsOmitted ? sig : undefined
    };
    console.error(`     ${r.ok ? 'ok  ' : 'FAIL'} ${object} ${name}${plan.argsOmitted ? ` (without ${plan.argsOmitted.join(', ')})` : ''}${r.ok ? '' : ' — ' + why(r)}`);
  }
  capture.explored[object] = entry;
}

// Radios are per-device, so they can only be asked for once the list is known.
const radios = capture.calls['iwinfo.devices'];
if (radios && radios.data && Array.isArray(radios.data.devices)) {
  capture.calls.iwinfo_per_radio = {};
  for (const dev of radios.data.devices) {
    for (const method of ['info', 'assoclist']) {
      const r = await run(['ubus', '-S', 'call', 'iwinfo', method, JSON.stringify({ device: dev })]);
      let parsed = null; if (r.ok) { try { parsed = sanitise(JSON.parse(String(r.stdout).trim() || '{}')); } catch {} }
      capture.calls.iwinfo_per_radio[`${dev}.${method}`] = { ok: r.ok, error: r.ok ? null : r.error, data: parsed };
      console.error(`  ${r.ok ? 'ok  ' : 'FAIL'} iwinfo ${method} ${dev}`);
    }
  }
}

// `note`, not `why` — `why()` is the ubus-status translator above, and shadowing it here would be
// a silent trap for whoever edits this loop next.
for (const [argv, note] of SHELL) {
  const r = await run(argv);
  capture.shell[argv.join(' ')] = { why: note, ok: r.ok, error: r.ok ? null : r.error, output: String(r.stdout || '').slice(0, 8000) };
  console.error(`  ${r.ok ? 'ok  ' : 'FAIL'} ${argv.join(' ')}${r.ok ? '' : ' — ' + r.error}`);
}

console.log(JSON.stringify(capture, null, 2));
console.error('\nDone. The JSON is on stdout — redirect it to a file and share that.');
