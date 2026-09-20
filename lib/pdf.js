// A minimal PDF writer, enough to produce a signable agreement and a signed copy of it.
//
// WHY WRITE ONE. The alternative is pdfkit or similar, and the repository rule is no dependency we
// have not read. But there is a stronger reason here: a signed document is evidence. If its
// provenance is ever questioned, "we generated the bytes ourselves, here is the code" is a much
// shorter conversation than tracing behaviour through a dependency tree.
//
// WHAT MAKES THIS TRACTABLE. Two decisions remove the hard parts of PDF:
//
//   * BASE-14 FONTS. Every PDF reader is required to provide Helvetica, Times and Courier. Using
//     them means no font file to parse, subset or embed — the single largest source of complexity
//     in PDF generation simply does not arise.
//   * SIGNATURES AS VECTOR PATHS. A drawn signature arrives as stroke coordinates from a canvas.
//     Drawing those as PDF path operators, rather than embedding a PNG, means no image codec, no
//     colour space handling, and a signature that stays sharp at any zoom. The stroke data is also
//     better evidence than a flat picture: it carries the order and timing of the pen.
//
// This writes uncompressed content streams. They are larger, but a signed agreement is a few
// kilobytes either way, and a PDF you can read in a text editor is one you can debug when a
// customer says the document looked wrong.
import { deflateSync } from 'node:zlib';

// ---- text measurement ----------------------------------------------------------------------------
//
// Widths for the base-14 fonts, in 1/1000 em. Without these, text cannot be wrapped or centred, and
// every line would have to be guessed at. Only the printable ASCII range is carried: the documents
// this produces are English-language agreements, and a character outside the range is substituted
// rather than silently dropped (see encodeText).

// Helvetica advance widths for codepoints 32..126.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const TIMES = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
const TIMES_BOLD = [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520];
const TIMES_ITALIC = [250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541];
const COURIER = new Array(95).fill(600);

export const FONTS = {
  'Helvetica': HELV, 'Helvetica-Bold': HELV_BOLD,
  'Times-Roman': TIMES, 'Times-Bold': TIMES_BOLD, 'Times-Italic': TIMES_ITALIC,
  'Courier': COURIER
};

/** Width of a string at a given size, in points. */
export function textWidth(text, font = 'Helvetica', size = 11) {
  const w = FONTS[font] || HELV;
  let total = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    total += (c >= 32 && c <= 126) ? w[c - 32] : w[31];   // unknown glyphs measure as a space
  }
  return total * size / 1000;
}

/**
 * Greedy word wrap to a pixel width.
 *
 * Long unbroken tokens — a URL, a 44-character WireGuard key — are hard-split rather than allowed
 * to overflow the margin, because a line that runs off the page edge in a contract is not a
 * cosmetic problem.
 */
