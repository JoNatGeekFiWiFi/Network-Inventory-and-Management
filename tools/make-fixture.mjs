#!/usr/bin/env node
//
// Turn a raw device capture into a committable test fixture.
//
//   node tools/make-fixture.mjs capture-k500a.json test/fixtures/katalyst-k500a.json
//
// A raw capture holds the customer's SSID, every client MAC, and the public IP their carrier
// assigned. None of that can go into git. This extracts the parts the parsers are tested against,
// anonymises them, and then AUDITS THE RESULT and refuses to write if anything identifying survived.
//
// The audit is not belt-and-braces. The first version of this was an ad-hoc command that rewrote
// one hardcoded IP prefix; the carrier re-assigned the device, the next capture came back on a
// different address, and the real one went into the file with nothing to notice. A rule that is
// remembered gets forgotten; a rule that is checked does not.

import { readFileSync, writeFileSync } from 'node:fs';
import { anonymiseCapture, auditFixture } from '../lib/anonymise.js';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('Usage: node tools/make-fixture.mjs <capture.json> <test/fixtures/name.json>');
  process.exit(1);
}

const c = JSON.parse(readFileSync(src, 'utf8'));
const call = (k) => (c.calls && c.calls[k] ? c.calls[k].data : null);
const explored = (obj, method) => {
  const e = c.explored && c.explored[obj];
  const r = e && e.results && e.results[method];
  return r && r.ok ? r.data : null;
};

const fixture = {
  device: (call('system.board') || {}).model || 'unknown',
  release: ((call('system.board') || {}).release || {}).description || 'unknown',
  note: 'Captured from a live unit. SSIDs, MACs and public IPs are anonymised by tools/make-fixture.mjs — do not hand-edit real values back in.',
  ubus_list: c.ubus_list,
  ubus_methods: c.ubus_methods,
  board: call('system.board'),
  info: call('system.info'),
  device_status: call('network.device.status'),
  interface_dump: call('network.interface.dump'),
  iwinfo_devices: call('iwinfo.devices'),
  iwinfo: {},
  wireless_status: explored('network.wireless', 'status'),
  gl_clients: explored('gl-clients', 'list'),
  gl_cloud: explored('gl-cloud', 'status'),
  modem_signal: explored('modem.signal', 'get_signals'),
  luci_leases: call('luci-rpc.getDHCPLeases'),
  leases_file: (c.shell && c.shell['cat /tmp/dhcp.leases'] || {}).output || '',
  // What each vendor object offers, and what was skipped — the inventory is the useful part, not
  // the payloads, which are mostly device-specific noise.
  explored_summary: Object.fromEntries(Object.entries(c.explored || {}).map(([k, v]) => [k, {
    present: v.present, methods: v.methods || null, signatures: v.signatures || null
  }]))
};
for (const [k, v] of Object.entries((c.calls && c.calls.iwinfo_per_radio) || {})) fixture.iwinfo[k] = v.data;

// gl-clients carries a 60-sample rolling counter history per client. Megabytes of numbers that no
// parser reads, and they make every future diff of this file unreadable.
for (const cl of Object.values((fixture.gl_clients && fixture.gl_clients.clients) || {})) {
  delete cl.last_rx; delete cl.last_tx;
}

// Collect the SSIDs to replace from wherever they appear, rather than being told them.
const ssids = new Set();
for (const r of Object.values(fixture.iwinfo || {})) if (r && r.ssid) ssids.add(r.ssid);
for (const radio of Object.values(fixture.wireless_status || {})) {
  for (const i of (radio && radio.interfaces) || []) if (i.config && i.config.ssid) ssids.add(i.config.ssid);
}

const { json, replacedIps, replacedMacs } = anonymiseCapture(fixture, { ssids: [...ssids] });
const text = JSON.stringify(json, null, 1);

const problems = auditFixture(text);
if (problems.length) {
  console.error('REFUSING TO WRITE — identifying data survived anonymisation:\n');
  for (const p of problems) console.error('  * ' + p);
  console.error('\nFix lib/anonymise.js to recognise it, then re-run. Nothing was written.');
  process.exit(1);
}

writeFileSync(dest, text);
console.log(`Wrote ${dest} — ${(text.length / 1024).toFixed(1)} KB`);
console.log(`  ${replacedIps} public IP(s) and ${replacedMacs} MAC(s) replaced, ${ssids.size} SSID(s) renamed`);
console.log('  audit: clean');
