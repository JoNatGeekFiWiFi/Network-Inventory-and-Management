// Form W-9: the field map against the real IRS file, validation, and the signed PDF.
//
// Everything here reads the actual form in forms/ rather than a made-up one. The IRS does not label
// its fields, so the map in lib/w9.js is hand-made — and a hand-made map is exactly the thing that
// passes every test written from the same assumptions and then fills the wrong box. So the checks
// here go to the file: the fields exist, the certification text matches what is printed, and the
// completed PDF, read back by the independent reader, says what was entered.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  W9_FORM, W9_FIELDS, W9_CLASSIFICATIONS, W9_CERTIFICATION, validateW9, w9FieldValues,
  renderSentW9, renderSignedW9, w9Summary, maskTin
} from '../lib/w9.js';
import { PdfDocument, formFields, pageText } from '../lib/pdfread.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
// pageText leaves a \r wherever the PDF split a line into separate text runs — often mid-word.
const flat = (s) => s.replace(/\r/g, '').replace(/\s+/g, ' ').replace(/\\/g, '').trim();

// ---- the file is the one the map was made for ----
const blank = readFileSync(W9_FORM.file);
ok(createHash('sha256').update(blank).digest('hex') === W9_FORM.sha256, 'forms/ holds the exact IRS file the field map was built against');
const doc = PdfDocument.open(blank);
const fields = formFields(doc).fields;
const names = new Set(fields.map(f => f.name));
const mapped = [...Object.values(W9_FIELDS), ...W9_CLASSIFICATIONS.map(c => c[2])];
const missing = mapped.filter(n => !names.has(n));
ok(missing.length === 0, `every field the map names exists in the PDF${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);
ok(fields.every(f => !f.value || f.value === 'Off'), 'and the bundled form is blank');
const text = flat(pageText(blank)[0]);
ok(/Rev\. March 2024/.test(text), 'it is the March 2024 revision');

// The signer agrees to the certification as WE show it. It must be the form's own words.
for (const [i, line] of W9_CERTIFICATION.entries()) {
  ok(text.includes(flat(line)), `certification line ${i} matches the printed form word for word`);
}

// ---- the classification boxes are in printed order ----
{
  const rect = (n) => fields.find(f => f.name === n).widgets[0].rect;
  const [ind, ccorp, , , trust, llc, other] = W9_CLASSIFICATIONS.map(c => rect(c[2]));
  ok(ind[0] < ccorp[0] && Math.abs(ind[1] - ccorp[1]) < 2, 'Individual is left of C corporation on the same row');
  ok(ccorp[0] < trust[0], 'Trust/estate is further right on that row');
  ok(llc[1] < ind[1] && Math.abs(llc[0] - ind[0]) < 2, 'LLC is the next row down, under Individual');
  ok(other[1] < llc[1], 'Other is below LLC');
  const ssn = rect(W9_FIELDS.ssn1), ein = rect(W9_FIELDS.ein1);
  ok(ssn[1] > ein[1], 'the SSN boxes are above the EIN boxes, as printed');
}

// ---- validation ----
{
  const good = { name: 'Pat Contractor', classification: 'individual', address: '1 Main St', city_state_zip: 'Phoenix, AZ 85001', tin_type: 'ssn', tin: '521-45-6789' };
  ok(validateW9(good).ok, 'a complete individual W-9 with an SSN validates');
  ok(validateW9({ ...good, tin: '521456789' }).values.tin === '521456789', 'dashes and spaces are stripped from the number');
  const e = (patch) => validateW9({ ...good, ...patch }).errors;
  ok(e({ name: '' }).name, 'line 1 is required');
  ok(e({ classification: '' }).classification, 'a classification is required');
  ok(e({ classification: 'banana' }).classification, 'an unknown classification is refused');
  ok(e({ tin: '52145678' }).tin, 'eight digits is refused');
  ok(e({ tin: '000-12-3456' }).tin, 'an SSN starting 000 is refused');
  ok(e({ tin: '666-12-3456' }).tin, 'an SSN starting 666 is refused');
  ok(e({ tin: '900-12-3456' }).tin, 'an SSN starting 9 (an ITIN range) is refused as an SSN');
  ok(e({ tin: '111-11-1111' }).tin, 'all one digit is refused');
  ok(e({ tin_type: '' }).tin_type, 'the number type must be chosen');
  ok(e({ classification: 'c_corp' }).tin_type, 'a corporation giving an SSN is refused — entities give an EIN');
  ok(e({ classification: 'llc' }).llc_class, 'an LLC must say C, S or P');
  ok(!e({ classification: 'llc', llc_class: 's' }).llc_class, 'and a lowercase answer is accepted');
  ok(validateW9({ ...good, classification: 'llc', llc_class: 's' }).values.llc_class === 'S', 'normalised to upper case');
  ok(e({ classification: 'llc', llc_class: 'Q' }).llc_class, 'but not a letter the form does not allow');
  ok(!validateW9({ ...good, llc_class: 'C' }).values.llc_class, 'an LLC letter is dropped when LLC is not the classification');
  ok(e({ exempt_payee: '14' }).exempt_payee, 'exempt payee codes stop at 13');
  ok(e({ fatca_code: 'Z' }).fatca_code, 'FATCA codes stop at M');
  const staff = validateW9({ ...good }, { requireTin: false });
  ok(staff.values.tin === '' && staff.values.tin_type === '', 'on the staff pre-fill path a TIN is STRIPPED, so it cannot be stored even if sent');
  ok(validateW9({ name: 'Just a name' }, { requireTin: false }).ok, 'and a partial pre-fill is fine');
  ok(validateW9({ name: 'A\nB' }).values.name === 'A B', 'newlines cannot break a single-line field');
}

// ---- the as-sent form ----
{
  ok(renderSentW9({}).equals(blank), 'a blank request sends the IRS file byte for byte');
  const pre = renderSentW9({ prefill: { name: 'Pre Filled LLC', classification: 'llc', llc_class: 'P', address: '9 Oak Ave' }, requester: 'GeekiTek, Phoenix AZ' });
  ok(pre.subarray(0, blank.length).equals(blank), 'a pre-filled form is the IRS file plus an appended update');
  const f = formFields(PdfDocument.open(pre)).fields;
  const val = (n) => (f.find(x => x.name === n) || {}).value;
  ok(val(W9_FIELDS.name) === 'Pre Filled LLC' && val(W9_FIELDS.address) === '9 Oak Ave', 'pre-filled values read back from the PDF');
  ok(val(W9_FIELDS.requester) === 'GeekiTek, Phoenix AZ', "and the requester's name and address are ours");
  ok(!val(W9_FIELDS.ssn1) && !val(W9_FIELDS.ein1) && !val(W9_FIELDS.ein2), 'no TIN is ever pre-filled');
}

// ---- the signed form ----
{
  const sent = renderSentW9({ prefill: { name: 'Ada Vendor' } });
  const v = validateW9({ name: 'Ada Vendor', business_name: 'Ada Fiber LLC', classification: 'llc', llc_class: 'S', address: '12 Splice Rd', city_state_zip: 'Mesa, AZ 85201', tin_type: 'ein', tin: '87-6543219', backup_withholding: true }).values;
  const strokes = [[{ x: 0, y: 30 }, { x: 40, y: 0 }, { x: 80, y: 28 }], [{ x: 100, y: 10 }]];
  const { bytes } = renderSignedW9({ base: sent, values: v, signature: { kind: 'drawn', strokes }, dateText: '09/23/2026', requester: 'GeekiTek' });

  ok(bytes.subarray(0, sent.length).equals(sent), 'the signed W-9 begins with the exact bytes that were sent — the hash of what they saw still verifies');
  const d = PdfDocument.open(bytes);
  ok(d.pages().length === doc.pages().length, 'page count unchanged');
  const f = formFields(d).fields;
  const val = (n) => (f.find(x => x.name === n) || {}).value;
  ok(val(W9_FIELDS.name) === 'Ada Vendor' && val(W9_FIELDS.business_name) === 'Ada Fiber LLC', 'lines 1 and 2 read back');
  ok(val(W9_FIELDS.ein1) === '87' && val(W9_FIELDS.ein2) === '6543219', 'the EIN is split 2-7 into the right boxes');
  ok(!val(W9_FIELDS.ssn1) && !val(W9_FIELDS.ssn2) && !val(W9_FIELDS.ssn3), 'and the SSN boxes stay empty');
  ok(val(W9_FIELDS.llc_class) === 'S', 'the LLC classification letter');
  const llc = W9_CLASSIFICATIONS.find(c => c[0] === 'llc')[2];
  ok(val(llc) && val(llc) !== 'Off', 'the LLC box is checked');
  ok(W9_CLASSIFICATIONS.filter(c => c[0] !== 'llc').every(c => !val(c[2]) || val(c[2]) === 'Off'), 'and no other classification box is');
  const p1 = flat(pageText(bytes)[0]);
  ok(p1.includes('09/23/2026'), 'the date is on the page');
  ok(p1.includes('Item 2 crossed out'), 'backup withholding: item 2 is crossed out and marked');

  const s = validateW9({ name: 'Sam Sole', classification: 'individual', address: 'a', city_state_zip: 'b', tin_type: 'ssn', tin: '521-45-6789' }).values;
  const typed = renderSignedW9({ base: blank, values: s, signature: { kind: 'typed', typed: 'Sam Sole' }, dateText: '01/02/2027' }).bytes;
  const tf = formFields(PdfDocument.open(typed)).fields;
  const tv = (n) => (tf.find(x => x.name === n) || {}).value;
  ok(tv(W9_FIELDS.ssn1) === '521' && tv(W9_FIELDS.ssn2) === '45' && tv(W9_FIELDS.ssn3) === '6789', 'an SSN is split 3-2-4');
  ok(flat(pageText(typed)[0]).includes('Sam Sole'), 'a typed signature is drawn on the signature line');
  ok(!flat(pageText(typed)[0]).includes('Item 2 crossed out'), 'and item 2 is left alone when they are not subject to backup withholding');
}

// ---- what is kept ----
{
  const v = validateW9({ name: 'X', classification: 'individual', address: 'a', city_state_zip: 'b', tin_type: 'ssn', tin: '521-45-6789' }).values;
  const sum = w9Summary(v);
  ok(sum.tin_last4 === '6789' && !JSON.stringify(sum).includes('521456789') && !JSON.stringify(sum).includes('52145'), 'the summary the database keeps has the last four and nothing more');
  ok(maskTin('ssn', '521456789') === 'SSN ending 6789', 'masked for display');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
