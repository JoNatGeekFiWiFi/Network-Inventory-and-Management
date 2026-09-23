// Reading an existing PDF: objects, the page tree, and form fields.
//
// lib/pdf.js WRITES PDFs, and that was the easy direction — we chose every byte. This reads files
// somebody else wrote, which is a different problem: the format has two ways to do most things, and
// real-world producers use the harder one.
//
// WHAT MAKES THIS NECESSARY. A 2024 IRS W-9 and a 2025 one both use cross-reference STREAMS and pack
// their objects into OBJECT STREAMS. That means the page tree and the form fields are inside
// Flate-compressed blobs, indexed by a compressed binary table. Neither can be found by scanning the
// file as text — which is why the quick regex approach that works on simple PDFs reports a W-9 as
// having six fields named "Page 1" through "Page 6".
//
// SCOPE, deliberately narrow. This reads structure: objects, pages, annotations, form fields. It
// does not render, does not decode content streams into text, and does not decrypt. Encrypted files
// are refused with a clear reason rather than half-parsed.
import { inflateSync, constants as zlibConstants } from 'node:zlib';

// ---- lexing -------------------------------------------------------------------------------------

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWS = (c) => WS.has(c);
const isDelim = (c) => DELIM.has(c);
const isRegular = (c) => !isWS(c) && !isDelim(c);

/** A reference to another object. Kept as an object so resolve() can tell it from a number. */
export class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen; }
  toString() { return `${this.num} ${this.gen} R`; }
}

/** A stream: its dictionary plus the raw (still encoded) bytes. */
export class PdfStream {
  constructor(dict, raw) { this.dict = dict; this.raw = raw; }
}

/**
 * A tokenising parser over a buffer.
 *
 * Written against bytes rather than a latin1 string. A PDF is binary, and string indexing invites
 * exactly the off-by-one that produces a stream truncated by one byte — which then inflates to
 * garbage, or fails, with nothing to point at the cause.
 */
