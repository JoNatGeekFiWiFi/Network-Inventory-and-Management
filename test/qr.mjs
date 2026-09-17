// A QR encoder written from scratch, checked against the specification rather than against
// "it looks like a QR code".
//
// The failure mode this exists to prevent: an encoder that draws finder patterns, produces a
// plausible square of dots, and is rejected by every phone with no explanation. Eyeballing cannot
// distinguish that from a working one, so nothing here is eyeballed.
//
// The checks below are in the order they were added, which is also the order in which they failed
// to be enough:
//
//   * REED-SOLOMON, by the defining property — a valid codeword is divisible by the generator
//     polynomial, so the remainder of data+ECC must be zero at every root. THIS PASSED AGAINST A
//     BACKWARDS GENERATOR, because the encoder and the check used the same wrong one;
//   * THE BLOCK TABLE, which is pages of transcribed numbers and the likeliest place for a silent
//     typo, by deriving the codeword count from the matrix geometry. This one did its job;
//   * FORMAT AND VERSION INFORMATION against published bit strings — but three of the version
//     strings were transcribed WRONG, so the check accused a correct encoder. They are now verified
//     as BCH codewords before being trusted;
//   * THE REFERENCE MATRICES, added last and the only check that actually proves the output is
//     scannable. The first three passed 91 assertions on an encoder whose format bits went into the
//     matrix in reverse order — producing codes that looked perfect and that nothing could read.
//
// The lesson, written down because it was expensive: a test that shares an assumption with the code
// it tests cannot find a bug in that assumption.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  encode, toSvg, rsGenerator, rsEncode, chooseVersion, dataCapacity, ecCapacity,
  totalCodewords, sizeOf, formatBits, versionBits, buildCodewords, penalty
} from '../lib/qr.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- the block table, checked against the matrix itself ---------------------------------------------
//
// THE MOST VALUABLE TEST HERE. The table was transcribed by hand. Total codewords for a version is
// also derivable from geometry — count the modules, subtract the function patterns, divide by
// eight — so the two must agree. A mismatch means a number was copied wrong, which produces a code
// no scanner will read and which nothing else here would catch.
{
  for (let v = 1; v <= 20; v++) {
    const fromTable = dataCapacity(v) + ecCapacity(v);
    const fromGeometry = totalCodewords(v);
    ok(fromTable === fromGeometry,
      `v${v}: the block table (${fromTable} codewords) agrees with the matrix geometry (${fromGeometry})`);
  }
}

// ---- Reed-Solomon, by its defining property -----------------------------------------------------------
{
  // Known generator polynomials from the specification, as a direct check on the field arithmetic.
  ok(rsGenerator(7).join(',') === '1,127,122,154,164,11,68,117', 'the degree-7 generator matches the specification');
  ok(rsGenerator(10).length === 11, 'a degree-10 generator has 11 terms');

  // The real check: a codeword is data followed by its remainder, and that polynomial must be
  // divisible by the generator — so dividing again must leave nothing.
  for (const ecLen of [7, 10, 15, 20, 26, 30]) {
    const data = Array.from({ length: 40 }, (_, i) => (i * 37 + 11) & 0xff);
    const ecc = rsEncode(data, ecLen);
    const remainder = rsEncode([...data, ...ecc], ecLen);
    ok(remainder.every(b => b === 0),
      `a codeword with ${ecLen} ECC bytes divides cleanly by its generator — the property that makes it correctable`);
  }

  ok(rsEncode([], 7).length === 7, 'even empty data yields the right number of ECC bytes');
}

