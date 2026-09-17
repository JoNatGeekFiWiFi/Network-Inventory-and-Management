// A QR encoder, because a technician standing at a router should be able to point a phone at the
// screen rather than email themselves a key.
//
// Written from scratch for the same reason as the xlsx writer and the barcode decoder: this
// codebase takes no native dependencies. QR is a real specification though, not a format you can
// approximate, and THE DANGEROUS FAILURE IS A CODE THAT LOOKS RIGHT AND IS NOT — the finder
// patterns draw, the thing looks like a QR code, and phones simply refuse it with no explanation.
//
// So three things here are verified rather than trusted:
//
//   * the Reed-Solomon implementation, by checking that data+ECC divides cleanly by the generator
//     polynomial, which is the defining property of a valid codeword;
//   * the block table, which is pages of transcribed numbers and the likeliest place for a silent
//     error, by deriving total codeword counts from the matrix geometry and checking the table
//     agrees;
//   * the format information, against the 32 published bit strings.
//
// Level L error correction throughout: these are read once, from a bright screen, at arm's length.
// The extra capacity buys smaller, denser codes rather than resilience nobody needs here.

// ---- GF(256), the field QR's error correction lives in --------------------------------------------
//
// Generated at load rather than written out: a 512-entry table is exactly the kind of thing that
// acquires a typo, and the generating polynomial (0x11d) is the part worth stating.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  // The loop above accumulates in ascending powers; the specification — and rsEncode below, which
  // treats gen[0] as the leading 1 — want descending. Returning the raw order here produced a
  // self-consistently WRONG encoder: every codeword still divided by the same wrong generator, so
  // the divisibility test passed while no scanner would have read the result. Only the published
  // degree-7 coefficients caught it.
  return poly.reverse();
}

/** Reed-Solomon remainder: the error-correction codewords for one block. */
export function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift(); res.push(0);
    if (factor !== 0) for (let i = 0; i < gen.length - 1; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---- how each version splits into blocks -----------------------------------------------------------
//
// [ec codewords per block, group-1 blocks, group-1 data codewords, group-2 blocks, group-2 data]
// Level L only. Transcribed from the specification and cross-checked by a test that derives the
// total codeword count from the matrix itself — see totalCodewords() below.
const EC_L = {
  1: [7, 1, 19, 0, 0], 2: [10, 1, 34, 0, 0], 3: [15, 1, 55, 0, 0], 4: [20, 1, 80, 0, 0],
  5: [26, 1, 108, 0, 0], 6: [18, 2, 68, 0, 0], 7: [20, 2, 78, 0, 0], 8: [24, 2, 97, 0, 0],
  9: [30, 2, 116, 0, 0], 10: [18, 2, 68, 2, 69], 11: [20, 4, 81, 0, 0], 12: [24, 2, 92, 2, 93],
  13: [26, 4, 107, 0, 0], 14: [30, 3, 115, 1, 116], 15: [22, 5, 87, 1, 88], 16: [24, 5, 98, 1, 99],
  17: [28, 1, 107, 5, 108], 18: [30, 5, 120, 1, 121], 19: [28, 3, 113, 4, 114], 20: [28, 3, 107, 5, 108]
};

/** Where the alignment patterns sit, per version. Empty for version 1, which has none. */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
  9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90]
};

export const sizeOf = (version) => version * 4 + 17;
export const dataCapacity = (version) => {
  const [ec, g1, d1, g2, d2] = EC_L[version];
  return g1 * d1 + g2 * d2;
};
export const ecCapacity = (version) => {
  const [ec, g1, , g2] = EC_L[version];
  return (g1 + g2) * ec;
};

/**
 * How many codewords a version holds, derived from the matrix rather than looked up.
 *
 * This exists to check the block table above. Count every module, subtract the function patterns
 * that cannot carry data, divide by eight. If that disagrees with data + ecc from the table, a
 * number was transcribed wrong — which is the failure that produces a code no phone will read.
 */
export function totalCodewords(version) {
  const size = sizeOf(version);
  let functionModules = 0;

  // Three finder patterns with their separators: 8x8 each including the separator strip.
  functionModules += 3 * 64;
  // Timing patterns, minus the parts already inside the finder areas.
  functionModules += 2 * (size - 16);
  // The dark module beside the lower-left finder.
  functionModules += 1;
  // Format information: 15 bits, stored twice — 30 modules. The 31st position in that band is the
  // dark module, already counted on the line above; counting it here too inflated every version by
  // one module, which Math.floor then hid on all but eight of them.
  functionModules += 30;
  // Version information on version 7 and above: 18 bits, twice.
  if (version >= 7) functionModules += 36;

  // Alignment patterns: 5x5 each, skipping the three that collide with finders, and discounting
  // the modules each one shares with a timing pattern.
  const centres = ALIGN[version];
  if (centres.length) {
    const n = centres.length;
    const count = n * n - 3;                         // corners occupied by finders
    functionModules += count * 25;
    // The ones sitting on a timing row/column overlap it by 5 modules each.
    const onTiming = 2 * (n - 2);
    functionModules -= onTiming * 5;
  }

  return Math.floor((size * size - functionModules) / 8);
}