export class Lexer {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }

  skipWS() {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (isWS(c)) { this.pos++; continue; }
      if (c === 0x25) {                       // '%' comment runs to end of line
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      break;
    }
  }

  /** The next syntactic object, or the symbol `END` at end of input. */
  parseObject() {
    this.skipWS();
    if (this.pos >= this.buf.length) return END;
    const c = this.buf[this.pos];

    if (c === 0x2f) return this.parseName();
    if (c === 0x28) return this.parseLiteralString();
    if (c === 0x5b) return this.parseArray();
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.parseDictOrStream();
      return this.parseHexString();
    }
    if (c === 0x5d || c === 0x3e) { this.pos++; return END; }   // stray close

    // number, reference, keyword
    const start = this.pos;
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++;
    const tok = this.buf.toString('latin1', start, this.pos);
    if (tok === '') { this.pos++; return END; }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;

    if (/^[+-]?[\d.]+$/.test(tok)) {
      // "12 0 R" is a reference; "12 0" followed by anything else is two numbers.
      const save = this.pos;
      if (/^\d+$/.test(tok)) {
        this.skipWS();
        const s2 = this.pos;
        while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++;
        const t2 = this.buf.toString('latin1', s2, this.pos);
        if (/^\d+$/.test(t2)) {
          this.skipWS();
          const s3 = this.pos;
          while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++;
          const t3 = this.buf.toString('latin1', s3, this.pos);
          if (t3 === 'R') return new Ref(Number(tok), Number(t2));
        }
      }
      this.pos = save;
      return Number(tok);
    }
    return { keyword: tok };
  }

  parseName() {
    this.pos++;                                // '/'
    let out = '';
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) {
      let c = this.buf[this.pos];
      if (c === 0x23 && this.pos + 2 < this.buf.length) {   // '#' hex escape, e.g. /A#20B
        const hex = this.buf.toString('latin1', this.pos + 1, this.pos + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); this.pos += 3; continue; }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return { name: out };
  }

  parseLiteralString() {
    this.pos++;                                // '('
    let depth = 1, out = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++];
      if (c === 0x5c) {                        // backslash
        const n = this.buf[this.pos++];
        const simple = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (simple[n] !== undefined) { out.push(simple[n]); continue; }
        if (n >= 0x30 && n <= 0x37) {          // octal, up to three digits
          let oct = String.fromCharCode(n);
          for (let i = 0; i < 2 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37; i++) oct += String.fromCharCode(this.buf[this.pos++]);
          out.push(parseInt(oct, 8) & 0xff); continue;
        }
        if (n === 0x0a) continue;              // line continuation
        if (n === 0x0d) { if (this.buf[this.pos] === 0x0a) this.pos++; continue; }
        out.push(n); continue;
      }
      if (c === 0x28) { depth++; out.push(c); continue; }
      if (c === 0x29) { depth--; if (!depth) break; out.push(c); continue; }
      out.push(c);
    }
    return { str: Buffer.from(out) };
  }

  parseHexString() {
    this.pos++;                                // '<'
    let hex = '';
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const c = this.buf[this.pos++];
      if (/[0-9a-fA-F]/.test(String.fromCharCode(c))) hex += String.fromCharCode(c);
    }
    this.pos++;                                // '>'
    if (hex.length % 2) hex += '0';
    return { str: Buffer.from(hex, 'hex') };
  }

  parseArray() {
    this.pos++;                                // '['
    const out = [];
    for (;;) {
      this.skipWS();
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] === 0x5d) { this.pos++; break; }
      const v = this.parseObject();
      if (v === END) break;
      out.push(v);
    }
    return out;
  }

  parseDictOrStream() {
    this.pos += 2;                             // '<<'
    const dict = {};
    for (;;) {
      this.skipWS();
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break; }
      const key = this.parseObject();
      if (key === END) break;
      if (!key || key.name === undefined) continue;      // tolerate junk rather than abandoning the object
      const val = this.parseObject();
      if (val === END) break;
      dict[key.name] = val;
    }

    // A dictionary followed by `stream` owns the bytes that follow.
    const save = this.pos;
    this.skipWS();
    if (this.buf.toString('latin1', this.pos, this.pos + 6) === 'stream') {
      this.pos += 6;
      if (this.buf[this.pos] === 0x0d) this.pos++;
      if (this.buf[this.pos] === 0x0a) this.pos++;
      const start = this.pos;
      return { streamAt: start, dict };        // the caller knows /Length, which may be a reference
    }
    this.pos = save;
    return dict;
  }
}

export const END = Symbol('end-of-input');

// ---- filters -------------------------------------------------------------------------------------

/**
 * Undo a PNG predictor.
 *
 * Cross-reference streams are almost always predicted, because the rows differ from each other by
 * very little and the predictor makes them compress to nearly nothing. Skipping this step yields
 * plausible-looking bytes that decode to nonsense offsets — which then point at the middle of
 * objects, and the failure looks like a corrupt file rather than a missing step.
 */
export function unpredict(data, { predictor = 1, colors = 1, bpc = 8, columns = 1 }) {
  if (predictor < 2) return data;
  if (predictor === 2) return data;            // TIFF predictor: not used by xref streams
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);

  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = Buffer.from(data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)));
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;   // left
      const b = prev[i];                        // up
      const c = i >= bpp ? prev[i - bpp] : 0;  // upper-left
      switch (ft) {
        case 0: break;                                              // None
        case 1: row[i] = (row[i] + a) & 0xff; break;                // Sub
        case 2: row[i] = (row[i] + b) & 0xff; break;                // Up
        case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;   // Average
        case 4: {                                                    // Paeth
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: break;                                             // unknown: leave as-is
      }
    }
    row.copy(out, r * rowLen);
    prev = row;
  }
  return out;
}

// ---- the document ----------------------------------------------------------------------------------

