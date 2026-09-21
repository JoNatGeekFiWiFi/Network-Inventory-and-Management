// Filling an existing PDF form, by appending rather than rewriting.
//
// WHY INCREMENTAL. A PDF can be extended by appending new versions of the objects that changed, a
// new cross-reference section, and a trailer pointing back at the previous one. Every original byte
// survives, in place, at the same offset.
//
// For an evidence document that is the whole point. The file a vendor returns literally CONTAINS
// the blank form we sent them — so "is this the same document?" is answered by looking, not by
// trusting us. It is also the only safe option here: rewriting a file we only partly understand
// would mean discarding structures this reader does not model, and a contract that opens in one
// viewer and not another is worse than one that never got sent.
//
// THE THREE THINGS THAT SILENTLY RUIN A FILLED FORM, all handled below:
//
//   1. XFA. A hybrid form carries both XFA (XML) and AcroForm fields, and Acrobat prefers the XFA.
//      Fill the AcroForm and leave XFA in place and the result is correct in Preview and every
//      browser, and BLANK in Acrobat — which is what a finance department opens a W-9 in.
//   2. APPEARANCES. A field's value and its visible appearance are separate. Setting only /V leaves
//      readers that do not regenerate appearances showing an empty box, with the data present but
//      invisible.
//   3. CHECKBOX STATES. The "on" name is per-widget and arbitrary. This W-9 uses "1" through "7".
//      Writing /Yes produces a box that is neither on nor off, and renders as unticked.
import { deflateSync } from 'node:zlib';
import { PdfDocument, formFields, PdfStream, Ref } from './pdfread.js';
import { textWidth, encodeText, wrapText } from './pdf.js';

/** Match a caller's value to a choice field's export value or its visible label. */
export function matchChoice(options, value) {
  const want = String(value == null ? '' : value).trim().toLowerCase();
  if (!want) return null;
  return (options || []).find(o =>
    String(o.export).trim().toLowerCase() === want || String(o.display ?? o.export).trim().toLowerCase() === want
  ) || null;
}

// ---- serialising values back to PDF syntax ---------------------------------------------------------

const escLiteral = (s) => String(s).replace(/([\\()])/g, '\\$1').replace(/[\r\n]+/g, ' ');

/**
 * A text string, as UTF-16BE when it needs to be.
 *
 * A vendor's name may contain an accent, and PDFDocEncoding cannot carry one. Writing it as latin1
 * does not fail — it puts a wrong character in a tax document.
 */
function pdfString(value) {
  const s = String(value == null ? '' : value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\xFF]/.test(s)) return `(${escLiteral(s)})`;
  const be = Buffer.from('\ufeff' + s, 'utf16le').swap16();
  return `<${be.toString('hex')}>`;
}

const pdfName = (n) => `/${String(n).replace(/[^\w.+-]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))}`;

/** Write a parsed value back out. Used for the parts of a dictionary we are not changing. */
function serialise(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (Array.isArray(v)) return `[${v.map(serialise).join(' ')}]`;
  if (v.name !== undefined) return pdfName(v.name);
  if (v.str !== undefined) return pdfString(v.str.toString('latin1'));
  if (v.keyword !== undefined) return v.keyword;
  if (typeof v === 'object') {
    return `<< ${Object.entries(v).filter(([k]) => !k.startsWith('__'))
      .map(([k, val]) => `${pdfName(k)} ${serialise(val)}`).join(' ')} >>`;
  }
  return 'null';
}

// ---- appearance streams ------------------------------------------------------------------------------

/**
 * Parse a /DA string: "/HelveticaLTStd-Bold 9.00 Tf 0 g" → font, size, colour operators.
 *
 * Size 0 means auto-size, which readers interpret as "fit the box". We pick a concrete size instead,
 * because auto-sizing is the reader's job and we are the reader now.
 */
export function parseDA(da, fallback = '/Helv 9 Tf 0 g') {
  const s = String(da || fallback);
  const m = s.match(/\/([^\s/]+)\s+([\d.]+)\s+Tf/);
  const colour = (s.match(/([\d.]+(?:\s+[\d.]+){0,3})\s+(g|rg|k)\b/) || [])[0] || '0 g';
  return {
    font: m ? m[1] : 'Helv',
    size: m ? Number(m[2]) : 0,
    colour: colour.trim()
  };
}