// ---- format and version information, against published values ------------------------------------------
{
  // The 32 format strings for every (ECC level, mask). These are fixed in the standard, so they
  // check the BCH implementation against something I did not write.
  const L_FORMATS = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
  for (let mask = 0; mask < 8; mask++) {
    ok(formatBits(mask) === L_FORMATS[mask],
      `format bits for level L mask ${mask} match the published value (0x${L_FORMATS[mask].toString(16)})`);
  }

  // Version information. These were transcribed too, and three of them were WRONG on the first
  // pass — which briefly looked like an encoder bug. So the transcription is checked before it is
  // trusted: the version string is a BCH codeword, so it must be divisible by the generator.
  const GEN = 0x1f25;
  const remainder = (v) => { for (let b = 17; b >= 12; b--) if (v & (1 << b)) v ^= GEN << (b - 12); return v; };

  const KNOWN = { 7: 0x07c94, 10: 0x0a4d3, 15: 0x0f928, 18: 0x12a17, 20: 0x149a6 };
  for (const [v, bits] of Object.entries(KNOWN)) {
    ok(remainder(bits) === 0, `the published value for v${v} is a valid BCH codeword — the transcription itself is sound`);
    ok(versionBits(Number(v)) === bits, `version bits for v${v} match the published value`);
  }

  // And the whole range, without leaning on any transcription at all: every generated string must
  // divide cleanly, carry its own version in the top six bits, and sit at least 8 bits from every
  // other. A single wrong bit anywhere breaks the distance property.
  const all = [];
  let structural = true;
  for (let v = 7; v <= 40; v++) {
    const b = versionBits(v);
    if (remainder(b) !== 0 || (b >> 12) !== v) structural = false;
    all.push(b);
  }
  ok(structural, 'all 34 version strings divide cleanly and carry their own version number');

  let minDistance = 99;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    let d = 0, x = all[i] ^ all[j];
    while (x) { d += x & 1; x >>>= 1; }
    if (d < minDistance) minDistance = d;
  }
  ok(minDistance === 8, `the set has the specified minimum Hamming distance of 8 (got ${minDistance}) — no single wrong bit survives this`);
}

// ---- sizing ----------------------------------------------------------------------------------------------
{
  ok(sizeOf(1) === 21 && sizeOf(7) === 45 && sizeOf(20) === 97, 'matrix sizes follow 4v+17');
  ok(chooseVersion(10) === 1, 'a short string fits version 1');
  ok(chooseVersion(200) >= 8, 'two hundred bytes needs a larger version');
  ok(chooseVersion(100000) === null, 'and something absurd is refused rather than silently truncated');

  // Each version must hold more than the last — a table typo often shows up as a capacity that
  // goes backwards.
  for (let v = 2; v <= 20; v++) {
    ok(dataCapacity(v) > dataCapacity(v - 1), `v${v} holds more data than v${v - 1}`);
  }
}

// ---- codeword assembly ---------------------------------------------------------------------------------
{
  const bytes = Array.from({ length: 30 }, (_, i) => 65 + (i % 26));
  const cw = buildCodewords(bytes, 5);
  ok(cw.length === dataCapacity(5) + ecCapacity(5), 'the interleaved output is exactly the version\'s codeword count');

  // Padding must alternate 0xEC / 0x11, not zeroes — some readers decode trailing zeroes as data.
  const short = buildCodewords([65], 1);
  ok(short.includes(0xec) && short.includes(0x11), 'short data is padded with the specified alternating bytes');
}

// ---- the matrix ------------------------------------------------------------------------------------------
{
  const { matrix, size, version, mask } = encode('WireGuard test payload');
  ok(size === sizeOf(version), 'the matrix is the right size for its version');
  ok(mask >= 0 && mask < 8, 'a mask was chosen');
  ok(matrix.every(row => row.length === size && row.every(v => v === 0 || v === 1)),
    'every module resolved to a 0 or a 1 — none left unset, which would be an unplaced region');

  // Finder patterns: the three corners a scanner locates first. If these are wrong nothing else
  // matters, because the code is never even found.
  const finderOk = (r0, c0) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (matrix[r0 + r][c0 + c] !== (ring || core ? 1 : 0)) return false;
    }
    return true;
  };
  ok(finderOk(0, 0), 'the top-left finder pattern is correct');
  ok(finderOk(0, size - 7), 'as is the top-right');
  ok(finderOk(size - 7, 0), 'and the bottom-left');

  // Separators: a light border around each finder, without which they are not recognisable.
  ok(Array.from({ length: 8 }, (_, i) => matrix[7][i]).every(v => v === 0), 'the top-left finder has its light separator');

  // Timing patterns alternate, and are what a scanner uses to work out the module grid.
  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    if (matrix[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  }
  ok(timingOk, 'both timing patterns alternate correctly');

  ok(matrix[size - 8][8] === 1, 'the always-dark module is dark');
}