const ENCRYPTED_MESSAGE =
  'This PDF is encrypted. Even a file that opens without a password can carry permission '
  + 'restrictions that prevent anything being added to it. Save an unprotected copy first — in '
  + 'Preview: File, Export as PDF; in Acrobat: File, Save a Copy — then upload that.';

export class PdfDocument {
  constructor(buf) {
    this.buf = buf;
    this.xref = new Map();          // objNum -> {offset} | {objStm, index}
    this.trailer = {};
    this.cache = new Map();
    this.objStmCache = new Map();
    this.warnings = [];
  }

  static open(buf) {
    const doc = new PdfDocument(buf);
    doc.load();
    return doc;
  }

  /** Follow a Ref (possibly a chain) to a value. */
  resolve(v, depth = 0) {
    if (!(v instanceof Ref) || depth > 32) return v;
    return this.resolve(this.getObject(v.num), depth + 1);
  }

  dictGet(dict, key) { return dict ? this.resolve(dict[key]) : undefined; }

  load() {
    // Encryption is checked FIRST, and against the raw bytes.
    //
    // Reaching it through the trailer means parsing the cross-reference table — which in an
    // encrypted file may itself be encrypted and unreadable. The failure then surfaces as "could
    // not read the cross-reference table", which sends someone hunting for a corrupt file when the
    // real answer is "it has a password". Checking the bytes costs nothing and names the actual
    // problem. The trailer is still consulted below for files where the xref does parse.
    if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(this.buf.toString('latin1'))) {
      throw new Error(ENCRYPTED_MESSAGE);
    }

    const tail = this.buf.toString('latin1', Math.max(0, this.buf.length - 2048));
    const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
    if (!m) throw new Error('No startxref found: this does not look like a usable PDF. If it came from a scanner or an email attachment, check it opens in a normal reader first.');
    let offset = Number(m[1]);

    const seen = new Set();
    while (offset != null && offset > 0 && offset < this.buf.length && !seen.has(offset)) {
      seen.add(offset);
      offset = this.readXrefSection(offset);
    }

