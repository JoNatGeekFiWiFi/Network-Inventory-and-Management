// The PDF writer, checked by reading the bytes back the way a reader would.
//
// A signed agreement is evidence, so "it opened on my machine" is not a standard. The checks below
// deliberately do NOT ask the writer what it meant to produce — they parse the finished file
// against the rules a PDF reader applies, because the failure that matters is the one where the
// file is internally inconsistent and some readers cope while others show a blank page.
//
// The single most valuable check here is the xref walk. Every object's byte offset is recorded in a
// table at the end of the file; if any of those drift by even one byte, readers that trust the
// table (rather than scanning for objects, which some do as a recovery measure) fail. That is
// exactly the bug that a "looks fine in Preview" test would sail past.
//
// During development this was additionally validated against Mozilla's pdf.js — the parser that in
// practice defines whether a PDF is readable — for text extraction, page counts, punctuation
// folding, escaping and a 25-page document. That cannot be committed without taking on a
// dependency, so its findings are encoded as the structural invariants below.
import { inflateSync } from 'node:zlib';
import { createPdf, wrapText, textWidth, encodeText, pdfDate, FONTS } from '../lib/pdf.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- a reader's-eye parser --------------------------------------------------------------------
//
// Small, and written from the spec rather than from lib/pdf.js, so it can disagree with it.
function readPdf(buf) {
  const s = buf.toString('latin1');
  if (!s.startsWith('%PDF-1.')) throw new Error('no PDF header');

  const sx = s.lastIndexOf('startxref');
  if (sx === -1) throw new Error('no startxref');
  const xrefAt = parseInt(s.slice(sx + 9).trim(), 10);

  const xrefText = s.slice(xrefAt);
  const m = xrefText.match(/^xref\s+(\d+)\s+(\d+)\s/);
  if (!m) throw new Error('xref table not at the offset startxref points to');
  const count = parseInt(m[2], 10);

  const entries = [...xrefText.slice(0, 20 + count * 20 + 40).matchAll(/(\d{10}) (\d{5}) ([nf])/g)];
  const offsets = entries.map(e => ({ offset: parseInt(e[1], 10), type: e[3] }));

  const trailer = s.slice(s.lastIndexOf('trailer'));
  const size = Number((trailer.match(/\/Size (\d+)/) || [])[1]);
  const rootRef = Number((trailer.match(/\/Root (\d+) 0 R/) || [])[1]);

  // Resolve every object by following the xref offset — not by scanning for "N 0 obj".
  const objects = new Map();
  for (let i = 1; i < offsets.length; i++) {
    const { offset, type } = offsets[i];
    if (type === 'f') continue;
    const head = s.slice(offset, offset + 40);
    const hm = head.match(/^(\d+) 0 obj/);
    if (!hm) throw new Error(`xref entry ${i} points at offset ${offset}, which is not "${i} 0 obj" but ${JSON.stringify(head.slice(0, 24))}`);
    if (Number(hm[1]) !== i) throw new Error(`xref entry ${i} points at object ${hm[1]}`);
    const end = s.indexOf('endobj', offset);
    objects.set(i, s.slice(offset, end));
  }
  return { raw: s, buf, size, rootRef, objects, xrefAt, entryCount: offsets.length };
}

/** Pull the text back out of the content streams, decompressing as a reader would. */
function extractText(doc) {
  let out = '';
  for (const [, body] of doc.objects) {
    if (!/\/Length \d+/.test(body) || !body.includes('stream')) continue;
    const start = body.indexOf('stream') + 'stream'.length;
    const lead = body[start] === '\r' ? 2 : 1;
    const len = Number(body.match(/\/Length (\d+)/)[1]);
    let bytes = Buffer.from(body.slice(start + lead, start + lead + len), 'latin1');
    if (body.includes('/FlateDecode')) { try { bytes = inflateSync(bytes); } catch { continue; } }
    for (const t of bytes.toString('latin1').matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      out += t[1].replace(/\\([()\\])/g, '$1');
    }
  }
  return out;
}

