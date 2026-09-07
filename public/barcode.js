// Barcode decoding, from scratch.
//
// Safari has never shipped the BarcodeDetector API, and every browser on iOS is WebKit, so on an
// iPhone there is no built-in way to read a label. The usual answer is a CDN-hosted library — but
// this app's whole purpose on a phone is working where the signal is bad, and a scanner that
// depends on fetching a megabyte from a CDN is a scanner that fails exactly when it is needed.
// So the decoder is here, vendored, offline, and tested.
//
// Scope is deliberate: Code 128 and Code 39 are what is actually printed on the serial and MAC
// labels of MikroTik gear and carrier equipment. QR is not covered — it is a far larger problem
// (Reed-Solomon, masking, version detection) and is rarer on the labels these techs scan. Where
// the browser DOES have BarcodeDetector (Android Chrome), the caller should prefer it, and this
// becomes the iOS path.
//
// Everything here is a pure function over numbers, so it is tested against synthesised barcodes
// rather than against a camera.

// ---- Code 128 -------------------------------------------------------------------------
//
// Each symbol is 11 modules wide, expressed as six element widths: bar, space, bar, space, bar,
// space. The stop pattern is the exception at 13 modules and seven elements.
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

const START_A = 103, START_B = 104, START_C = 105, STOP = 106;
const FNC3 = 96, FNC2 = 97, SHIFT = 98, CODE_C = 99, CODE_B = 100, CODE_A = 101, FNC4_A = 101, FNC1 = 102;

/** Code 128 value → character, for code sets A and B. */
function charFor(value, set) {
  if (set === 'C') return String(value).padStart(2, '0');
  if (set === 'B') return value < 95 ? String.fromCharCode(value + 32) : null;
  // Set A: 0-63 map to space..._ then 64-95 are control characters.
  if (value < 64) return String.fromCharCode(value + 32);
  if (value < 96) return String.fromCharCode(value - 64);
  return null;
}

// ---- Code 39 --------------------------------------------------------------------------
//
// Nine elements per character — five bars and four spaces — of which exactly three are wide.
// Self-checking by construction, which is why a plain ratio test is enough to read it.
export const CODE39_PATTERNS = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
  'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
  'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
  'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
  'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
  'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
};
const CODE39_BY_PATTERN = Object.fromEntries(Object.entries(CODE39_PATTERNS).map(([c, p]) => [p, c]));

// ---- turning pixels into element widths ------------------------------------------------

/**
 * Threshold one row of luminance and return the run lengths of alternating dark/light spans.
 *
 * A global threshold fails on a phone photo, where one end of the label is often twice as bright
 * as the other. So the threshold is local: the midpoint of the min and max within a sliding
 * window. That is cheap and copes with the uneven lighting of a torch held at an angle.
 *
 * @returns { runs, startsDark } — runs[0] is the first span, whatever colour it is.
 */
export function runsFromRow(luma, width, window = 40) {
  if (!luma || width < 8) return { runs: [], startsDark: false };

  // Rolling window min/max, recomputed every `step` pixels — exact enough and far cheaper than
  // per-pixel.
  const step = Math.max(1, Math.floor(window / 4));
  const thresh = new Uint8Array(width);
  for (let i = 0; i < width; i += step) {
    let lo = 255, hi = 0;
    const a = Math.max(0, i - window), b = Math.min(width, i + window);
    for (let j = a; j < b; j++) { const v = luma[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    // Too flat to hold a barcode: force everything light so no runs are produced.
    const t = (hi - lo) < 24 ? 0 : (lo + hi) >> 1;
    for (let j = i; j < Math.min(width, i + step); j++) thresh[j] = t;
  }

  const runs = [];
  const dark = i => luma[i] < thresh[i];
  const startsDark = dark(0);
  let cur = startsDark, len = 0;
  for (let i = 0; i < width; i++) {
    const d = dark(i);
    if (d === cur) len++;
    else { runs.push(len); cur = d; len = 1; }
  }
  runs.push(len);
  return { runs, startsDark };
}

/** Nearest-integer element widths for one symbol, given the module width. */
function quantise(runs, from, count, moduleWidth) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const w = Math.round(runs[from + i] / moduleWidth);
    if (w < 1 || w > 4) return null;         // no Code 128 element is wider than 4 modules
    out.push(w);
  }
  return out;
}