    if (this.trailer.Encrypt) throw new Error(ENCRYPTED_MESSAGE);
    if (!this.xref.size) throw new Error('Could not read the cross-reference table. The file may be truncated or damaged.');
  }

  /** Read one xref section; returns the /Prev offset, or null. */
  readXrefSection(offset) {
    const lex = new Lexer(this.buf, offset);
    lex.skipWS();

    // Classic table: `xref` then subsections then `trailer <<...>>`.
    if (this.buf.toString('latin1', lex.pos, lex.pos + 4) === 'xref') {
      lex.pos += 4;
      for (;;) {
        lex.skipWS();
        if (this.buf.toString('latin1', lex.pos, lex.pos + 7) === 'trailer') { lex.pos += 7; break; }
        const start = lex.parseObject(), count = lex.parseObject();
        if (typeof start !== 'number' || typeof count !== 'number') break;
        lex.skipWS();
        for (let i = 0; i < count; i++) {
          const entry = this.buf.toString('latin1', lex.pos, lex.pos + 20);
          const em = entry.match(/(\d{10})\s+(\d{5})\s+([nf])/);
          if (em) {
            const num = start + i;
            if (em[3] === 'n' && !this.xref.has(num)) this.xref.set(num, { offset: Number(em[1]) });
          }
          lex.pos += 20;
          // Some producers use 19-byte entries. Re-sync rather than drifting through the table.
          while (lex.pos < this.buf.length && isWS(this.buf[lex.pos]) && this.buf[lex.pos - 1] !== 0x0a && this.buf[lex.pos - 1] !== 0x0d) lex.pos++;
        }
      }
      const tr = lex.parseObject();
      const trailer = tr && tr.dict ? tr.dict : tr;
      for (const [k, v] of Object.entries(trailer || {})) if (this.trailer[k] === undefined) this.trailer[k] = v;
      // A hybrid file points at an xref stream as well; read it for the compressed entries.
      if (trailer && trailer.XRefStm) this.readXrefSection(Number(trailer.XRefStm));
      return trailer && trailer.Prev != null ? Number(trailer.Prev) : null;
    }

    // Cross-reference stream: `N G obj << ... >> stream`.
    const num = lex.parseObject(), gen = lex.parseObject(), kw = lex.parseObject();
    if (typeof num !== 'number' || !kw || kw.keyword !== 'obj') {
      this.warnings.push(`Offset ${offset} is neither an xref table nor an object.`);
      return null;
    }
    const parsed = lex.parseObject();
    if (!parsed || parsed.streamAt === undefined) { this.warnings.push(`Object at ${offset} is not a stream.`); return null; }

    const dict = parsed.dict;
    const data = this.decodeStreamAt(parsed.streamAt, dict);
    this.parseXrefStream(data, dict);
    for (const [k, v] of Object.entries(dict)) if (this.trailer[k] === undefined) this.trailer[k] = v;
    return dict.Prev != null ? Number(dict.Prev) : null;
  }

  parseXrefStream(data, dict) {
    const W = (dict.W || []).map(Number);
    if (W.length < 3) { this.warnings.push('Cross-reference stream has no usable /W.'); return; }
    const size = Number(dict.Size || 0);
    const index = Array.isArray(dict.Index) ? dict.Index.map(Number) : [0, size];
    const rowLen = W.reduce((a, b) => a + b, 0);

    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = index[s], count = index[s + 1];
      for (let i = 0; i < count && p + rowLen <= data.length; i++, p += rowLen) {
        let q = p;
        const read = (w) => { let v = 0; for (let j = 0; j < w; j++) v = v * 256 + data[q++]; return v; };
        const type = W[0] === 0 ? 1 : read(W[0]);     // default type is 1 when the field is absent
        const f2 = read(W[1]);
        const f3 = read(W[2]);
        const objNum = start + i;
        if (this.xref.has(objNum)) continue;          // earlier sections win: they are newer
        if (type === 1) this.xref.set(objNum, { offset: f2, gen: f3 });
        else if (type === 2) this.xref.set(objNum, { objStm: f2, index: f3 });
        // type 0 is a free object
      }
    }
  }

  /** Inflate (and un-predict) a stream whose body starts at `at`. */
  decodeStreamAt(at, dict) {
    let len = this.resolve(dict.Length);
    if (typeof len !== 'number') {
      // Some files put /Length in an object that comes later. Fall back to scanning for endstream.
      const idx = this.buf.indexOf('endstream', at, 'latin1');
      len = idx === -1 ? this.buf.length - at : idx - at;
    }
    let data = this.buf.subarray(at, at + len);

    const filters = [].concat(this.resolve(dict.Filter) || []).map(f => (f && f.name) || f);
    const parmsList = [].concat(this.resolve(dict.DecodeParms) || []);
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (f === 'FlateDecode' || f === 'Fl') {
        try { data = inflateSync(data); }
        catch (e) {
          // Truncation is the common real-world fault here, and it has two causes worth handling
          // rather than reporting as damage: a /Length that is wrong (producers do ship these), and
          // a stream whose declared length excludes trailing bytes. Z_SYNC_FLUSH returns what could
          // be decoded instead of refusing; if the result is usable, the file is usable.
          try {
            data = inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
            if (!data.length) throw e;
          } catch {
            // Last resort: ignore the declared length and inflate to the next `endstream`.
            try {
              const end = this.buf.indexOf('endstream', at, 'latin1');
              if (end > at) {
                data = inflateSync(this.buf.subarray(at, end), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
                if (!data.length) throw e;
              } else throw e;
            } catch {
              throw new Error(`Could not decompress a stream at offset ${at} (${e.message}). The file may be damaged, or use a feature this reader does not implement.`);
            }
          }
        }
      } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
        const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
        data = Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), 'hex');
      } else if (f) {
        throw new Error(`Unsupported stream filter /${f}. This file uses a compression this reader does not implement.`);
      }
      const parms = this.resolve(parmsList[i]);
      if (parms && parms.Predictor) {
        data = unpredict(data, {
          predictor: Number(this.resolve(parms.Predictor)) || 1,
          colors: Number(this.resolve(parms.Colors)) || 1,
          bpc: Number(this.resolve(parms.BitsPerComponent)) || 8,
          columns: Number(this.resolve(parms.Columns)) || 1
        });
      }
    }
    return data;
  }

  getObject(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const loc = this.xref.get(num);
    if (!loc) return null;
    let value = null;

    if (loc.offset !== undefined) {
      const lex = new Lexer(this.buf, loc.offset);
      const n = lex.parseObject(), g = lex.parseObject(), kw = lex.parseObject();
      if (typeof n === 'number' && kw && kw.keyword === 'obj') {
        const parsed = lex.parseObject();
        value = (parsed && parsed.streamAt !== undefined)
          ? new PdfStream(parsed.dict, parsed.streamAt)
          : parsed;
      } else {
        this.warnings.push(`Object ${num} is not where the cross-reference table says it is.`);
      }
    } else if (loc.objStm !== undefined) {
      value = this.fromObjectStream(loc.objStm, loc.index, num);
    }

    this.cache.set(num, value);
    return value;
  }

  /**
   * Pull one object out of a compressed object stream.
   *
   * The stream begins with /N pairs of (object number, offset), then the objects themselves from
   * /First. The whole stream is decoded once and cached: a form with 38 fields would otherwise
   * inflate the same blob dozens of times.
   */
  fromObjectStream(stmNum, index, wantNum) {
    let entry = this.objStmCache.get(stmNum);
    if (!entry) {
      const stm = this.getObject(stmNum);
      if (!(stm instanceof PdfStream)) return null;
      const data = this.decodeStreamAt(stm.raw, stm.dict);
      const n = Number(this.resolve(stm.dict.N)) || 0;
      const first = Number(this.resolve(stm.dict.First)) || 0;
      const head = new Lexer(data, 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const a = head.parseObject(), b = head.parseObject();
        if (typeof a !== 'number' || typeof b !== 'number') break;
        pairs.push([a, b]);
      }
      entry = { data, first, pairs };
      this.objStmCache.set(stmNum, entry);
    }
    const pair = entry.pairs[index] && entry.pairs[index][0] === wantNum
      ? entry.pairs[index]
      : entry.pairs.find(p => p[0] === wantNum);      // trust the number over the index
    if (!pair) return null;
    return new Lexer(entry.data, entry.first + pair[1]).parseObject();
  }

  /** A stream's decoded bytes. */
  streamData(stm) {
    if (!(stm instanceof PdfStream)) return null;
    return this.decodeStreamAt(stm.raw, stm.dict);
  }

  // ---- structure ------------------------------------------------------------------------------

  get catalog() { return this.resolve(this.trailer.Root); }

  /** Every page, in order, as {ref, dict, index}. */
  pages() {
    const out = [];
    const root = this.dictGet(this.catalog, 'Pages');
    const walk = (node, depth = 0, inherited = {}) => {
      if (!node || depth > 64) return;
      const type = node.Type && node.Type.name;
      const inherit = { ...inherited };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node[k] !== undefined) inherit[k] = node[k];
      if (type === 'Page' || (!node.Kids && node.Contents !== undefined)) {
        out.push({ index: out.length, dict: { ...inherit, ...node } });
        return;
      }
      for (const kid of this.resolve(node.Kids) || []) {
        const ref = kid instanceof Ref ? kid : null;
        const d = this.resolve(kid);
        if (d) { d.__ref = ref; walk(d, depth + 1, inherit); }
      }
    };
    walk(root);
    return out;
  }

  /** Map an object number to its page index, so a widget can say which page it is on. */
  pageIndexOf(pageRefNum) {
    if (!this._pageNums) {
      this._pageNums = new Map();
      const root = this.dictGet(this.catalog, 'Pages');
      let i = 0;
      const walk = (node, depth = 0) => {
        if (!node || depth > 64) return;
        for (const kid of this.resolve(node.Kids) || []) {
          const d = this.resolve(kid);
          if (!d) continue;
          if ((d.Type && d.Type.name === 'Page') || (!d.Kids && d.Contents !== undefined)) {
            if (kid instanceof Ref) this._pageNums.set(kid.num, i);
            i++;
          } else walk(d, depth + 1);
        }
      };
      walk(root);
    }
    return this._pageNums.has(pageRefNum) ? this._pageNums.get(pageRefNum) : null;
  }
}