/**
 * The visible content of a filled text field.
 *
 * Coordinates are relative to the widget's own box, and the vertical placement is deliberate: text
 * sits on a baseline, and centring the BOX is not the same as centring the text. Getting this wrong
 * puts a name half outside its field, which looks like a broken form rather than a filled one.
 */
export function textAppearance(value, { width, height, font, size, colour, align = 0, multiline = false, comb = 0 }) {
  const pad = 2;
  let fontSize = size;
  if (!fontSize) {
    // Auto-size: fit the height, then shrink further if the text is too wide for the box.
    fontSize = Math.min(12, Math.max(6, height - 2 * pad - 2));
    const usable = width - 2 * pad;
    while (fontSize > 5 && textWidth(value, 'Helvetica', fontSize) > usable) fontSize -= 0.5;
  }

  const lines = multiline
    ? wrapText(value, width - 2 * pad, 'Helvetica', fontSize)
    : [String(value).replace(/[\r\n]+/g, ' ')];

  const ops = [];
  ops.push('/Tx BMC', 'q', `1 1 ${(width - 2).toFixed(2)} ${(height - 2).toFixed(2)} re W n`, 'BT', `/${font} ${fontSize.toFixed(2)} Tf`, colour);

  if (comb > 0 && lines.length === 1) {
    // A comb field divides the box into equal cells, one character each — an SSN or EIN box. Drawing
    // the string normally puts all the digits in the first cell.
    const cell = width / comb;
    const chars = [...lines[0]].slice(0, comb);
    const y = (height - fontSize) / 2 + fontSize * 0.2;
    chars.forEach((ch, i) => {
      const cw = textWidth(ch, 'Helvetica', fontSize);
      ops.push(`1 0 0 1 ${(cell * i + (cell - cw) / 2).toFixed(2)} ${y.toFixed(2)} Tm (${encodeText(ch)}) Tj`);
    });
  } else {
    const leading = fontSize * 1.15;
    let y = multiline
      ? height - pad - fontSize
      : (height - fontSize) / 2 + fontSize * 0.2;      // single line: optically centred on the box
    for (const line of lines) {
      const w = textWidth(line, 'Helvetica', fontSize);
      const x = align === 1 ? (width - w) / 2 : align === 2 ? width - pad - w : pad;
      ops.push(`1 0 0 1 ${Math.max(pad, x).toFixed(2)} ${y.toFixed(2)} Tm (${encodeText(line)}) Tj`);
      y -= leading;
      if (y < -leading) break;
    }
  }
  ops.push('ET', 'Q', 'EMC');
  return ops.join('\n');
}

// ---- the incremental writer -----------------------------------------------------------------------------

/**
 * Fill a form and return new bytes.
 *
 * `values` maps a field name to a string (text) or to a boolean / on-state name (checkbox).
 * A name may be the full path or just its last component, because nobody wants to type
 * "topmostSubform[0].Page1[0].f1_01[0]" and getting it slightly wrong would silently fill nothing.
 */