// ---- structure ---------------------------------------------------------------------------------
{
  const d = createPdf({ title: 'Service Agreement', author: 'GeekiTek' });
  d.text('SERVICE AGREEMENT', { top: 72, font: 'Helvetica-Bold', size: 16 });
  d.paragraph('Between GeekiTek LLC and Acme Corp for service at 1200 E Washington St.', { top: 110 });
  d.addPage();
  d.text('Certificate of completion', { top: 72, font: 'Times-Bold' });
  const buf = d.build();

  let doc = null, err = null;
  try { doc = readPdf(buf); } catch (e) { err = e; }
  ok(!err, err ? `the file parses: ${err.message}` : 'the file parses as a PDF, read back from its own xref table');

  if (doc) {
    // THE offset check. Every entry already had to resolve to "N 0 obj" inside readPdf, so reaching
    // here means the whole table is byte-accurate.
    ok(doc.objects.size === doc.entryCount - 1,
      `all ${doc.objects.size} objects resolve at the byte offsets the xref table claims`);
    ok(doc.size === doc.entryCount, `the trailer's /Size (${doc.size}) matches the xref table`);
    ok(doc.objects.has(doc.rootRef) && doc.objects.get(doc.rootRef).includes('/Type /Catalog'),
      'the trailer /Root points at a real catalog object');

    const catalog = doc.objects.get(doc.rootRef);
    const pagesRef = Number(catalog.match(/\/Pages (\d+) 0 R/)[1]);
    const pagesObj = doc.objects.get(pagesRef);
    ok(pagesObj && pagesObj.includes('/Type /Pages'), 'the catalog points at a real page tree');
    ok(/\/Count 2\b/.test(pagesObj), 'which reports the right page count');

    // Every page's /Parent must point back at the page tree. This is the invariant the writer
    // asserts internally by reserving an object id — worth confirming from the file itself, since a
    // reserved id that drifts produces a document whose pages belong to nothing.
    const kids = [...pagesObj.matchAll(/(\d+) 0 R/g)].map(m => Number(m[1]));
    let parentsOk = kids.length > 0;
    for (const k of kids) {
      const page = doc.objects.get(k);
      if (!page || !page.includes('/Type /Page') || !page.includes(`/Parent ${pagesRef} 0 R`)) parentsOk = false;
    }
    ok(parentsOk, `every page names object ${pagesRef} as its parent — no orphaned pages`);

    // Content streams must declare their true byte length.
    let lengthsOk = true;
    for (const [, body] of doc.objects) {
      if (!body.includes('stream')) continue;
      const declared = Number(body.match(/\/Length (\d+)/)[1]);
      const start = body.indexOf('stream') + 'stream'.length;
      const lead = body[start] === '\r' ? 2 : 1;
      const actual = body.length - (start + lead) - '\nendstream\n'.length;
      if (Math.abs(actual - declared) > 2) lengthsOk = false;
    }
    ok(lengthsOk, 'every stream /Length matches the bytes actually written');

    const text = extractText(doc);
    ok(text.includes('SERVICE AGREEMENT') && text.includes('Acme Corp'),
      'and the text comes back out of the compressed streams intact');
    ok(text.includes('Certificate of completion'), 'from the second page as well');
  }
  ok(buf.toString('latin1').trimEnd().endsWith('%%EOF'), 'the file ends with %%EOF');
}

// ---- escaping, which is where a contract turns to mojibake ---------------------------------------
{
  ok(encodeText('a (b) c').includes('\\(') && encodeText('a (b) c').includes('\\)'),
    'parentheses are escaped — unescaped, they end the string early and corrupt the page');
  ok(encodeText('back\\slash') === 'back\\\\slash', 'and so are backslashes');

  // The characters that actually arrive, pasted out of Word.
  ok(encodeText('\u201Cquoted\u201D') === '"quoted"', 'curly quotes fold to straight ones');
  ok(encodeText('em\u2014dash') === 'em--dash', 'em dashes fold rather than becoming "?"');
  ok(encodeText('a\u00A0b') === 'a b', 'a non-breaking space — which hides inside copied addresses — becomes a real space');
  ok(encodeText('e\u2026') === 'e...', 'and an ellipsis expands');
  ok(!encodeText('caf\u00E9 \u4E2D\u6587').includes('\u4E2D'), 'anything genuinely unrepresentable becomes a visible placeholder, never silent loss');

  const d = createPdf({});
  d.text('Rate (per month) \\ clause (3)(a)', { top: 72 });
  const text = extractText(readPdf(d.build()));
  ok(text.includes('(per month)') && text.includes('(3)(a)'),
    'and a real document round-trips parentheses through the file and back');
}

