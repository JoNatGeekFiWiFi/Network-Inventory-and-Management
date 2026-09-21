// Filling a real form, and proving the result is usable.
//
// Every assertion here runs against an actual IRS W-9 rather than a file we generated, because the
// failures that matter in this area are all consequences of what real producers do.
//
// THE THREE FAILURES THIS EXISTS TO CATCH, none of which throw an error:
//
//   1. XFA left in place. Acrobat prefers the XFA definition over the AcroForm fields, so a filled
//      form looks right in Preview and every browser and BLANK in Acrobat — which is what a
//      company's finance department opens a W-9 in.
//   2. A value with no appearance. /V and the visible appearance are separate things. Set only /V
//      and the data is present, correct, and invisible.
//   3. The wrong checkbox state. The "on" name is arbitrary and per-widget; this form uses "1"
//      through "7". Writing /Yes produces a box that is neither on nor off and renders unticked.
import { readFileSync } from 'node:fs';
import { PdfDocument, formFields, PdfStream, capabilities } from '../lib/pdfread.js';
import { fillForm, fillAndVerify, parseDA, textAppearance } from '../lib/pdffill.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const W9 = () => readFileSync(new URL('./fixtures/w9-fillable-2024.pdf', import.meta.url));
const FLAT = () => readFileSync(new URL('./fixtures/w9-flat-2025.pdf', import.meta.url));

// ---- the pieces ------------------------------------------------------------------------------------
{
  const da = parseDA('/HelveticaLTStd-Bold 9.00 Tf 0 g');
  ok(da.font === 'HelveticaLTStd-Bold' && da.size === 9, 'a /DA string yields its font and size');
  ok(parseDA('/Helv 0 Tf 0 g').size === 0, 'size 0 is preserved, meaning auto-size');
  ok(parseDA('').font === 'Helv', 'a missing /DA falls back rather than throwing');

  const ap = textAppearance('Hello', { width: 200, height: 14, font: 'Helv', size: 9, colour: '0 g' });
  ok(ap.includes('/Tx BMC') && ap.includes('EMC'), 'an appearance is wrapped in the marked content a form field expects');
  ok(ap.includes('BT') && ap.includes('ET') && ap.includes('(Hello) Tj'), 'and draws the text');
  ok(ap.includes('re W n'), 'clipped to the box, so a long value cannot spill across the page');

  // A comb field — an SSN box — spaces characters into cells. Drawn normally they pile into one.
  const comb = textAppearance('12345', { width: 100, height: 20, font: 'Helv', size: 10, colour: '0 g', comb: 5 });
  ok((comb.match(/Tj/g) || []).length === 5, 'a comb field draws each character separately, one per cell');

  const esc = textAppearance('a(b)c\\d', { width: 200, height: 14, font: 'Helv', size: 9, colour: '0 g' });
  ok(esc.includes('\\(') && esc.includes('\\)'), 'parentheses in a value are escaped, or they end the string early');
}

// ---- filling the real thing ---------------------------------------------------------------------------
{
  const before = capabilities(W9());
  ok(before.xfa === true, 'the 2024 W-9 is confirmed to be an XFA hybrid before we start');

  const r = fillAndVerify(W9(), {
    'f1_01[0]': 'GeekiTek LLC',
    'f1_02[0]': 'GeekFi WiFi',
    'f1_07[0]': '1200 E Washington St',
    'f1_08[0]': 'Phoenix, AZ 85034',
    'f1_14[0]': '86',
    'f1_15[0]': '1234567',
    'c1_1[2]': true
  });

  ok(r.ok, r.ok ? 'a W-9 fills and passes every verification' : `fill failed at ${r.stage}: ${r.error || JSON.stringify(r.checks)}`);
  if (!r.ok) { console.log(`RESULT: ${pass} passed, ${fail} failed`); process.exit(1); }

  ok(r.applied.length === 7 && !r.unmatched.length, 'every field named was matched');
  ok(!r.ambiguous.length, 'and none were ambiguous');

  // THE INCREMENTAL GUARANTEE. The file we were given is still in there, unchanged.
  ok(r.bytes.subarray(0, W9().length).equals(W9()),
    'the original bytes are present byte-for-byte at the front — the blank form we sent is inside the one that came back');
  ok(r.bytes.length > W9().length, `and the changes are appended (${W9().length} → ${r.bytes.length} bytes)`);

  const after = PdfDocument.open(r.bytes);
  const { fields, xfa } = formFields(after);

  // 1. XFA.
  ok(xfa === false, 'XFA is REMOVED — otherwise Acrobat renders the empty XML form and ignores everything we wrote');
  ok(after.catalog.Perms === undefined,
    'and the usage-rights signature is dropped, so Acrobat does not show "this document has been altered" over a form nobody signed');

  // 2. Values readable AND drawn.
  const find = (n) => fields.find(f => f.name.endsWith(n));
  ok(find('f1_01[0]').value === 'GeekiTek LLC', 'the value reads back');

  const drawn = (n) => {
    const f = find(n);
    const ap = after.resolve(after.getObject(f.ref).AP);
    const stream = ap && after.resolve(ap.N);
    if (!(stream instanceof PdfStream)) return null;
    return [...after.streamData(stream).toString('latin1').matchAll(/\((.*?)\)\s*Tj/g)].map(m => m[1]).join('');
  };
  ok(drawn('f1_01[0]') === 'GeekiTek LLC',
    'and is DRAWN into the appearance stream — a value with no appearance is present, correct and invisible');
  ok(drawn('f1_08[0]') === 'Phoenix, AZ 85034', 'a second field too');
  ok(drawn('f1_15[0]') === '1234567', 'including the EIN box');

  // 3. The checkbox, with the state this form actually uses.
  const box = find('c1_1[2]');
  ok(box.value === '3', `the ticked box carries its real on-state (got ${JSON.stringify(box.value)}, not "Yes")`);
  const widgetRef = box.widgets[0].ref || box.ref;
  const asName = after.getObject(widgetRef).AS;
  ok(asName && asName.name === '3', '/AS matches /V, so what is drawn matches what is stored');

  const untouched = find('c1_1[0]');
  ok(!untouched.value || untouched.value === 'Off', 'and the boxes we did not tick are still off');

  // Nothing else moved.
  ok(after.pages().length === 6, 'all six pages survive');
  ok(fields.length === 23, 'and all 23 fields are still there');
}