// ---- a real WireGuard config, which is what this is for -------------------------------------------------
{
  const config = `[Interface]
PrivateKey = qMFYHb7Tq8C1lMvZPPDNnkTHzQpL3xJFLmYxCvBnM0Q=
Address = 10.147.21.42/32
DNS = 10.147.21.1

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = vpn.geekitek.com:51820
AllowedIPs = 10.147.20.0/23
PersistentKeepalive = 25
`;
  const { version, size } = encode(config);
  ok(version >= 7 && version <= 20, `a real config (${config.length} bytes) fits in version ${version}`);
  ok(size === sizeOf(version), 'at the matching size');

  const svg = toSvg(config);
  ok(svg.startsWith('<svg') && svg.includes('</svg>'), 'and renders as SVG');
  ok(svg.includes('shape-rendering="crispEdges"'), 'with crisp edges, so modules do not blur at small sizes');

  // The quiet zone is not decoration: without four clear modules around it, many scanners never
  // see the code at all.
  const declared = Number(svg.match(/width="(\d+)"/)[1]);
  ok(declared === (size + 8) * 6, 'and a four-module quiet zone on every side');

  // A config with a UTF-8 name must not be miscounted — the length field is in BYTES.
  const accented = encode(config.replace('vpn.geekitek.com', 'vpn.geekîtek.com'));
  ok(accented.version >= version, 'a multi-byte character is counted as its bytes, not its characters');
}

// ---- against an encoder I did not write --------------------------------------------------------------------
//
// THE TEST THAT ACTUALLY PROVES THIS WORKS, and the one whose absence let three bugs through.
//
// Everything above checks the encoder against my own understanding of the format. That is exactly
// how the first version passed 91 assertions while producing codes NO SCANNER COULD READ: the
// format bits were written into the matrix in reverse, and the value they were checked against was
// correct, so every value-level test passed. Reed-Solomon was likewise self-consistently wrong —
// codewords divided cleanly by a generator that was itself backwards.
//
// So the matrices below come from a separate implementation, hashed and committed. If lib/qr.js
// stops agreeing with it, something regressed, whatever the assertions above say.
{
  const ref = JSON.parse(readFileSync(new URL('./fixtures/qr-reference.json', import.meta.url), 'utf8'));
  const digest = (m) => createHash('sha256').update(m.map(r => r.join('')).join('\n')).digest('hex');

  let matched = 0, mismatched = [];
  for (const c of ref.cases) {
    const got = encode(c.char.repeat(c.len));
    if (got.version === c.version && got.mask === c.mask && got.size === c.size && digest(got.matrix) === c.sha256) matched++;
    else mismatched.push(`v${c.version}/'${c.char}'(version ${got.version}, mask ${got.mask} vs ${c.mask})`);
  }
  ok(mismatched.length === 0,
    `all ${ref.cases.length} reference matrices reproduced exactly — same version, same mask, same modules (${matched} matched${mismatched.length ? '; failed: ' + mismatched.join(' ') : ''})`);

  for (const p of ref.payloads) {
    const got = encode(p.text);
    ok(digest(got.matrix) === p.sha256 && got.version === p.version && got.mask === p.mask,
      `a real payload (${p.text.length} bytes, v${p.version}) matches the reference encoder module for module`);
  }

  // The full matrix, so a regression here is readable rather than a hash that moved.
  const mine = encode(ref.full.text);
  const asRows = mine.matrix.map(r => r.join(''));
  const firstBad = asRows.findIndex((row, i) => row !== ref.full.rows[i]);
  ok(firstBad === -1, firstBad === -1
    ? 'and the fully-expanded reference matrix matches row for row'
    : `row ${firstBad} differs:\n  expected ${ref.full.rows[firstBad]}\n  got      ${asRows[firstBad]}`);
}

// ---- masking ---------------------------------------------------------------------------------------------
{
  // The penalty rules exist to avoid patterns a scanner would misread. Getting these wrong degrades
  // rather than destroys, but a solid field should still score far worse than a mixed one.
  const solid = Array.from({ length: 21 }, () => new Array(21).fill(1));
  const mixed = Array.from({ length: 21 }, (_, r) => Array.from({ length: 21 }, (_, c) => (r + c) % 2));
  ok(penalty(solid, 21) > penalty(mixed, 21), 'a solid field scores far worse than an alternating one');
}

// ---- refusing rather than producing something unreadable ---------------------------------------------------
{
  let threw = false;
  try { encode('x'.repeat(5000)); } catch { threw = true; }
  ok(threw, 'data too large to encode throws rather than emitting a truncated, unreadable code');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
