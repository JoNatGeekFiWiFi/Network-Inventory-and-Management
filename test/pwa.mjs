// The barcode decoder, and everything that makes this installable on a phone.
//
// The decoder gets the harder half of this file. It is the one piece here with no server to check
// its work: a misread serial does not fail loudly, it quietly files a router against the wrong
// customer. So it is tested against synthesised barcodes under the conditions a phone camera
// actually produces — blur, uneven light, sensor noise, upside down — and, just as importantly,
// against inputs that are NOT barcodes, because a confident wrong answer is the real danger.
import {
  CODE128_PATTERNS, CODE39_PATTERNS, decodeRow, runsFromRow, scanFrame,
  encode128B, encode39, widthsToRow, createConfirmer
} from '../public/barcode.js';
import { readFileSync } from 'node:fs';

const B = process.env.BASE ?? 'http://localhost:3000';
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const get = async (p) => { const r = await fetch(B + p); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };

// ---- the symbology tables themselves ----
//
// A single mistyped digit in a 107-entry table would decode a handful of characters wrongly and
// nothing else would notice. Both tables have structural invariants, so assert them.
{
  const wrongWidth = CODE128_PATTERNS
    .map((p, i) => [i, p, p.split('').reduce((n, c) => n + Number(c), 0)])
    .filter(([i, , sum]) => sum !== (i === 106 ? 13 : 11));
  ok(wrongWidth.length === 0, `every Code 128 pattern is 11 modules (stop 13)${wrongWidth.length ? ' — ' + JSON.stringify(wrongWidth.slice(0, 3)) : ''}`);
  ok(CODE128_PATTERNS.length === 107, 'there are 107 Code 128 symbols');
  ok(new Set(CODE128_PATTERNS).size === 107, 'and none is duplicated, so no symbol is ambiguous');

  const bad39 = Object.entries(CODE39_PATTERNS).filter(([, p]) => p.length !== 9 || (p.match(/w/g) || []).length !== 3);
  ok(bad39.length === 0, 'every Code 39 pattern is nine elements with exactly three wide');
  ok(new Set(Object.values(CODE39_PATTERNS)).size === Object.keys(CODE39_PATTERNS).length,
    'and none is duplicated');
  ok(!!CODE39_PATTERNS['*'], 'the start/stop character is present');
}

// ---- round trips ----
const REAL = [
  '2CG5J1699600741',      // a MikroTik serial from the real inventory
  '1AK541334700985',
  '1C937CF4A003',         // a MAC as printed: no separators
  'AABBCC112233',
  '8502065851706',        // a Cox account number
  'MOBSN-0001'
];
{
  for (const s of REAL) {
    const row = widthsToRow(encode128B(s), 3);
    const r = decodeRow(row, row.length);
    ok(r && r.text === s && r.format === 'code128', `Code 128 round trip: ${s}`);
  }
  for (const s of ['2CG5J1699600741', 'MOBSN-0001', 'ABC123']) {
    const row = widthsToRow(encode39(s), 3);
    const r = decodeRow(row, row.length);
    ok(r && r.text === s && r.format === 'code39', `Code 39 round trip: ${s}`);
  }
  // Characters that exist in one symbology and not the other.
  ok(decodeRow(...(() => { const w = widthsToRow(encode128B('hAP ax2 v7.1'), 3); return [w, w.length]; })())?.text === 'hAP ax2 v7.1',
    'Code 128 carries lower case and punctuation');
  let threw = false;
  try { encode39('lower'); } catch { threw = true; }
  ok(!threw, 'Code 39 accepts letters case-insensitively');
  threw = false;
  try { encode128B('café'); } catch { threw = true; }
  ok(threw, 'a character Code 128 subset B cannot carry is refused rather than mangled');
}