// ---- pre-filling then filling again, which is the actual workflow ----------------------------------------
{
  // We pre-fill what we know; the vendor corrects it and completes the rest. That means filling a
  // file that has already been filled once — each pass appends another incremental update.
  const first = fillForm(W9(), { 'f1_01[0]': 'Provisional Name', 'f1_07[0]': '1200 E Washington St' });
  const second = fillAndVerify(first.bytes, { 'f1_01[0]': 'Corrected Name Inc', 'f1_08[0]': 'Phoenix, AZ 85034' });

  ok(second.ok, second.ok ? 'a form that was already filled can be filled again' : `second pass failed: ${second.error}`);
  if (second.ok) {
    const doc = PdfDocument.open(second.bytes);
    const { fields } = formFields(doc);
    const find = (n) => fields.find(f => f.name.endsWith(n));
    ok(find('f1_01[0]').value === 'Corrected Name Inc', 'the later value wins');
    ok(find('f1_07[0]').value === '1200 E Washington St', 'while the earlier one that was not re-filled survives');
    ok(second.bytes.subarray(0, first.bytes.length).equals(first.bytes),
      'and the first version is still intact inside the second — the whole history is in the file');
  }
}

// ---- names, and refusing to guess -------------------------------------------------------------------------
{
  // Nobody should have to type "topmostSubform[0].Page1[0].f1_01[0]", and a name that is slightly
  // wrong must not silently fill nothing.
  const byLeaf = fillForm(W9(), { 'f1_01[0]': 'Short name works' });
  ok(byLeaf.applied.length === 1, 'a field can be addressed by its last component alone');

  const byFull = fillForm(W9(), { 'topmostSubform[0].Page1[0].f1_01[0]': 'Full path works' });
  ok(byFull.applied.length === 1, 'or by its full path');

  const wrong = fillForm(W9(), { 'f1_99[0]': 'nope', 'f1_01[0]': 'yes' });
  ok(wrong.unmatched.includes('f1_99[0]'), 'a name that matches nothing is REPORTED, not silently dropped');
  ok(wrong.applied.includes('f1_01[0]'), 'while the ones that do match are still applied');
}

// ---- refusing rather than half-working ------------------------------------------------------------------------
{
  let threw = null;
  try { fillForm(FLAT(), { anything: 'x' }); } catch (e) { threw = e.message; }
  ok(threw && /no fillable form fields/i.test(threw),
    'a flat PDF with no fields is refused with a reason, not filled into nowhere');
  ok(/sent for signature/i.test(threw), 'and the message says what CAN be done with it instead');

  const notPdf = fillAndVerify(Buffer.from('not a pdf at all'), { a: 'b' });
  ok(!notPdf.ok && notPdf.stage === 'fill', 'a non-PDF fails at the fill stage rather than producing bytes');

  // The point of fillAndVerify: it checks its own output before the caller can rely on it.
  const good = fillAndVerify(W9(), { 'f1_01[0]': 'Verified Co' });
  ok(good.checks.find(c => c.name === 'reopens').ok, 'verification re-opens the file it just produced');
  ok(good.checks.find(c => c.name === 'page count unchanged').ok, 'confirms the page count did not change');
  ok(good.checks.find(c => c.name === 'original bytes untouched').ok, 'confirms the original bytes are untouched');
  ok(good.checks.find(c => c.name === 'values read back').ok, 'and reads every value back out again');
  ok(good.checks.length >= 4, 'reporting each check separately, so a partial failure says WHICH part');
}

// ---- values that break naive escaping ---------------------------------------------------------------------------
{
  const awkward = fillAndVerify(W9(), {
    'f1_01[0]': 'Smith (Holdings) \\ Co',
    'f1_02[0]': 'Line one\nline two',
    'f1_07[0]': "O'Brien & Sons"
  });
  ok(awkward.ok, awkward.ok ? 'values containing parentheses, backslashes and newlines are handled' : `failed: ${awkward.error}`);
  if (awkward.ok) {
    const { fields } = formFields(PdfDocument.open(awkward.bytes));
    const v = (n) => (fields.find(f => f.name.endsWith(n)) || {}).value;
    ok(v('f1_01[0]') === 'Smith (Holdings) \\ Co', 'parentheses and backslashes survive the round trip exactly');
    ok(!String(v('f1_02[0]')).includes('\n'), 'and a newline in a single-line field is flattened rather than corrupting the object');
    // A value we could not store as given must be REPORTED, not quietly changed. Otherwise the
    // value read back later differs from the one sent, and it looks like data loss.
    const note = (awkward.normalised || []).find(n => n.field.endsWith('f1_02[0]'));
    ok(!!note, 'and the change is reported back to the caller rather than made silently');
    ok(note && note.from.includes('\n') && !note.to.includes('\n'),
      'saying what it was and what it became');
  }
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