export function fillForm(buf, values, { flatten = false, removeXfa = true, removeUsageRights = true } = {}) {
  const doc = PdfDocument.open(buf);
  const { fields, acroForm, xfa } = formFields(doc);
  if (!fields.length) {
    throw new Error('This PDF has no fillable form fields, so there is nothing to fill. It can still be sent for signature as a flat document.');
  }

  // Resolve the caller's names against real fields.
  const byFull = new Map(fields.map(f => [f.name, f]));
  const byLeaf = new Map();
  for (const f of fields) {
    const leaf = f.name.split('.').pop();
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
    byLeaf.get(leaf).push(f);
  }

  const applied = [], unmatched = [], ambiguous = [], normalised = [];
  const targets = new Map();                    // field -> value

  /**
   * Some values cannot be stored as given, and the caller is told rather than left to find out.
   *
   * A newline in a single-line field is the common one: there is nowhere for a second line to go,
   * so it becomes a space. Doing that silently means the value read back later differs from the
   * value sent, which looks like data loss when somebody eventually compares them.
   */
  const normalise = (field, value) => {
    if (field.checkbox || field.radio || value == null) return value;
    let out = String(value);
    if (!field.multiline && /[\r\n]/.test(out)) {
      const from = out;
      out = out.replace(/[\r\n]+/g, ' ').trim();
      normalised.push({ field: field.name, reason: 'single-line field: line breaks replaced with spaces', from, to: out });
    }
    return out;
  };

  for (const [key, value] of Object.entries(values || {})) {
    if (byFull.has(key)) {
      const f = byFull.get(key);
      targets.set(f, normalise(f, value)); applied.push(key); continue;
    }
    const leaves = byLeaf.get(key) || byLeaf.get(key.split('.').pop());
    if (!leaves) { unmatched.push(key); continue; }
    if (leaves.length > 1) {
      // Filling the wrong one of two same-named fields is worse than filling neither, because
      // nobody notices until the form is already with the vendor.
      ambiguous.push({ key, candidates: leaves.map(f => f.name) });
      continue;
    }
    targets.set(leaves[0], normalise(leaves[0], value));
    applied.push(key);
  }

  const w = new IncrementalWriter(doc, buf);
  const dr = doc.dictGet(acroForm, 'DR');
  const defaultDA = acroForm.DA && acroForm.DA.str ? acroForm.DA.str.toString('latin1') : '/Helv 9 Tf 0 g';

  for (const [field, rawValue] of targets) {
    if (field.readOnly) continue;
    if (field.checkbox || field.radio) {
      setCheckbox(doc, w, field, rawValue);
    } else if (field.type === 'choice' && field.options && field.options.length) {
      const hit = matchChoice(field.options, rawValue);
      if (!hit) {
        normalised.push({ field: field.name, reason: 'not one of the listed choices', from: rawValue, to: null });
      } else {
        setText(doc, w, field, String(hit.export), { dr, defaultDA, flatten, appearance: String(hit.display ?? hit.export) });
      }
    } else {
      setText(doc, w, field, rawValue == null ? '' : String(rawValue), { dr, defaultDA, flatten });
    }
  }

  // The AcroForm dictionary itself needs updating: drop XFA, and ask readers to regenerate
  // appearances for anything we did not draw ourselves.
  const acroRef = acroForm.__ref || (doc.catalog && doc.catalog.AcroForm instanceof Ref ? doc.catalog.AcroForm : null);
  if (acroRef) {
    const updated = { ...acroForm };
    delete updated.__ref;
    if (removeXfa && updated.XFA !== undefined) delete updated.XFA;
    updated.NeedAppearances = true;    // belt and braces: we draw appearances AND ask for regeneration
    w.replace(acroRef.num, serialise(updated));
  }

  // The usage-rights signature is about to be invalidated anyway; leaving it produces an alarming
  // "this document has been altered" banner over a form nobody had signed.
  if (removeUsageRights && doc.catalog && doc.catalog.Perms !== undefined) {
    const cat = { ...doc.catalog };
    delete cat.Perms; delete cat.__ref;
    const catRef = doc.trailer.Root;
    if (catRef instanceof Ref) w.replace(catRef.num, serialise(cat));
  }

  return {
    bytes: w.build(),
    applied,
    unmatched,
    ambiguous,
    normalised,
    hadXfa: xfa,
    fields: fields.length
  };
}

function setText(doc, w, field, value, { dr, defaultDA, flatten, appearance = null }) {
  const raw = doc.getObject(field.ref) || {};
  const da = raw.DA && raw.DA.str ? raw.DA.str.toString('latin1') : defaultDA;
  const { font, size, colour } = parseDA(da, defaultDA);
  const align = Number(doc.resolve(raw.Q)) || 0;
  const flags = Number(doc.resolve(raw.Ff)) || 0;
  const comb = (flags & (1 << 24)) ? (Number(doc.resolve(raw.MaxLen)) || 0) : 0;

  const updated = { ...raw };
  delete updated.__ref;
  updated.V = { str: Buffer.from(value, 'latin1') };
  if (updated.AS !== undefined) delete updated.AS;

  for (const widget of field.widgets) {
    const [x0, y0, x1, y1] = widget.rect;
    const width = x1 - x0, height = y1 - y0;
    const content = textAppearance(appearance != null ? appearance : value, {
      width, height, font, size, colour, align,
      multiline: field.multiline, comb
    });
    const apRef = w.addStream(
      `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] ` +
      `/Resources << /Font ${serialiseFontRes(doc, dr)} >> >>`,
      Buffer.from(content, 'latin1'));

    if (widget.ref && widget.ref !== field.ref) {
      const wraw = { ...(doc.getObject(widget.ref) || {}) };
      delete wraw.__ref;
      wraw.AP = { N: apRef };
      w.replace(widget.ref, serialise(wraw));
    } else {
      updated.AP = { N: apRef };
    }
  }
  w.replace(field.ref, serialise(updated));
}

