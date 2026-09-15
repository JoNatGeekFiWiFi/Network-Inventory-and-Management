// Strip identifying detail out of a device capture before it becomes a committed test fixture.
//
// This exists because the first version of it was written inline, by hand, and pinned to the exact
// values it happened to see: it rewrote `75.236.125.*` because that was the public IP that day. The
// carrier then re-assigned the device, the next capture came back on a different address, and the
// real public IP of a customer's connection went straight into a file destined for git. Nothing
// failed; the anonymiser simply did not recognise it.
//
// So nothing here matches a specific value. It matches CATEGORIES — anything publicly routable,
// anything shaped like a MAC, anything shaped like a key — and it is exercised by a test that reads
// the committed fixture back and fails if a real address is in it. An anonymiser nobody checks is
// an anonymiser that silently stops working.

/** RFC 1918, loopback, link-local, CGNAT and multicast: safe to keep, and useful to keep. */
export function isPrivateV4(ip) {
  const o = String(ip).split('.').map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a === 192 && b === 0) return true;                      // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;                      // 203.0.113.0/24 TEST-NET-3
  return false;
}

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const MAC = /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g;

/**
 * Anonymise a capture.
 *
 * Works on the serialised JSON so that nothing is missed by not knowing the shape — a vendor object
 * nobody has modelled still gets scrubbed. Mappings are consistent within one capture, so a device
 * that appears in three places keeps the same fake identity and the data stays coherent to read.
 *
 * @returns {{ json: object, replacedIps: number, replacedMacs: number, ssids: number }}
 */
export function anonymiseCapture(capture, { ssids = [] } = {}) {
  let s = JSON.stringify(capture);
  let replacedIps = 0, replacedMacs = 0, ssidHits = 0;

  // SSIDs first: a customer's network name is as identifying as their address, and it can contain
  // anything, including digits that later passes would mangle.
  for (const [i, name] of ssids.entries()) {
    if (!name) continue;
    const before = s;
    s = s.split(JSON.stringify(name).slice(1, -1)).join(i === 0 ? 'TestNet' : `TestNet-${i + 1}`);
    if (s !== before) ssidHits++;
  }

  // Any publicly routable address becomes one in TEST-NET-3 (203.0.113.0/24, reserved for exactly
  // this by RFC 5737). Private addresses are kept: 192.168.8.x is the shape the parsers are being
  // tested against, and it identifies nobody.
  const ipMap = new Map();
  s = s.replace(IPV4, (ip) => {
    if (isPrivateV4(ip)) return ip;
    if (!ipMap.has(ip)) { ipMap.set(ip, `203.0.113.${(ipMap.size % 254) + 1}`); replacedIps++; }
    return ipMap.get(ip);
  });

  // Every MAC, including the router's own: the OUI identifies the hardware vendor and the rest
  // identifies the unit. 02:00:00:* is locally-administered space, so these cannot collide with a
  // real device.
  const macMap = new Map();
  s = s.replace(MAC, (mac) => {
    const k = mac.toUpperCase();
    if (!macMap.has(k)) {
      const n = macMap.size + 1;
      macMap.set(k, `02:00:00:${hx(n >> 16)}:${hx(n >> 8)}:${hx(n)}`);
      replacedMacs++;
    }
    return macMap.get(k);
  });

  return { json: JSON.parse(s), replacedIps, replacedMacs, ssids: ssidHits };
}

const hx = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();

/**
 * Check a finished fixture for anything that should not have survived.
 *
 * The point of a separate checker: the anonymiser can only remove what it recognises, so the fixture
 * is verified independently rather than trusted because the function ran.
 *
 * @returns {string[]} findings, empty when clean
 */
export function auditFixture(text) {
  const problems = [];

  const publicIps = [...new Set((String(text).match(IPV4) || []).filter(ip => !isPrivateV4(ip)))];
  if (publicIps.length) problems.push(`publicly routable IP(s): ${publicIps.slice(0, 5).join(', ')}`);

  const macs = [...new Set((String(text).match(MAC) || []).map(m => m.toUpperCase()))]
    .filter(m => !m.startsWith('02:00:00:') && m !== '00:00:00:00:00:00');
  if (macs.length) problems.push(`real-looking MAC(s): ${macs.slice(0, 5).join(', ')}`);

  // A secret that is a VALUE, not a type name in a ubus method signature — "key":"String" is a
  // signature describing an argument, and flagging it would train people to ignore this check.
  const SIGNATURE_TYPES = /^(String|Integer|Boolean|Array|Table|Double|Int32|Int8|Int16|Int64|Unspecified)$/;
  for (const m of String(text).matchAll(/"(key|password|passwd|passphrase|psk|secret|token|private_key)"\s*:\s*"([^"]*)"/g)) {
    const v = m[2];
    if (v === '[removed]' || v === '' || SIGNATURE_TYPES.test(v)) continue;
    problems.push(`possible secret left in place: "${m[1]}": "${v.slice(0, 12)}…"`);
  }

  return problems;
}