/** The smallest version that will hold `byteLength` bytes in byte mode. */
export function chooseVersion(byteLength) {
  for (let v = 1; v <= 20; v++) {
    // Mode indicator (4 bits) + length field + the data itself, in whole codewords.
    const lengthBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + byteLength * 8) / 8);
    if (needed <= dataCapacity(v)) return v;
  }
  return null;
}

// ---- turning bytes into codewords -------------------------------------------------------------------

function toCodewords(bytes, version) {
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); };

  push(0b0100, 4);                                   // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  // Terminator: up to four zero bits, or fewer if the capacity is nearly full.
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // Pad alternately with 0xEC and 0x11, as the specification requires — not with zeroes, which
  // would decode as data on some readers.
  const pad = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCapacity(version); i++) codewords.push(pad[i % 2]);
  return codewords;
}

/**
 * Split into blocks, compute ECC, and interleave.
 *
 * The interleaving is the part that is easy to get subtly wrong and impossible to eyeball: data
 * codewords are taken one from each block in turn, then all the ECC the same way. A version with
 * two group sizes reads past the end of the shorter blocks, which is why the inner loop checks.
 */
export function buildCodewords(bytes, version) {
  const [ecLen, g1, d1, g2, d2] = EC_L[version];
  const data = toCodewords(bytes, version);

  const blocks = [], eccs = [];
  let at = 0;
  for (let i = 0; i < g1; i++) { const b = data.slice(at, at + d1); at += d1; blocks.push(b); eccs.push(rsEncode(b, ecLen)); }
  for (let i = 0; i < g2; i++) { const b = data.slice(at, at + d2); at += d2; blocks.push(b); eccs.push(rsEncode(b, ecLen)); }

  const out = [];
  const maxData = Math.max(d1, d2 || 0);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

// ---- the matrix ---------------------------------------------------------------------------------------

function blankMatrix(size) {
  return { m: Array.from({ length: size }, () => new Array(size).fill(null)), size };
}

function placeFinders(g) {
  const put = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= g.size || cc >= g.size) continue;
      const inRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const inSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      g.m[rr][cc] = (inRing || inSide || inCore) ? 1 : 0;
    }
  };
  put(0, 0); put(0, g.size - 7); put(g.size - 7, 0);
}

function placeTiming(g) {
  for (let i = 8; i < g.size - 8; i++) {
    const on = i % 2 === 0 ? 1 : 0;
    if (g.m[6][i] === null) g.m[6][i] = on;
    if (g.m[i][6] === null) g.m[i][6] = on;
  }
}

function placeAlignment(g, version) {
  const centres = ALIGN[version];
  for (const r of centres) for (const c of centres) {
    // Skip the three that would sit on top of a finder pattern.
    if ((r === 6 && c === 6) || (r === 6 && c === g.size - 7) || (r === g.size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
      g.m[r + dr][c + dc] = on;
    }
  }
}

/** Reserve the format and version areas so data placement skips them. */
function reserveMeta(g, version) {
  for (let i = 0; i < 9; i++) {
    if (g.m[8][i] === null) g.m[8][i] = 0;
    if (g.m[i][8] === null) g.m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (g.m[8][g.size - 1 - i] === null) g.m[8][g.size - 1 - i] = 0;
    if (g.m[g.size - 1 - i][8] === null) g.m[g.size - 1 - i][8] = 0;
  }
  g.m[g.size - 8][8] = 1;                                  // the always-dark module
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      if (g.m[r][g.size - 11 + c] === null) g.m[r][g.size - 11 + c] = 0;
      if (g.m[g.size - 11 + c][r] === null) g.m[g.size - 11 + c][r] = 0;
    }
  }
}