function setCheckbox(doc, w, field, value) {
  const raw = doc.getObject(field.ref) || {};
  for (const widget of field.widgets) {
    const states = widget.states || ['Off'];
    const on = states.find(s => s !== 'Off') || 'Yes';
    // A boolean means "whatever this widget calls on". A string is taken literally, so a caller who
    // knows the state name can pick between several on a radio group.
    let target;
    if (value === true || value === 'on' || value === 'yes' || value === '1' && !states.includes('1')) target = on;
    else if (value === false || value == null || value === '' || value === 'off') target = 'Off';
    else target = states.includes(String(value)) ? String(value) : (String(value) ? on : 'Off');

    const wref = widget.ref && widget.ref !== field.ref ? widget.ref : field.ref;
    const wraw = { ...(doc.getObject(wref) || {}) };
    delete wraw.__ref;
    wraw.AS = { name: target };                 // what is DRAWN
    if (wref === field.ref) wraw.V = { name: target };
    w.replace(wref, serialise(wraw));
  }
  if (field.widgets.every(x => x.ref && x.ref !== field.ref)) {
    const states = field.widgets[0].states || ['Off'];
    const on = states.find(s => s !== 'Off') || 'Yes';
    const updated = { ...raw }; delete updated.__ref;
    updated.V = { name: (value && value !== 'off') ? (states.includes(String(value)) ? String(value) : on) : 'Off' };
    w.replace(field.ref, serialise(updated));   // and what the field VALUE is
  }
}

function serialiseFontRes(doc, dr) {
  const fonts = dr && doc.resolve(dr.Font);
  if (!fonts) return '<< >>';
  const parts = [];
  for (const [k, v] of Object.entries(fonts)) if (v instanceof Ref) parts.push(`${pdfName(k)} ${v.num} ${v.gen} R`);
  return `<< ${parts.join(' ')} >>`;
}

/**
 * Appends new object versions and a fresh cross-reference section.
 *
 * Uses a classic xref TABLE even when the original used a cross-reference stream. That is legal —
 * readers follow /Prev across both kinds — and it keeps the appended part in plain text, so the
 * change we made is readable in a text editor. For a document whose provenance may be questioned,
 * being able to see the diff without tooling is worth more than a few hundred bytes.
 */
class IncrementalWriter {
  constructor(doc, original) {
    this.doc = doc;
    this.original = original;
    this.updates = new Map();          // objNum -> body string
    this.streams = new Map();          // objNum -> {dict, data}
    this.nextNum = Number(doc.trailer.Size) || (Math.max(0, ...doc.xref.keys()) + 1);
  }

  replace(num, body) { if (num != null) this.updates.set(num, body); }

  addStream(dictStr, data) {
    const num = this.nextNum++;
    const compressed = deflateSync(data);
    this.streams.set(num, {
      dict: dictStr.replace(/>>\s*$/, `/Length ${compressed.length} /Filter /FlateDecode >>`),
      data: compressed
    });
    return new Ref(num, 0);
  }