// ---- form fields --------------------------------------------------------------------------------

const FIELD_TYPES = { Tx: 'text', Btn: 'button', Ch: 'choice', Sig: 'signature' };

/**
 * Decode a PDF text string.
 *
 * Two encodings are legal and both appear in the wild. A string beginning FE FF is UTF-16 big-endian;
 * anything else is PDFDocEncoding, which is close enough to latin1 for these purposes.
 *
 * Reading everything as latin1 does not fail — it succeeds and returns mojibake. The IRS W-9's field
 * names are UTF-16, so "topmostSubform[0].Page1[0].f1_01[0]" came back as
 * "þÿ\0t\0o\0p\0m..." — a name that looks like data corruption and, worse, will not match when
 * somebody later asks to fill the field by name.
 */
export function pdfText(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE. Node decodes UTF-16LE natively, so swap the byte pairs first.
    const swapped = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('latin1');
}

/**
 * Every fillable field, flattened out of the AcroForm tree.
 *
 * A field's full name is its ancestors' names joined with dots, and a field may have several
 * widgets (the same logical "Yes" on three pages). Both matter: without the full name, two fields
 * called "Name" under different parents are indistinguishable; without per-widget rectangles, there
 * is nowhere to draw.
 *
 * Inherited attributes are a genuine trap. /FT, /Ff and /V are inheritable, so a checkbox whose own
 * dictionary has no /FT is still a button — via its parent. Reading only the leaf reports it as an
 * unknown type, which is how a form ends up with fields nobody can fill.
 */