export function wrapText(text, maxWidth, font = 'Helvetica', size = 11) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? line + ' ' + word : word;
      if (textWidth(candidate, font, size) <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      if (textWidth(word, font, size) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (textWidth(chunk + ch, font, size) > maxWidth) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

// ---- escaping ------------------------------------------------------------------------------------

/**
 * Escape a string for a PDF literal, and fold anything outside WinAnsi to an ASCII near-equivalent.
 *
 * The characters that matter are the ones a person actually pastes into an agreement: curly quotes
 * and dashes out of Word, and the non-breaking space that hides inside copied addresses. Left
 * unhandled these produce a mojibake contract. The substitutions are deliberate and visible rather
 * than silent deletion.
 */
export function encodeText(s) {
  const FOLD = {
    '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"',
    '–': '-', '—': '--', '…': '...', ' ': ' ', '•': '-',
    '·': '-', '−': '-', '­': '', '​': '', '﻿': ''
  };
  let out = '';
  for (const ch of String(s)) {
    const folded = FOLD[ch] !== undefined ? FOLD[ch] : ch;
    for (const c of folded) {
      const code = c.codePointAt(0);
      if (c === '\\' || c === '(' || c === ')') out += '\\' + c;
      else if (code >= 32 && code <= 126) out += c;
      else out += '?';
    }
  }
  return out;
}

// ---- the document builder -------------------------------------------------------------------------

const PAGE = { width: 612, height: 792 };   // US Letter, in points

/**
 * Build a PDF.
 *
 * Coordinates given to callers are TOP-DOWN in points from the top-left corner, because that is how
 * anyone laying out a page thinks. PDF itself is bottom-up; the conversion happens in one place here
 * rather than in every caller, which is the sort of thing that otherwise produces a signature block
 * printed upside down at the bottom of the page.
 */
export function createPdf({ title = '', author = '', compress = true } = {}) {
  const pages = [];
  let current = null;

  const newPage = () => { current = { ops: [], annots: [] }; pages.push(current); return current; };
  newPage();

  const y = (top) => PAGE.height - top;      // top-down to PDF's bottom-up
  const n = (v) => (Math.round(v * 100) / 100);

  const api = {
    PAGE,
    get pageCount() { return pages.length; },

    addPage() { newPage(); return api; },

    /** A line of text with its BASELINE at `top` points from the page top. */
    text(str, { x = 72, top = 72, font = 'Helvetica', size = 11, colour = [0, 0, 0] } = {}) {
      current.ops.push(
        `BT /${font.replace(/[^\w-]/g, '')} ${n(size)} Tf ${n(colour[0])} ${n(colour[1])} ${n(colour[2])} rg ` +
        `1 0 0 1 ${n(x)} ${n(y(top))} Tm (${encodeText(str)}) Tj ET`);
      return api;
    },

    /** Wrapped body text. Returns the `top` immediately below the last line drawn. */
    paragraph(str, { x = 72, top = 72, width = 468, font = 'Helvetica', size = 11, leading = 1.45, colour = [0, 0, 0] } = {}) {
      const lines = wrapText(str, width, font, size);
      let cursor = top;
      for (const line of lines) {
        if (line) api.text(line, { x, top: cursor, font, size, colour });
        cursor += size * leading;
      }
      return cursor;
    },

    line(x1, top1, x2, top2, { width = 0.75, colour = [0, 0, 0], dash = null } = {}) {
      current.ops.push(
        `q ${n(colour[0])} ${n(colour[1])} ${n(colour[2])} RG ${n(width)} w ` +
        (dash ? `[${dash.join(' ')}] 0 d ` : '') +
        `${n(x1)} ${n(y(top1))} m ${n(x2)} ${n(y(top2))} l S Q`);
      return api;
    },

    rect(x, top, w, h, { stroke = [0, 0, 0], fill = null, width = 0.75 } = {}) {
      const parts = [`q ${n(width)} w`];
      if (fill) parts.push(`${n(fill[0])} ${n(fill[1])} ${n(fill[2])} rg`);
      if (stroke) parts.push(`${n(stroke[0])} ${n(stroke[1])} ${n(stroke[2])} RG`);
      parts.push(`${n(x)} ${n(y(top + h))} ${n(w)} ${n(h)} re`);
      parts.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
      parts.push('Q');
      current.ops.push(parts.join(' '));
      return api;
    },

    /**
     * A drawn signature: an array of strokes, each an array of {x, y} in the signature pad's own
     * pixel space. Scaled to fit the target box and centred, preserving aspect ratio — a signature
     * stretched to fill a box looks forged.
     */
    strokes(strokeList, { x = 72, top = 72, width = 200, height = 60, colour = [0, 0, 0.55], lineWidth = 1.6 } = {}) {
      const pts = strokeList.flat();
      if (!pts.length) return api;
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const srcW = Math.max(1e-6, maxX - minX), srcH = Math.max(1e-6, maxY - minY);
      const scale = Math.min(width / srcW, height / srcH);
      const offX = x + (width - srcW * scale) / 2;
      const offY = top + (height - srcH * scale) / 2;
      const px = (p) => n(offX + (p.x - minX) * scale);
      const py = (p) => n(y(offY + (p.y - minY) * scale));

      const parts = [`q ${n(colour[0])} ${n(colour[1])} ${n(colour[2])} RG ${n(lineWidth)} w 1 J 1 j`];
      for (const stroke of strokeList) {
        if (!stroke.length) continue;
        if (stroke.length === 1) {
          // A single tap is a dot — an 'i' or a full stop. Without this it vanishes.
          parts.push(`${px(stroke[0])} ${py(stroke[0])} m ${px(stroke[0])} ${py(stroke[0])} l S`);
          continue;
        }
        parts.push(`${px(stroke[0])} ${py(stroke[0])} m`);
        for (let i = 1; i < stroke.length; i++) parts.push(`${px(stroke[i])} ${py(stroke[i])} l`);
        parts.push('S');
      }
      parts.push('Q');
      current.ops.push(parts.join(' '));
      return api;
    },

    /** Serialise. Returns a Buffer. */
    build() {
      const objects = [];                       // 1-indexed on output
      const add = (body) => { objects.push(body); return objects.length; };

      const fontNames = [...new Set(['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Courier'])];
      const fontIds = {};
      for (const f of fontNames) {
        fontIds[f] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`);
      }

      const pagesId = objects.length + 1 + pages.length * 2;   // reserved; filled in below
      const pageIds = [];
      for (const p of pages) {
        const content = p.ops.join('\n');
        const raw = Buffer.from(content, 'latin1');
        const data = compress ? deflateSync(raw) : raw;
        const streamId = add({
          dict: `<< /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>`,
          stream: data
        });
        const resources = `<< /Font << ${fontNames.map(f => `/${f} ${fontIds[f]} 0 R`).join(' ')} >> >>`;
        pageIds.push(add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
          `/Resources ${resources} /Contents ${streamId} 0 R >>`));
      }

      const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
      // The reservation above must match, or every page points at the wrong parent and readers
      // reject the file. Asserted rather than assumed.
      if (realPagesId !== pagesId) throw new Error(`pages object id drifted: reserved ${pagesId}, got ${realPagesId}`);

      const infoId = add(`<< /Title (${encodeText(title)}) /Author (${encodeText(author)}) /Producer (Network Inventory) /CreationDate (${pdfDate(new Date())}) >>`);
      const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

      const chunks = [];
      let offset = 0;
      const push = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1'); chunks.push(b); offset += b.length; };

      // A binary comment on line 2 marks the file as binary for tools that sniff it.
      push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

      const offsets = [];
      objects.forEach((body, i) => {
        offsets[i] = offset;
        if (typeof body === 'string') push(`${i + 1} 0 obj\n${body}\nendobj\n`);
        else {
          push(`${i + 1} 0 obj\n${body.dict}\nstream\n`);
          push(body.stream);
          push('\nendstream\nendobj\n');
        }
      });

      const xrefAt = offset;
      let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
      push(xref);
      push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

      return Buffer.concat(chunks);
    }
  };
  return api;
}

/** PDF date syntax: D:YYYYMMDDHHmmSS followed by a UTC offset. */
export function pdfDate(d) {
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