// ---- Code 128 decoding ------------------------------------------------------------------

const PATTERN_INDEX = (() => {
  const m = new Map();
  CODE128_PATTERNS.forEach((p, i) => { if (!m.has(p)) m.set(p, i); });
  return m;
})();

/**
 * Try to read a Code 128 symbol run starting at run index `start`, which must be a dark element.
 *
 * Symbols are collected first and interpreted only once the checksum agrees. Interpreting as we go
 * and validating afterwards was the first version, and it had to reason about whether the symbol
 * just consumed was data or the check digit — which is exactly the kind of off-by-one that yields
 * a plausible-looking wrong serial. A wrong serial filed against the wrong device is worse than no
 * read at all, so nothing is emitted until the barcode has proved itself.
 */
function tryDecode128(runs, start) {
  if (start + 6 > runs.length) return null;
  // The start symbol spans 11 modules across six elements, which sets the scale for the rest.
  let total = 0;
  for (let i = 0; i < 6; i++) total += runs[start + i];
  const moduleWidth = total / 11;
  if (moduleWidth < 0.7) return null;

  const first = quantise(runs, start, 6, moduleWidth);
  if (!first) return null;
  const startValue = PATTERN_INDEX.get(first.join(''));
  if (startValue !== START_A && startValue !== START_B && startValue !== START_C) return null;

  // ---- collect symbols up to the stop pattern ----
  const values = [];
  let i = start + 6, sawStop = false, end = 0;
  while (i + 6 <= runs.length) {
    if (i + 7 <= runs.length) {
      const stop = quantise(runs, i, 7, moduleWidth);
      if (stop && stop.join('') === CODE128_PATTERNS[STOP]) { sawStop = true; end = i + 7; break; }
    }
    const el = quantise(runs, i, 6, moduleWidth);
    if (!el) return null;
    const v = PATTERN_INDEX.get(el.join(''));
    if (v === undefined) return null;
    values.push(v);
    i += 6;
    if (values.length > 80) return null;              // longer than any label we will ever scan
  }
  if (!sawStop || values.length < 1) return null;

  // ---- checksum: start + sum(value * position), mod 103 ----
  const check = values.pop();
  let sum = startValue;
  values.forEach((v, idx) => { sum += v * (idx + 1); });
  if (sum % 103 !== check) return null;

  // ---- only now, turn symbols into text ----
  let set = startValue === START_A ? 'A' : startValue === START_B ? 'B' : 'C';
  let shifted = null, out = '';
  for (const value of values) {
    const active = shifted || set;
    shifted = null;
    if (active === 'C') {
      if (value < 100) { out += charFor(value, 'C'); continue; }
      if (value === CODE_B) { set = 'B'; continue; }
      if (value === CODE_A) { set = 'A'; continue; }
      if (value === FNC1) continue;
      return null;
    }
    if (value === CODE_C) { set = 'C'; continue; }
    if (value === SHIFT) { shifted = active === 'A' ? 'B' : 'A'; continue; }
    if (value === CODE_B && active === 'A') { set = 'B'; continue; }
    if (value === CODE_A && active === 'B') { set = 'A'; continue; }
    if (value === FNC1 || value === FNC2 || value === FNC3) continue;
    const ch = charFor(value, active);
    if (ch === null) return null;
    out += ch;
  }
  return out ? { text: out, format: 'code128', end } : null;
}

// ---- Code 39 decoding -------------------------------------------------------------------