export function formFields(doc) {
  const acro = doc.dictGet(doc.catalog, 'AcroForm');
  if (!acro) return { fields: [], acroForm: null, needAppearances: false };

  const fields = [];
  const seen = new Set();

  const walk = (node, ref, inherited, nameParts, depth) => {
    if (!node || depth > 32) return;
    const key = ref ? ref.num : null;
    if (key != null) { if (seen.has(key)) return; seen.add(key); }

    const partial = node.T && node.T.str ? pdfText(node.T.str) : null;
    const parts = partial ? [...nameParts, partial] : nameParts;

    const inherit = {
      FT: node.FT !== undefined ? node.FT : inherited.FT,
      Ff: node.Ff !== undefined ? node.Ff : inherited.Ff,
      V: node.V !== undefined ? node.V : inherited.V,
      DA: node.DA !== undefined ? node.DA : inherited.DA,
      Opt: node.Opt !== undefined ? node.Opt : inherited.Opt
    };

    const kids = doc.resolve(node.Kids);
    // Kids that are themselves fields (they have /T) versus kids that are just this field's widgets.
    const kidDicts = (kids || []).map(k => ({ ref: k instanceof Ref ? k : null, d: doc.resolve(k) })).filter(x => x.d);
    const childFields = kidDicts.filter(x => x.d.T !== undefined);
    const widgetKids = kidDicts.filter(x => x.d.T === undefined &&
      ((x.d.Subtype && x.d.Subtype.name === 'Widget') || x.d.Rect !== undefined));

    if (childFields.length) {
      for (const c of childFields) walk(c.d, c.ref, inherit, parts, depth + 1);
      // A node can have both: keep walking, but still record this one if it is itself a field.
      if (!inherit.FT) return;
    }

    const ftName = inherit.FT && inherit.FT.name;
    if (!ftName) return;                       // a pure container, not a field

    const widgets = [];
    const addWidget = (d, r) => {
      const rect = (doc.resolve(d.Rect) || []).map(v => Number(doc.resolve(v)));
      if (rect.length !== 4) return;
      const pageRef = d.P instanceof Ref ? d.P : null;
      widgets.push({
        rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
        page: pageRef ? doc.pageIndexOf(pageRef.num) : null,
        ref: r ? r.num : null,
        // For a checkbox or radio, the appearance dictionary's keys ARE the permitted values —
        // "/Off" plus whatever the on-state is called. Guessing "Yes" is wrong as often as right.
        states: onStates(doc, d)
      });
    };
    if (node.Rect !== undefined || (node.Subtype && node.Subtype.name === 'Widget')) addWidget(node, ref);
    for (const w of widgetKids) addWidget(w.d, w.ref);

    const flags = Number(doc.resolve(inherit.Ff)) || 0;
    const type = FIELD_TYPES[ftName] || ftName;
    fields.push({
      name: parts.join('.') || null,
      type,
      // Flag bits that change what a field IS, not merely how it looks.
      radio: type === 'button' && !!(flags & (1 << 15)),
      pushButton: type === 'button' && !!(flags & (1 << 16)),
      checkbox: type === 'button' && !(flags & (1 << 15)) && !(flags & (1 << 16)),
      multiline: type === 'text' && !!(flags & (1 << 12)),
      combo: type === 'choice' && !!(flags & (1 << 17)),
      options: type === 'choice' ? choiceOptions(doc, inherit.Opt) : [],
      readOnly: !!(flags & 1),
      required: !!(flags & (1 << 1)),
      value: valueOf(doc.resolve(inherit.V)),
      // The tooltip (/TU) is the only human-readable description most government forms carry —
      // the IRS names its fields "f1_01[0]" and puts "Line 1: Name" in the tooltip. It is what makes
      // a form's fields mappable to meaning without guessing from their position on the page.
      tooltip: node.TU !== undefined ? valueOf(doc.resolve(node.TU)) : null,
      maxLen: node.MaxLen !== undefined ? Number(doc.resolve(node.MaxLen)) || null : null,
      widgets,
      ref: ref ? ref.num : null
    });
  };

  for (const f of doc.resolve(acro.Fields) || []) {
    walk(doc.resolve(f), f instanceof Ref ? f : null, {}, [], 0);
  }

  return {
    fields,
    acroForm: acro,
    needAppearances: !!doc.resolve(acro.NeedAppearances),
    // XFA is the trap in this whole area, and it is INVISIBLE to a text scan because the AcroForm
    // dictionary itself lives inside a compressed object stream.
    //
    // A hybrid form carries both an XFA (XML) definition and ordinary AcroForm fields. Acrobat
    // prefers the XFA one. So filling the AcroForm fields and leaving XFA in place produces the
    // worst kind of failure: correct in Preview, in Chrome, and in every browser viewer — and blank
    // in Acrobat, which is what a company's finance department opens a W-9 in. The fix is to drop
    // the XFA entry when filling, which makes Acrobat fall back to the fields we actually wrote.
    xfa: acro.XFA !== undefined,
    // XFA-ONLY is different and worse: there are no usable AcroForm fields, just a shell.
    xfaOnly: acro.XFA !== undefined && !!doc.resolve(doc.catalog && doc.catalog.NeedsRendering)
  };
}