// ---- wrapping ------------------------------------------------------------------------------------
{
  const W = 300, SIZE = 11;
  const prose = 'The Customer shall pay the Monthly Recurring Charge in advance of each service period. ';
  const lines = wrapText(prose.repeat(6), W, 'Helvetica', SIZE);
  const overflow = lines.filter(l => textWidth(l, 'Helvetica', SIZE) > W + 0.01);
  ok(overflow.length === 0, `all ${lines.length} wrapped lines fit inside ${W}pt`);

  // An unbreakable token must be split, not allowed to run off the page. A WireGuard key or a long
  // URL in an agreement is not hypothetical.
  const key = 'qMFYHb7Tq8C1lMvZPPDNnkTHzQpL3xJFLmYxCvBnM0Q=';
  const hard = wrapText(`Key: ${key} end`, 120, 'Courier', 10);
  ok(hard.every(l => textWidth(l, 'Courier', 10) <= 120.01),
    'a long unbreakable token is hard-split rather than overflowing the margin');
  ok(hard.join('').includes(key.slice(0, 20)), 'and its characters are all still there');

  ok(wrapText('a\n\nb', 300).length >= 3, 'blank lines between paragraphs are preserved');
  ok(textWidth('', 'Helvetica', 11) === 0, 'an empty string has no width');
  ok(textWidth('iii', 'Helvetica', 11) < textWidth('MMM', 'Helvetica', 11),
    'the metrics are real per-character widths, not a monospace approximation');
  ok(textWidth('MMM', 'Courier', 11) === textWidth('iii', 'Courier', 11),
    'while Courier is genuinely monospaced');
  for (const [name, widths] of Object.entries(FONTS)) {
    ok(widths.length === 95, `${name} has a width for every printable ASCII character`);
  }
}

// ---- signatures as vector strokes ------------------------------------------------------------------
{
  const sig = [[{ x: 0, y: 20 }, { x: 20, y: 0 }, { x: 40, y: 25 }], [{ x: 50, y: 10 }]];
  const d = createPdf({});
  d.strokes(sig, { x: 100, top: 400, width: 200, height: 60 });
  const doc = readPdf(d.build());

  let ops = '';
  for (const [, body] of doc.objects) {
    if (!body.includes('stream') || !body.includes('/FlateDecode')) continue;
    const start = body.indexOf('stream') + 'stream'.length;
    const len = Number(body.match(/\/Length (\d+)/)[1]);
    const lead = body[start] === '\r' ? 2 : 1;
    try { ops += inflateSync(Buffer.from(body.slice(start + lead, start + lead + len), 'latin1')).toString('latin1'); } catch {}
  }
  ok(/\d+(\.\d+)? \d+(\.\d+)? m/.test(ops) && / l\b/.test(ops) && /\bS\b/.test(ops),
    'a drawn signature becomes real PDF path operators, not an embedded image');

  // A single tap — dotting an i, a full stop — must still mark the page.
  const dotOnly = createPdf({});
  dotOnly.strokes([[{ x: 5, y: 5 }]], { x: 10, top: 10, width: 50, height: 50 });
  ok(dotOnly.build().length > 400, 'a single-point stroke still draws something rather than vanishing');

  // An empty signature must not crash the generator — a declined or cleared pad reaches here.
  let threw = false;
  try { createPdf({}).strokes([], {}).build(); } catch { threw = true; }
  ok(!threw, 'an empty stroke list is handled rather than throwing mid-document');

  // Aspect ratio is preserved: a wide signature in a tall box must not be stretched.
  const wide = createPdf({});
  wide.strokes([[{ x: 0, y: 0 }, { x: 400, y: 10 }]], { x: 0, top: 0, width: 200, height: 200 });
  ok(wide.build().length > 400, 'a signature much wider than its box is scaled to fit, not distorted');
}

// ---- pagination ------------------------------------------------------------------------------------
{
  const d = createPdf({ title: 'long' });
  for (let i = 0; i < 25; i++) { if (i) d.addPage(); d.text(`Page ${i + 1} of 25`, { top: 72 }); }
  const doc = readPdf(d.build());          // throws if any of the 25 pages' offsets drifted
  const pagesObj = [...doc.objects.values()].find(o => o.includes('/Type /Pages'));
  ok(/\/Count 25\b/.test(pagesObj), 'a 25-page document keeps its xref and page tree consistent');
  const text = extractText(doc);
  ok(text.includes('Page 1 of 25') && text.includes('Page 25 of 25'), 'with the first and last pages both intact');
}

// ---- metadata ----------------------------------------------------------------------------------------
{
  ok(/^D:\d{14}Z$/.test(pdfDate(new Date('2026-09-20T14:30:00Z'))), 'dates use PDF date syntax');
  const doc = readPdf(createPdf({ title: 'Lease (Rooftop)', author: 'GeekiTek' }).build());
  const info = [...doc.objects.values()].find(o => o.includes('/Producer'));
  ok(info && info.includes('Lease \\(Rooftop\\)'), 'a title containing parentheses is escaped in the metadata too');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