/** Walk the data in the specified zigzag, skipping column 6 (the vertical timing pattern). */
function placeData(g, codewords) {
  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };
  let upward = true;
  for (let col = g.size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                                  // the timing column carries no data
    for (let i = 0; i < g.size; i++) {
      const row = upward ? g.size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (g.m[row][c] === null) g.m[row][c] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/**
 * Penalty score, used to choose a mask.
 *
 * The four rules exist to avoid patterns a scanner would misread — long runs, solid blocks, and
 * anything resembling a finder pattern in the data area. Getting the weights wrong does not break
 * the code, it just picks a worse mask, so this is the one part here where an error degrades
 * rather than destroys.
 */
export function penalty(m, size) {
  let score = 0;

  // Rule 1: runs of five or more of the same colour.
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map(row => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // Rule 3: the 1:1:3:1:1 finder-like sequence with four light modules either side.
  const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pat) => pat.every((p, k) => line[at + k] === p);
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map(r => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(row, j, PAT1) || matches(row, j, PAT2)) score += 40;
      if (matches(col, j, PAT1) || matches(col, j, PAT2)) score += 40;
    }
  }
  // Rule 4: deviation from an even balance of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Format information: 5 bits of ECC level and mask, BCH(15,5), XORed with the fixed pattern. */
export function formatBits(maskIndex) {
  const data = (0b01 << 3) | maskIndex;                    // 01 = level L
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0b10100110111);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

/** Version information for version 7 and above: BCH(18,6). */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0b1111100100101);
  return (version << 12) | rem;
}

function placeFormat(g, maskIndex) {
  const bits = formatBits(maskIndex);
  const bit = (i) => (bits >> i) & 1;
  // The 15-bit value is correct — it matches the published strings — but it goes into the matrix
  // MOST significant bit first, and this originally wrote it least significant bit first. The code
  // then carried a valid mask and valid data under a format field that named the wrong mask, so no
  // scanner could unmask it. Nothing in the unit tests could see this: they checked the VALUE.
  //
  // Copy one, wrapped around the top-left finder. (8,0) holds bit 14.
  for (let i = 0; i <= 5; i++) g.m[8][i] = bit(14 - i);
  g.m[8][7] = bit(8); g.m[8][8] = bit(7); g.m[7][8] = bit(6);
  for (let r = 0; r <= 5; r++) g.m[r][8] = bit(r);

  // Copy two, split between the other two finders — and also most significant bit first, which the
  // first version of this fix missed because format info is BCH-protected: a decoder corrects the
  // three wrong bits and reads the code anyway. It decoded while still being wrong, spending error
  // correction budget that exists for dirt and glare on a lens.
  // The column carries bits 14..8, the row picks up at bit 7 and runs down to bit 0.
  for (let i = 0; i <= 6; i++) g.m[g.size - 1 - i][8] = bit(14 - i);
  for (let j = 0; j <= 7; j++) g.m[8][g.size - 8 + j] = bit(7 - j);
  g.m[g.size - 8][8] = 1;
}

function placeVersion(g, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    g.m[r][g.size - 11 + c] = b;
    g.m[g.size - 11 + c][r] = b;
  }
}

/**
 * Encode text into a QR matrix.
 *
 * @returns {{ matrix: number[][], size: number, version: number, mask: number }}
 */
export function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = chooseVersion(bytes.length);
  if (!version) throw new Error(`${bytes.length} bytes is too long for a QR code at this error-correction level`);

  const codewords = buildCodewords(bytes, version);
  const size = sizeOf(version);

  // Which modules are function patterns is decided BEFORE data goes in, because masking must not
  // touch them — a mask applied over a finder pattern makes the code unfindable.
  const reserved = blankMatrix(size);
  placeFinders(reserved); placeTiming(reserved); placeAlignment(reserved, version); reserveMeta(reserved, version);
  const isFunction = reserved.m.map(row => row.map(v => v !== null));

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = blankMatrix(size);
    placeFinders(g); placeTiming(g); placeAlignment(g, version); reserveMeta(g, version);
    placeData(g, codewords);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!isFunction[r][c] && MASKS[mask](r, c)) g.m[r][c] ^= 1;
    }
    placeFormat(g, mask); placeVersion(g, version);
    const score = penalty(g.m, size);
    if (!best || score < best.score) best = { score, matrix: g.m, mask };
  }
  return { matrix: best.matrix, size, version, mask: best.mask };
}

/**
 * Render as SVG.
 *
 * SVG rather than a canvas because it scales to any screen without blurring, prints correctly, and
 * is just markup — no client-side drawing code, and it survives being put straight into the page.
 * The quiet zone is four modules, as the specification requires; without it many scanners simply
 * will not see the code.
 */
export function toSvg(text, { moduleSize = 6, quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const { matrix, size } = encode(text);
  const total = (size + quiet * 2) * moduleSize;

  // One path for every dark module, which keeps the markup small even at version 15.
  let d = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (matrix[r][c]) d += `M${(c + quiet) * moduleSize} ${(r + quiet) * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