function choiceOptions(doc, opt) {
  const list = doc.resolve(opt);
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const resolved = doc.resolve(item);
    if (Array.isArray(resolved) && resolved.length >= 2) {
      return { export: valueOf(doc.resolve(resolved[0])), display: valueOf(doc.resolve(resolved[1])) };
    }
    const v = valueOf(resolved);
    return { export: v, display: v };
  }).filter(o => o.export != null && o.export !== '');
}

function onStates(doc, widget) {
  const ap = doc.resolve(widget.AP);
  const n = ap && doc.resolve(ap.N);
  if (!n || n instanceof PdfStream || typeof n !== 'object') return null;
  const keys = Object.keys(n).filter(k => k !== 'Off');
  return keys.length ? ['Off', ...keys] : null;
}

function valueOf(v) {
  if (v == null) return null;
  if (v.str) return pdfText(v.str);
  if (v.name) return v.name;
  if (Array.isArray(v)) return v.map(valueOf);
  return typeof v === 'object' ? null : v;
}

/**
 * Pull the text operators out of each page. Enough to search an uploaded PDF.
 * It does not reconstruct reading order beyond the order the operators were written.
 */
export function pageText(bufOrDoc) {
  const doc = Buffer.isBuffer(bufOrDoc) ? PdfDocument.open(bufOrDoc) : bufOrDoc;
  return doc.pages().map(p => {
    const contents = doc.resolve(p.dict.Contents);
    const parts = Array.isArray(contents) ? contents : [contents];
    let text = '';
    for (const part of parts) {
      const stream = part instanceof PdfStream ? part : (part instanceof Ref ? doc.getObject(part.num) : null);
      if (!(stream instanceof PdfStream)) continue;
      let data;
      try { data = doc.decodeStreamAt(stream.raw, stream.dict); }
      catch { continue; }
      text += stringsFromContent(data.toString('latin1')) + '\n';
    }
    return text;
  });
}

