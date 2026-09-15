#!/usr/bin/env node
//
// Ask one router what it is and what it will let us do.
//
//   node tools/probe-device.mjs 10.147.21.14 --user root --pass 'thepassword'
//   node tools/probe-device.mjs 10.147.21.14 --user root --pass '...' --json > katalyst.json
//
// Run it from the server (or anywhere on the management overlay). It is read-only: it opens
// connections, logs in, and reads. It never writes to the device.
//
// The point of this tool is to replace assumptions with observations before a driver gets written.
// Run it against one Katalyst Spark and the output says whether the vendor left ubus reachable over
// HTTP, whether SSH works, and exactly which ubus objects the login is allowed to call — which is
// everything needed to decide what monitoring can honestly offer.
//
// If a build turns out to differ, capture the JSON (`--json`) and keep it: the driver's parsers are
// tested against captured output, so a new vendor quirk becomes a test case rather than a surprise.

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { probeDevice } from '../lib/probe.js';
import { sshExec } from '../lib/sshexec.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['user', 'pass', 'ssh-user']);
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : d; };

// Find the address: the first bare argument that is not itself the value of a --flag. Doing this
// by tracking which positions a flag consumed, rather than by "the first thing without dashes",
// so that `--pass 10.0.0.1` cannot be mistaken for the host.
const host = (() => {
  const consumed = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && VALUE_FLAGS.has(args[i].slice(2))) consumed.add(i + 1);
  }
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--') && !consumed.has(i)) return args[i];
  }
  return null;
})();

if (!host || args.includes('--help')) {
  console.log(`Usage: node tools/probe-device.mjs <address> [--user root] [--pass secret] [--ssh-user root] [--json]

Reports which management interfaces a router exposes, and suggests which platform
driver it should be assigned in the inventory. Read-only.`);
  process.exit(host ? 0 : 1);
}

/** Is anything listening? A short timeout, because six ports are probed in parallel. */
function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const done = (open, reason) => { if (settled) return; settled = true; s.destroy(); resolve({ open, reason }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false, 'no answer (filtered or down)'));
    s.once('error', (e) => done(false, e.code === 'ECONNREFUSED' ? 'refused (nothing listening)' : (e.code || e.message)));
    s.connect(port, host);
  });
}

/**
 * One HTTP request.
 *
 * TLS verification is off on purpose: every one of these devices ships a self-signed certificate
 * for its own LAN address, so verifying would fail on all of them and prove nothing. The connection
 * runs inside the management overlay, which is what actually provides the trust here.
 */
function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      method, headers: { ...headers },
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: timeoutMs,
      ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {})
    };
    if (body) opts.headers['content-length'] = Buffer.byteLength(body);
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => { if (data.length < 512 * 1024) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timed out' }); });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
}

const result = await probeDevice(
  { host, username: flag('user', 'root'), password: flag('pass', ''), sshUsername: flag('ssh-user') },
  { tcpProbe, httpRequest, sshExec }
);

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.suggested ? 0 : 1);
}

const tick = (b) => (b ? '  ok  ' : '  --  ');
console.log(`\nProbing ${host}\n${'='.repeat(40 + host.length)}`);
for (const f of result.findings) console.log(`[${tick(f.ok)}] ${f.check.padEnd(28)} ${f.detail}`);

if (result.board) {
  console.log('\nDevice reports itself as:');
  for (const [k, v] of Object.entries(result.board)) if (v) console.log(`  ${k.padEnd(14)} ${v}`);
}
if (result.grantedObjects) {
  console.log(`\nubus objects this login may call: ${result.grantedObjects.join(', ') || '(none)'}`);
}

console.log(`\n${result.summary}`);
if (result.suggested) {
  console.log(`\n  Platform:   ${result.suggested}`);
  console.log(`  Transport:  ${result.transport}`);
  console.log(`  Confidence: ${result.confidence}`);
} else {
  console.log('\n  No platform could be determined from what answered.');
}
console.log('');
process.exit(result.suggested ? 0 : 1);
