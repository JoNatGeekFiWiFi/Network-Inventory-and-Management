// Draw onto an existing PDF page — a signature, a date, a strike-through — by incremental update.
//
// Filling form fields (lib/pdffill.js) covers everything a form author made a field for. A W-9 has
// no signature field and no date field: the IRS expects ink. So the signature is drawn straight onto
// the page, as vector paths, in an update APPENDED to the file. The bytes that were sent — and
// hashed — are still the first bytes of the result, unchanged; a reader can show the file as it was
// before signing, and anyone can check the prefix against the recorded hash.
//
// Two details that are easy to get wrong:
//
//   * THE PAGE'S GRAPHICS STATE. The original content stream may leave a transformation or colour
//     set at its end. Our drawing is wrapped so it starts from a clean state: a "q" stream goes in
//     FRONT of the original content and our stream begins with "Q", which restores whatever the
//     page had before its own content ran. Appending drawing without this lands it scaled, shifted
//     or invisible on some files and fine on others.
//   * FONTS. Text needs a font in the page's resources. We add base-14 Helvetica under a name of our
//     own (/GFHelv) rather than reusing one of the page's fonts, which may be a subset that lacks the
//     glyphs we need.
import { deflateSync } from 'node:zlib';
import { PdfDocument, Ref } from './pdfread.js';

const n = (v) => (Math.round(v * 100) / 100).toString();

/** A PDF literal string, escaped, Latin-1 only (base-14 fonts cannot show anything else). */
export function pdfLiteral(s) {
  const folded = String(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
  return '(' + folded.replace(/[\\()]/g, (c) => '\\' + c) + ')';
}

/**
 * A drawn signature fitted into a box, as PDF path operators.
 *
 * `strokes` are the signature pad's points ({x, y}, y growing DOWN). `box` is [x0, y0, x1, y1] in
 * PDF user space (y growing UP). Aspect ratio is kept, and the signature sits on the box's
 * baseline-ish lower edge the way a pen signature sits on a line.
 */
export function signatureOps(strokes, box, { colour = [0, 0, 0.55], lineWidth = 1.2 } = {}) {
  const pts = (strokes || []).flat().filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return '';
  const [x0, y0, x1, y1] = box;
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const srcW = Math.max(1e-6, maxX - minX), srcH = Math.max(1e-6, maxY - minY);
  const scale = Math.min((x1 - x0) / srcW, (y1 - y0) / srcH);
  const px = (p) => x0 + (p.x - minX) * scale;
  const py = (p) => y0 + (maxY - p.y) * scale;     // flip: pad y down → PDF y up, anchored at the bottom
  const out = [`q ${n(colour[0])} ${n(colour[1])} ${n(colour[2])} RG ${n(lineWidth)} w 1 J 1 j`];
  for (const stroke of strokes) {
    const s = (stroke || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!s.length) continue;
    out.push(`${n(px(s[0]))} ${n(py(s[0]))} m`);
    if (s.length === 1) { out.push(`${n(px(s[0]) + 0.3)} ${n(py(s[0]))} l`); }
    // Midpoint quadratic smoothing, emitted as cubics: straight segments look jagged once printed.
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      const mx = (px(a) + px(b)) / 2, my = (py(a) + py(b)) / 2;
      out.push(`${n(px(a))} ${n(py(a))} ${n(mx)} ${n(my)} ${n(mx)} ${n(my)} c`);
    }
    const last = s[s.length - 1];
    out.push(`${n(px(last))} ${n(py(last))} l S`);
  }
  out.push('Q');
  return out.join('\n');
}

/** A line of text. `font` is one of the resource names stampPage installs. */
export function textOps(text, x, y, { size = 9, font = 'GFHelv', colour = [0, 0, 0] } = {}) {
  return `BT /${font} ${n(size)} Tf ${n(colour[0])} ${n(colour[1])} ${n(colour[2])} rg ${n(x)} ${n(y)} Td ${pdfLiteral(text)} Tj ET`;
}

/** A straight line, for crossing something out. */
export function lineOps(x0, y0, x1, y1, { width = 0.9, colour = [0, 0, 0] } = {}) {
  return `q ${n(colour[0])} ${n(colour[1])} ${n(colour[2])} RG ${n(width)} w ${n(x0)} ${n(y0)} m ${n(x1)} ${n(y1)} l S Q`;
}