function readPdfString(src, i) {
  if (src[i] !== '(') return null;
  i++;
  let depth = 1, s = '';
  while (i < src.length && depth) {
    const c = src[i++];
    if (c === '\\') {
      const n = src[i++] || '';
      if (n === 'n') s += '\n';
      else if (n === 'r') s += '\r';
      else if (n === 't') s += '\t';
      else if (n >= '0' && n <= '7') {
        let oct = n;
        for (let k = 0; k < 2 && src[i] >= '0' && src[i] <= '7'; k++) oct += src[i++];
        s += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else s += n;
      continue;
    }
    if (c === '(') { depth++; s += c; continue; }
    if (c === ')') { depth--; if (depth) s += c; continue; }
    s += c;
  }
  return { text: s, i };
}

function stringsFromContent(src) {
  let out = '', i = 0;
  while (i < src.length) {
    if (src[i] === '(') {
      const got = readPdfString(src, i);
      if (!got) { i++; continue; }
      let j = got.i;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src.slice(j, j + 2) === 'Tj' || src[j] === "'") out += got.text;
      i = got.i;
      continue;
    }
    if (src[i] === '[') {
      const start = i;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') { depth--; i++; if (!depth) break; continue; }
        i++;
      }
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src.slice(j, j + 2) === 'TJ') {
        let k = start;
        while (k < i) {
          if (src[k] === '(') {
            const got = readPdfString(src, k);
            if (got) { out += got.text + ' '; k = got.i; continue; }
          }
          k++;
        }
      }
      continue;
    }
    i++;
  }
  return out;
}

/** What this reader can and cannot do with a given file — checked before anything is promised. */
export function capabilities(buf) {
  try {
    const doc = PdfDocument.open(buf);
    const pages = doc.pages();
    const { fields, needAppearances, xfa, xfaOnly } = formFields(doc);
    const fillable = fields.filter(f => !f.readOnly && !f.pushButton);
    return {
      ok: true,
      pages: pages.length,
      fields: fields.length,
      fillable: fillable.length,
      needAppearances,
      xfa, xfaOnly,
      hasUsageRights: !!doc.dictGet(doc.catalog, 'Perms'),
      warnings: doc.warnings,
      doc
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