// ---- the conditions a phone camera actually produces ----
{
  const S = '2CG5J1699600741';
  const clean = () => widthsToRow(encode128B(S), 4);
  const reads = (row) => { const r = decodeRow(row, row.length); return r && r.text === S; };

  ok(reads(clean()), 'a clean label reads');
  ok(reads(Uint8Array.from(clean()).reverse()), 'and so does one held upside down');

  const blur = (row, k) => {
    const o = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) {
      let sum = 0, n = 0;
      for (let j = -k; j <= k; j++) { const x = i + j; if (x >= 0 && x < row.length) { sum += row[x]; n++; } }
      o[i] = sum / n;
    }
    return o;
  };
  for (const k of [1, 2, 3]) ok(reads(blur(clean(), k)), `out of focus, radius ${k}`);

  // A torch held at an angle: one end of the label far brighter than the other. This is the case
  // a single global threshold gets wrong, which is why the threshold is local.
  const gradient = (row) => {
    const o = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) {
      const f = 0.35 + 0.65 * (i / row.length);
      o[i] = Math.min(255, Math.round(row[i] * f + 70 * (1 - f)));
    }
    return o;
  };
  ok(reads(gradient(clean())), 'lit unevenly across the label');
  ok(reads(blur(gradient(clean()), 2)), 'lit unevenly AND out of focus');

  const noise = (row, amp) => {
    const o = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) o[i] = Math.max(0, Math.min(255, row[i] + (Math.random() * 2 - 1) * amp));
    return o;
  };
  for (const amp of [10, 25, 40]) ok(reads(noise(clean(), amp)), `sensor noise +/-${amp}`);

  // A worn grey label under poor light.
  const lowContrast = (row) => {
    const o = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) o[i] = Math.round(90 + row[i] * 0.45);
    return o;
  };
  ok(reads(lowContrast(clean())), 'low contrast');

  // Printed text either side of the barcode, which is what every real label has.
  const clutter = (row) => {
    const junk = Uint8Array.from({ length: 60 }, (_, i) => (i % 7 < 3 ? 40 : 230));
    const o = new Uint8Array(junk.length * 2 + row.length);
    o.set(junk, 0); o.set(row, junk.length); o.set(junk, junk.length + row.length);
    return o;
  };
  ok(reads(clutter(clean())), 'surrounded by other printing');

  for (const m of [1, 2, 4, 8]) {
    const row = widthsToRow(encode128B(S), m);
    ok(decodeRow(row, row.length)?.text === S, `at ${m} pixels per module`);
  }
}

// ---- what must NOT be read ----
//
// The failure that matters is not "did not scan" — the tech just tries again. It is a confident
// wrong answer, which files a serial against the wrong device and is never noticed.
{
  let falseReads = 0;
  for (let i = 0; i < 1500; i++) {
    const w = 200 + Math.floor(Math.random() * 400);
    const row = new Uint8Array(w);
    for (let x = 0; x < w; x++) row[x] = Math.random() * 255;
    if (decodeRow(row, w)) falseReads++;
  }
  // Not zero: a checksum-valid symbol does occur by chance. It has to be rare enough that the
  // two-frame confirmation below reduces it to nothing.
  ok(falseReads <= 5, `random noise almost never decodes (${falseReads} in 1500 rows)`);

  let stripes = 0;
  for (let i = 0; i < 800; i++) {
    const w = 400, period = 2 + Math.floor(Math.random() * 9);
    const row = new Uint8Array(w);
    for (let x = 0; x < w; x++) row[x] = (x % period) < period / 2 ? 30 : 225;
    if (decodeRow(row, w)) stripes++;
  }
  ok(stripes === 0, 'evenly spaced stripes — a grille, a radiator, printed text — never decode');

  const blank = new Uint8Array(400).fill(240);
  ok(decodeRow(blank, 400) === null, 'a blank frame decodes to nothing');
  ok(decodeRow(new Uint8Array(4), 4) === null, 'a frame too small to hold a barcode is rejected');
  ok(runsFromRow(null, 0).runs.length === 0, 'no input is handled without throwing');

  // A Code 128 whose checksum has been corrupted must be refused, not guessed at.
  const widths = encode128B('MOBSN-0001');
  const broken = widths.slice();
  const at = broken.length - 12;                       // inside the check symbol
  broken[at] = broken[at] === 1 ? 2 : 1;
  const row = widthsToRow(broken, 4);
  const got = decodeRow(row, row.length);
  ok(!got || got.text !== 'MOBSN-0001', 'a corrupted check digit is not silently accepted');
}

