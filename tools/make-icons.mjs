// Generate the app icons, without an image library.
//
// A PWA needs real PNGs — iOS will not use an SVG for the home screen icon. Rather than add a
// rasteriser dependency for four small images, the icon is drawn with arithmetic and written out
// with a minimal PNG encoder. PNG's structure is the same idea as the xlsx writer already in this
// repo: a container of chunks with CRCs, wrapped around deflated data.
//
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---- minimal PNG encoder ----
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** @param rgba Uint8Array of width*height*4 */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 8 bits per channel
  ihdr[9] = 6;    // truecolour with alpha
  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple and the images
  // are small enough that the extra bytes do not matter.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 4);
    raw[at] = 0;
    rgba.subarray ? Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(raw, at + 1)
                  : Buffer.from(rgba.slice(y * width * 4, (y + 1) * width * 4)).copy(raw, at + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- the icon ----
//
// A signal arc over a node: it reads at 40px on a home screen, which a wordmark would not, and it
// says "wireless network" without needing to be looked at twice. Drawn with supersampling so the
// curves are not jagged.
const BLUE = [0x37, 0x8A, 0xDD];
const DARK = [0x10, 0x16, 0x1D];
const WHITE = [0xFF, 0xFF, 0xFF];

function drawIcon(size, { maskable = false, opaque = false } = {}) {
  const S = 4;                                    // supersample factor
  const W = size * S;
  const acc = new Float32Array(size * size * 4);

  // Maskable icons get cropped to a circle by the OS, so the artwork must sit inside the middle
  // ~80%. `opaque` fills the whole square: iOS renders transparency in an apple-touch-icon as
  // black, so that one must not have see-through corners.
  const fullBleed = maskable || opaque;
  const scale = maskable ? 0.62 : 0.78;
  const cx = W / 2, cy = W * 0.60;
  const radius = W * 0.10 * (scale / 0.78);
  const corner = W * 0.22;

  // One colour per subsample, accumulated once. Drawing the background and then the foreground as
  // two separate contributions averaged them together, which turned the node from brand blue into
  // a muddy slate — the shapes were right and the colours quietly wrong.
  const add = (x, y, rgb, a) => {
    const i = (Math.floor(y / S) * size + Math.floor(x / S)) * 4;
    acc[i] += rgb[0] * a; acc[i + 1] += rgb[1] * a; acc[i + 2] += rgb[2] * a; acc[i + 3] += a;
  };

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let inBg = true;
      if (!fullBleed) {
        const ox = Math.max(corner - x, 0, x - (W - corner));
        const oy = Math.max(corner - y, 0, y - (W - corner));
        inBg = Math.hypot(ox, oy) <= corner;
      }
      if (!inBg) continue;

      let colour = DARK;
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);

      if (d <= radius) {
        colour = BLUE;                                  // the node
      } else {
        const ang = Math.atan2(-dy, dx);                // 0 = right, +pi/2 = up
        if (ang > 0.62 && ang < Math.PI - 0.62) {
          for (let k = 1; k <= 3; k++) {
            const r = radius + W * 0.105 * k * (scale / 0.78);
            const thick = W * 0.035 * (scale / 0.78);
            if (Math.abs(d - r) < thick / 2) { colour = k === 3 ? BLUE : WHITE; break; }
          }
        }
      }
      add(x, y, colour, 1);
    }
  }

  const out = new Uint8Array(size * size * 4);
  const per = S * S;
  for (let i = 0; i < size * size; i++) {
    const cover = acc[i * 4 + 3] / per;                 // 0..1 of the pixel that was painted
    out[i * 4 + 3] = Math.round(Math.min(255, cover * 255));
    if (cover > 0) for (let c = 0; c < 3; c++)
      out[i * 4 + c] = Math.round(Math.min(255, acc[i * 4 + c] / acc[i * 4 + 3]));
  }
  return out;
}

const ICONS = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  // iOS renders any transparency in this one as black, so it is drawn edge to edge.
  ['apple-touch-icon.png', 180, { opaque: true }]
];

for (const [file, size, opts] of ICONS) {
  const png = encodePng(drawIcon(size, opts), size, size);
  writeFileSync(join(OUT, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}