  build() {
    const chunks = [this.original];
    let offset = this.original.length;
    // A file not ending in a newline would run the first appended object onto the %%EOF line.
    if (this.original[offset - 1] !== 0x0a) { chunks.push(Buffer.from('\n')); offset += 1; }

    const offsets = new Map();
    const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); chunks.push(buf); offset += buf.length; };

    for (const [num, body] of this.updates) {
      offsets.set(num, offset);
      push(`${num} 0 obj\n${body}\nendobj\n`);
    }
    for (const [num, { dict, data }] of this.streams) {
      offsets.set(num, offset);
      push(`${num} 0 obj\n${dict}\nstream\n`);
      push(data);
      push('\nendstream\nendobj\n');
    }

    // Contiguous runs become one subsection; an xref table requires ascending order.
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const runs = [];
    for (const n of nums) {
      const last = runs[runs.length - 1];
      if (last && n === last.start + last.items.length) last.items.push(n);
      else runs.push({ start: n, items: [n] });
    }

    const xrefAt = offset;
    let xref = 'xref\n';
    for (const run of runs) {
      xref += `${run.start} ${run.items.length}\n`;
      for (const n of run.items) xref += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);

    const prev = this.findPrevXref();
    const size = Math.max(this.nextNum, Number(this.doc.trailer.Size) || 0);
    const root = this.doc.trailer.Root instanceof Ref ? `${this.doc.trailer.Root.num} ${this.doc.trailer.Root.gen} R` : '';
    const info = this.doc.trailer.Info instanceof Ref ? ` /Info ${this.doc.trailer.Info.num} ${this.doc.trailer.Info.gen} R` : '';
    const ids = Array.isArray(this.doc.trailer.ID) ? ` /ID ${serialise(this.doc.trailer.ID)}` : '';
    push(`trailer\n<< /Size ${size} /Root ${root}${info}${ids} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }

  /** The offset the ORIGINAL file's startxref pointed at — our /Prev. */
  findPrevXref() {
    const tail = this.original.toString('latin1', Math.max(0, this.original.length - 2048));
    const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
    return m ? Number(m[1]) : 0;
  }
}

/**
 * Fill, then CHECK the result before anyone is allowed to rely on it.
 *
 * The caller asked for "try it and warn if the output looks wrong". A warning is not enough on its
 * own — a contract that opens in one viewer and not another is worse than one that was never sent —
 * so this re-opens the bytes it just produced and confirms the document still parses, still has the
 * same pages, and actually carries the values that were written. Anything short of that is reported
 * as a failure so the caller can fall back rather than deliver it.
 */
export function fillAndVerify(buf, values, opts = {}) {
  let result;
  try { result = fillForm(buf, values, opts); }
  catch (e) { return { ok: false, stage: 'fill', error: e.message }; }

  const before = PdfDocument.open(buf);
  const beforePages = before.pages().length;

  let after;
  try { after = PdfDocument.open(result.bytes); }
  catch (e) {
    return { ok: false, stage: 'verify', error: `The filled file could not be re-opened: ${e.message}`, result };
  }

  const checks = [];
  const afterPages = after.pages().length;
  checks.push({ name: 'reopens', ok: true });
  checks.push({ name: 'page count unchanged', ok: afterPages === beforePages, detail: `${beforePages} → ${afterPages}` });

  const originalIntact = result.bytes.subarray(0, buf.length).equals(buf);
  checks.push({
    name: 'original bytes untouched', ok: originalIntact,
    detail: originalIntact ? 'the file we were given is still present, byte for byte' : 'the original bytes were modified — this should be impossible for an incremental update'
  });

  const { fields: afterFields } = formFields(after);
  const wrote = [];
  for (const key of result.applied) {
    const f = afterFields.find(x => x.name === key || x.name.endsWith('.' + key) || x.name.split('.').pop() === key);
    if (!f) continue;
    // Compare against the value as WRITTEN. Where fillForm had to normalise something (a newline in
    // a single-line field), comparing to the raw request would report a mismatch for a change we
    // made deliberately and already reported.
    const norm = (result.normalised || []).find(n => n.field === (f && f.name));
    const want = norm ? norm.to : values[key];
    const got = f.value;
    const isBox = f.checkbox || f.radio;
    const good = isBox
      ? (want ? (got && got !== 'Off') : (!got || got === 'Off'))
      : String(got == null ? '' : got) === String(want == null ? '' : want);
    wrote.push({ field: key, want, got, ok: good });
  }
  const allWritten = wrote.every(x => x.ok);
  checks.push({
    name: 'values read back', ok: allWritten,
    detail: allWritten ? `${wrote.length} field(s) verified` : wrote.filter(x => !x.ok).map(x => `${x.field}: wanted ${JSON.stringify(x.want)}, read ${JSON.stringify(x.got)}`).join('; ')
  });

  const ok = checks.every(c => c.ok);
  return { ok, stage: ok ? 'done' : 'verify', checks, values: wrote, ...result };
}