// ---- serialising what we read back ------------------------------------------------------------------

const pdfName = (s) => '/' + String(s).replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
function ser(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true || v === false) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (Array.isArray(v)) return `[${v.map(ser).join(' ')}]`;
  if (v.name !== undefined) return pdfName(v.name);
  if (v.str !== undefined) {
    const b = Buffer.isBuffer(v.str) ? v.str : Buffer.from(String(v.str), 'latin1');
    return '<' + b.toString('hex') + '>';
  }
  if (v.keyword !== undefined) return v.keyword;
  if (typeof v === 'object') {
    return `<< ${Object.entries(v).filter(([k]) => !k.startsWith('__')).map(([k, val]) => `${pdfName(k)} ${ser(val)}`).join(' ')} >>`;
  }
  return 'null';
}

/**
 * Append drawing to one page and return the new file.
 *
 * @param buf        the PDF as it stands (for a W-9: already filled)
 * @param pageIndex  0-based
 * @param ops        PDF content operators, in the page's default user space
 */
export function stampPage(buf, pageIndex, ops) {
  const doc = PdfDocument.open(buf);
  const pages = doc.pages();
  const page = pages[pageIndex];
  if (!page) throw new Error(`The PDF has no page ${pageIndex + 1}`);
  const pageRef = page.dict.__ref;
  if (!(pageRef instanceof Ref)) throw new Error('That page is not an indirect object and cannot be updated in place');

  let next = Number(doc.trailer.Size) || (Math.max(0, ...doc.xref.keys()) + 1);
  const objects = [];                     // [num, bodyBuffer]
  const addObj = (body) => { const num = next++; objects.push([num, Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')]); return new Ref(num, 0); };
  const addStream = (data) => {
    const z = deflateSync(Buffer.from(data, 'latin1'));
    return addObj(Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]));
  };

  const font = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  // Oblique, for a typed signature: set in the same face it would read as just more form text.
  const oblique = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  const before = addStream('q\n');
  const after = addStream('Q\n' + ops + '\n');

  // The page dict as the reader sees it, with inherited keys (Resources, MediaBox) made explicit so
  // the rewritten page does not depend on its parent for them.
  const dict = { ...page.dict };
  delete dict.__ref;
  const res = { ...(doc.resolve(dict.Resources) || {}) };
  const fonts = { ...(doc.resolve(res.Font) || {}) };
  fonts.GFHelv = font;
  fonts.GFHelvO = oblique;
  res.Font = fonts;
  dict.Resources = res;
  // Contents may be one stream, an array of streams, or a reference to such an array.
  const resolved = doc.resolve(dict.Contents);
  const list = Array.isArray(resolved) ? resolved : (dict.Contents ? [dict.Contents] : []);
  dict.Contents = [before, ...list, after];

  objects.push([pageRef.num, Buffer.from(ser(dict), 'latin1')]);

  // Write the update: objects, an xref table, and a trailer pointing back at the previous one.
  const chunks = [buf];
  let offset = buf.length;
  if (buf[offset - 1] !== 0x0a) { chunks.push(Buffer.from('\n')); offset += 1; }
  const offsets = new Map();
  for (const [num, body] of objects) {
    offsets.set(num, offset);
    const b = Buffer.concat([Buffer.from(`${num} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(b); offset += b.length;
  }
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length;) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${String(offsets.get(nums[k])).padStart(10, '0')} 00000 n \n`;
    i = j + 1;
  }
  const tail = buf.toString('latin1', Math.max(0, buf.length - 2048));
  const prev = Number(([...tail.matchAll(/startxref\s+(\d+)/g)].pop() || [])[1] || 0);
  const t = doc.trailer;
  const root = t.Root instanceof Ref ? `${t.Root.num} ${t.Root.gen} R` : '';
  const info = t.Info instanceof Ref ? ` /Info ${t.Info.num} ${t.Info.gen} R` : '';
  const ids = Array.isArray(t.ID) ? ` /ID ${ser(t.ID)}` : '';
  const size = Math.max(next, Number(t.Size) || 0);
  chunks.push(Buffer.from(xref + `trailer\n<< /Size ${size} /Root ${root}${info}${ids} /Prev ${prev} >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