// ---- confirmation across frames ----
{
  const c = createConfirmer(2);
  ok(c.offer('ABC') === null, 'one sighting is not enough');
  ok(c.offer('ABC') === 'ABC', 'two agreeing sightings are');
  const d = createConfirmer(2);
  d.offer('ABC');
  ok(d.offer('XYZ') === null && d.offer('XYZ') === 'XYZ', 'a different value restarts the count');
  const e = createConfirmer(2);
  e.offer('ABC');
  ok(e.offer(null) === null && e.offer('ABC') === null, 'a frame with nothing in it breaks the run');

  // The point of it: noise does not repeat.
  let survived = 0;
  for (let trial = 0; trial < 1500; trial++) {
    const conf = createConfirmer(2);
    let accepted = null;
    for (let frame = 0; frame < 2 && !accepted; frame++) {
      const w = 400, row = new Uint8Array(w);
      for (let x = 0; x < w; x++) row[x] = Math.random() * 255;
      const r = decodeRow(row, w);
      accepted = conf.offer(r ? r.text : null);
    }
    if (accepted) survived++;
  }
  ok(survived === 0, `no false read survives two-frame confirmation (${survived} in 1500)`);
}

// ---- a whole camera frame ----
{
  const row = widthsToRow(encode128B('MOBSN-0001'), 3);
  const W = row.length, H = 120;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (y > 40 && y < 80) ? row[x] : 245;      // the label occupies a band, as on screen
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const hit = scanFrame(data, W, H);
  ok(hit && hit.text === 'MOBSN-0001', 'a synthetic camera frame is decoded');
  ok(hit && hit.row > 40 && hit.row < 80, 'and reports which row it was found on');

  const empty = new Uint8ClampedArray(W * H * 4).fill(240);
  ok(scanFrame(empty, W, H) === null, 'an empty frame yields nothing');

  // Off to one side and rotated 180 — both normal when someone is holding a phone over a router.
  const flipped = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = (y > 40 && y < 80) ? row[W - 1 - x] : 245;
    const i = (y * W + x) * 4;
    flipped[i] = flipped[i + 1] = flipped[i + 2] = v; flipped[i + 3] = 255;
  }
  ok(scanFrame(flipped, W, H)?.text === 'MOBSN-0001', 'a frame held upside down is decoded');
}

// ---- served as an installable app ----
{
  const m = await get('/manifest.webmanifest');
  ok(m.status === 200, 'the manifest is served');
  ok(m.type.includes('manifest+json') || m.type.includes('json'), 'with a JSON content type');
  let mf = null; try { mf = JSON.parse(m.text); } catch {}
  ok(!!mf, 'and is valid JSON');
  ok(mf.display === 'standalone', 'it asks to open standalone, not in a browser tab');
  ok(mf.start_url === '/' && mf.scope === '/', 'scoped to the whole app');
  ok(Array.isArray(mf.icons) && mf.icons.length >= 2, 'with icons');
  ok(mf.icons.some(i => i.purpose === 'maskable'), 'including a maskable one, or Android crops the artwork badly');
  ok(mf.icons.some(i => i.sizes === '512x512'), 'and a 512px one, which install prompts require');
  ok(!!mf.theme_color && !!mf.background_color, 'and colours, so the splash screen is not white');

  for (const icon of ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']) {
    const r = await fetch(B + icon);
    const buf = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200, `${icon} is served`);
    ok(buf.length > 500 && buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG', `${icon} is a real PNG`);
  }

  const html = (await get('/')).text;
  ok(html.includes('rel="manifest"'), 'the page links its manifest');
  ok(html.includes('apple-mobile-web-app-capable'), 'and carries the iOS standalone hint');
  ok(html.includes('apple-touch-icon'), 'and the iOS icon, which the manifest alone does not supply');
  ok(html.includes('viewport-fit=cover'), 'the viewport covers the notch');
  ok(!/maximum-scale\s*=\s*1/.test(html), 'and pinch-zoom is not disabled, which would fail accessibility');
  ok(html.includes("serviceWorker"), 'the service worker is registered');
  ok(html.includes('/barcode.js'), 'the decoder is loaded');
}