function tryDecode39(runs, start) {
  // Nine elements per character plus a one-element gap between characters.
  if (start + 9 > runs.length) return null;
  let i = start, out = '';

  const readChar = (at) => {
    if (at + 9 > runs.length) return null;
    const slice = runs.slice(at, at + 9);
    // Wide vs narrow: the ratio is nominally 2:1 or 3:1, so split at the midpoint of the extremes.
    const lo = Math.min(...slice), hi = Math.max(...slice);
    if (hi / lo < 1.5) return null;              // no wide elements: not Code 39
    const cut = (lo + hi) / 2;
    const pat = slice.map(w => (w > cut ? 'w' : 'n')).join('');
    if ((pat.match(/w/g) || []).length !== 3) return null;
    return CODE39_BY_PATTERN[pat] || null;
  };

  if (readChar(i) !== '*') return null;          // must open with the start/stop character
  i += 10;                                        // 9 elements + inter-character gap

  while (i + 9 <= runs.length) {
    const ch = readChar(i);
    if (ch === null) return null;
    i += 10;
    if (ch === '*') return out.length ? { text: out, format: 'code39', end: i } : null;
    out += ch;
    if (out.length > 48) return null;
  }
  return null;
}

// ---- scanning a row ---------------------------------------------------------------------

/**
 * Read whatever barcode sits on this row of luminance.
 *
 * Tried at every dark run, in both directions, because a tech holds the phone at whatever angle
 * gets the label in frame and half the time the code is upside down.
 */
export function decodeRow(luma, width) {
  const { runs, startsDark } = runsFromRow(luma, width);
  if (runs.length < 15) return null;

  const attempt = (arr, darkFirst) => {
    for (let s = darkFirst ? 0 : 1; s + 6 <= arr.length; s += 2) {
      const r128 = tryDecode128(arr, s);
      if (r128 && r128.text) return r128;
      const r39 = tryDecode39(arr, s);
      if (r39 && r39.text) return r39;
    }
    return null;
  };

  const forward = attempt(runs, startsDark);
  if (forward) return forward;

  // Reversed: the last run becomes the first, so the colour of the leading run flips with parity.
  const rev = runs.slice().reverse();
  const revStartsDark = (runs.length % 2 === 1) ? startsDark : !startsDark;
  return attempt(rev, revStartsDark);
}

/**
 * Scan a frame.
 *
 * Only a band of rows through the middle is examined, and only every few rows: the label is
 * whatever the person has centred, and scanning every row of a 480-row frame would blow the frame
 * budget for no extra hit rate.
 *
 * @param data   RGBA bytes, as from canvas getImageData
 * @param width  frame width in pixels
 * @param height frame height in pixels
 */
export function scanFrame(data, width, height, { rows = 15, band = 0.6 } = {}) {
  const luma = new Uint8Array(width);
  const first = Math.max(0, Math.floor(height * (0.5 - band / 2)));
  const last = Math.min(height - 1, Math.floor(height * (0.5 + band / 2)));
  const stride = Math.max(1, Math.floor((last - first) / rows));

  for (let y = first; y <= last; y += stride) {
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      // Rec. 601 luma, integer-weighted: green dominates perceived brightness.
      luma[x] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    const hit = decodeRow(luma, width);
    if (hit) return { ...hit, row: y };
  }
  return null;
}

/**
 * Require the same value twice before believing it.
 *
 * Decoding a row of pure sensor noise yields a checksum-valid Code 128 roughly once in 3,000
 * attempts — which sounds negligible until you notice the scanner tries fifteen rows per frame,
 * ten times a second, so an unlucky read would land every half-minute of pointing at nothing.
 * A wrong serial silently attached to a device is precisely the failure this app exists to stop.
 *
 * Noise does not repeat; a real barcode does. So a value is only accepted once it has been seen
 * `needed` times in a row, which costs a tenth of a second and removes the whole class of error.
 */
export function createConfirmer(needed = 2) {
  let last = null, count = 0;
  return {
    /** @returns the value once it has been confirmed, else null. */
    offer(value) {
      if (value === null || value === undefined) { last = null; count = 0; return null; }
      if (value === last) count++; else { last = value; count = 1; }
      return count >= needed ? value : null;
    },
    reset() { last = null; count = 0; }
  };
}

// ---- encoding, for tests and for printing labels later ----------------------------------

/**
 * Render a string as Code 128 element widths, switching to subset C for runs of digits.
 *
 * Subset C packs two digits into one symbol. That is not a nicety: a serial like
 * "2CG5J1699600741" is 200 modules in subset B alone but 156 with C, which is 22% narrower — and
 * narrower is the difference between reading and not reading, because the limit on a phone is
 * pixels per module. Real equipment labels are encoded this way too, so generating them this way
 * also means the test card behaves like the thing it stands in for.
 */
export function encode128(text) {
  const str = String(text);
  const digitsFrom = (i) => { let n = 0; while (i + n < str.length && str[i + n] >= '0' && str[i + n] <= '9') n++; return n; };

  // Worth starting in C if the string opens with 4+ digits (2+ symbols saved), or is all digits.
  const lead = digitsFrom(0);
  let set = (lead >= 4 || (lead === str.length && lead >= 2 && lead % 2 === 0)) ? 'C' : 'B';
  const values = [set === 'C' ? START_C : START_B];

  let i = 0;
  while (i < str.length) {
    const run = digitsFrom(i);
    if (set === 'B') {
      // Switch into C when enough digits remain to pay for the switch symbol.
      if (run >= 4 || (run >= 2 && i + run === str.length && run % 2 === 0)) { values.push(CODE_C); set = 'C'; continue; }
      const v = str.charCodeAt(i) - 32;
      if (v < 0 || v > 94) throw new Error(`"${str[i]}" cannot be encoded in Code 128 subset B`);
      values.push(v); i++;
    } else {
      // In C, consume digit pairs; drop back to B for anything else or a lone trailing digit.
      if (run >= 2) { values.push(Number(str.slice(i, i + 2))); i += 2; }
      else { values.push(CODE_B); set = 'B'; }
    }
  }

  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  values.push(sum % 103, STOP);
  return values.flatMap(v => CODE128_PATTERNS[v].split('').map(Number));
}

/** Subset B only. Kept so tests can exercise the B path directly. */
export function encode128B(text) {
  const values = [START_B];
  for (const ch of String(text)) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) throw new Error(`"${ch}" cannot be encoded in Code 128 subset B`);
    values.push(v);
  }
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103, STOP);
  return values.flatMap(v => CODE128_PATTERNS[v].split('').map(Number));
}

/** The same for Code 39, which needs no checksum and wraps the data in '*'. */
export function encode39(text) {
  const chars = ['*', ...String(text).toUpperCase(), '*'];
  const widths = [];
  chars.forEach((c, idx) => {
    const pat = CODE39_PATTERNS[c];
    if (!pat) throw new Error(`"${c}" cannot be encoded in Code 39`);
    for (const e of pat) widths.push(e === 'w' ? 3 : 1);
    if (idx < chars.length - 1) widths.push(1);      // inter-character gap
  });
  return widths;
}

/** Element widths → a luminance row, so a test can decode a picture rather than a data structure. */
export function widthsToRow(widths, moduleWidth = 3, quiet = 20, { dark = 0, light = 255 } = {}) {
  const total = widths.reduce((n, w) => n + w, 0) * moduleWidth + quiet * 2;
  const row = new Uint8Array(total).fill(light);
  let x = quiet, isDark = true;
  for (const w of widths) {
    const px = w * moduleWidth;
    if (isDark) for (let i = 0; i < px; i++) row[x + i] = dark;
    x += px; isDark = !isDark;
  }
  return row;
}