// ---- the service worker's rules ----
{
  const sw = await get('/sw.js');
  ok(sw.status === 200, 'the service worker is served');
  ok(sw.type.includes('javascript'), 'as JavaScript, or the browser refuses to register it');

  // These are the two invariants that matter. Read them out of the source, because a regression
  // here is silent: the app keeps working and starts caching things it must not.
  ok(/req\.method\s*!==\s*'GET'/.test(sw.text), 'non-GET requests are never handled, so no write is ever replayed');
  ok(/isApi\s*=\s*url\s*=>\s*url\.pathname\.startsWith\('\/api\/'\)/.test(sw.text) && /if \(isApi\(url\)\) return;/.test(sw.text),
    'API responses are never cached — they are per-user and some are audited');
  ok(sw.text.includes("req.mode === 'navigate'") && sw.text.includes('await fetch(req)'),
    'navigations go to the network first, so a deploy actually reaches installed devices');
  ok(sw.text.includes('caches.delete'), 'old caches are cleaned up on activate');
  ok(sw.text.includes('skip-waiting'), 'and an update can be applied on request');

  const barcode = await get('/barcode.js');
  ok(barcode.status === 200 && barcode.text.includes('export function decodeRow'), 'the decoder is served as a module');
}

// ---- the scan page exists and is wired up ----
{
  const js = readFileSync('public/app.js', 'utf8');
  ok(js.includes("p[0] === 'scan'"), 'the scan route is registered');
  ok(js.includes('function renderScan'), 'and the page exists');
  ok(js.includes('function stopScanner'), 'the camera can be released');
  // The bug this prevents: navigating away leaves the camera running in someone's pocket.
  ok(/const h = location\.hash[\s\S]{0,400}stopScanner\(\);/.test(js), 'and is released on every navigation');
  ok(js.includes("facingMode"), 'the rear camera is requested');
  ok(js.includes('playsinline'), 'video plays inline, or iOS takes over the whole screen');
  ok(js.includes('createConfirmer'), 'reads are confirmed before being acted on');
  ok(js.includes('BarcodeDetector'), "the browser's own decoder is preferred where it exists");
  ok(js.includes('scanManual'), 'manual entry is available when a label will not scan');
  ok(js.includes('/m/scan?code='), 'the code is resolved against the server');

  // An onclick built with a raw JSON.stringify inside a double-quoted attribute closes the
  // attribute early and silently breaks the button. The safe form in this codebase is
  // esc(JSON.stringify(...)), which escapes the quotes to &quot;.
  const risky = js.match(/="[^"]*\$\{JSON\.stringify\([^)]*\)\}/g) || [];
  ok(risky.length === 0, `no attribute embeds an unescaped JSON.stringify${risky.length ? ' — ' + risky[0] : ''}`);
  ok(/createScanned\('\$\{i\.mac \? 'mac' : 'serial'\}'\)/.test(js), 'the add-device button quotes its argument correctly');

  const css = readFileSync('public/styles.css', 'utf8');
  ok(css.includes('@media (max-width: 760px)'), 'there are phone layout rules');
  ok(/input, select, textarea \{ font-size: 16px/.test(css), 'inputs are 16px, so iOS does not zoom on focus');
  ok(css.includes('env(safe-area-inset-top)'), 'and the notch is accounted for when installed');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
