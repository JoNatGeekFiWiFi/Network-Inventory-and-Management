// IRS Form W-9 (Rev. March 2024): what each field is, how a submission is checked, and how it is
// written onto the official PDF.
//
// The blank form ships in forms/irs-fw9-2024-03.pdf — the IRS's own fillable file, unmodified. The
// IRS names its fields "f1_01[0]", "c1_1[3]" and gives them no tooltips, so their meaning is pinned
// here by hand, checked against the printed page (positions noted beside each). test/w9.mjs opens
// the real file and fails if any field named here is missing, so a new revision of the form cannot
// be dropped in and silently fill the wrong boxes.
//
// THE TAXPAYER IDENTIFICATION NUMBER. The full TIN exists in exactly two places: the signer's
// browser while they type it, and the signed PDF. It is never written to a database column, an
// audit line, an event, or a log. What the platform keeps is the last four digits and whether it is
// an SSN or EIN — enough to tell two W-9s apart, useless to anyone who steals the database. The
// signed PDF itself is filed under the vendor and readable by NOC/Admin only.
//
// Electronic W-9s are allowed by the IRS provided the system makes reasonably sure the person
// submitting is the person named, records every access that leads to a submission, keeps the
// information exactly as submitted, and can produce a paper copy on request; the signature must be
// made under the same penalties-of-perjury statement the paper form prints. That is what the signing
// flow provides (personal link, consent, hash-chained event log, frozen and hashed PDFs), and why the
// certification below is shown verbatim rather than paraphrased. None of this is tax advice.
import { readFileSync } from 'node:fs';
import { fillAndVerify } from './pdffill.js';
import { stampPage, signatureOps, textOps, lineOps } from './pdfstamp.js';
import { fileURLToPath } from 'node:url';

export const W9_FORM = {
  kind: 'w9',
  revision: '2024-03',
  title: 'Form W-9 — Request for Taxpayer Identification Number and Certification',
  file: fileURLToPath(new URL('../forms/irs-fw9-2024-03.pdf', import.meta.url)),
  sha256: 'ef4ba1787c3fa4bc75d090ded2d3cdba9aa5cdf2aa17854211409a594fd16c6a'
};

const P = 'topmostSubform[0].Page1[0].';
const BOX = P + 'Boxes3a-b_ReadOrder[0].';
export const W9_FIELDS = {
  name: P + 'f1_01[0]',                  // Line 1  — name of entity/individual
  business_name: P + 'f1_02[0]',         // Line 2  — business name / disregarded entity name
  llc_class: BOX + 'f1_03[0]',           // Line 3a — LLC tax classification (C, S or P), one character
  other_text: BOX + 'f1_04[0]',          // Line 3a — "Other" description
  foreign_partners: BOX + 'c1_2[0]',     // Line 3b — foreign partners, owners or beneficiaries
  exempt_payee: P + 'f1_05[0]',          // Line 4  — exempt payee code
  fatca_code: P + 'f1_06[0]',            // Line 4  — FATCA exemption code
  address: P + 'Address_ReadOrder[0].f1_07[0]',       // Line 5 — address
  city_state_zip: P + 'Address_ReadOrder[0].f1_08[0]',// Line 6 — city, state, ZIP
  requester: P + 'f1_09[0]',             // Requester's name and address (optional)
  account_numbers: P + 'f1_10[0]',       // Line 7  — account number(s)
  ssn1: P + 'f1_11[0]', ssn2: P + 'f1_12[0]', ssn3: P + 'f1_13[0]',   // Part I SSN 3-2-4
  ein1: P + 'f1_14[0]', ein2: P + 'f1_15[0]'                          // Part I EIN 2-7
};

/** Line 3a boxes, in the order they are printed. Exactly one is checked. */
export const W9_CLASSIFICATIONS = [
  ['individual', 'Individual / sole proprietor', BOX + 'c1_1[0]'],
  ['c_corp', 'C corporation', BOX + 'c1_1[1]'],
  ['s_corp', 'S corporation', BOX + 'c1_1[2]'],
  ['partnership', 'Partnership', BOX + 'c1_1[3]'],
  ['trust', 'Trust / estate', BOX + 'c1_1[4]'],
  ['llc', 'LLC', BOX + 'c1_1[5]'],
  ['other', 'Other', BOX + 'c1_1[6]']
];

/**
 * Where things are drawn that the form has no field for, in PDF points on page 1.
 * Measured from the page's own text positions: "Signature of U.S. person" at x 76, y 196–204;
 * "Date" at x 385.6, y 196; item 2 of the certification on the lines at y 302.3, 293.3, 284.3.
 */
export const W9_LAYOUT = {
  page: 0,
  signatureBox: [128, 194, 372, 222],
  date: { x: 408, y: 197, size: 10 },
  item2Lines: [{ x0: 36, y: 304.9 }, { x0: 45, y: 295.9 }, { x0: 45, y: 286.9 }],
  item2Right: 576
};

/**
 * The Part II certification, word for word from the form, so the signer agrees to the same
 * statement the paper W-9 prints. test/w9.mjs checks this text against the PDF itself.
 */
export const W9_CERTIFICATION = [
  'Under penalties of perjury, I certify that:',
  '1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and',
  '2. I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and',
  '3. I am a U.S. citizen or other U.S. person (defined below); and',
  '4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.'
];
export const W9_CERTIFICATION_NOTE = 'You must cross out item 2 above if you have been notified by the IRS that you are currently subject to backup withholding because you have failed to report all interest and dividends on your tax return.';

let _blank = null;
/** The blank form's bytes, read once. Throws if the file on disk is not the one this map was made for. */
export function w9Blank() {
  if (_blank) return _blank;
  const buf = readFileSync(W9_FORM.file);
  _blank = buf;
  return buf;
}

// ---- checking a submission ----------------------------------------------------------------------------

const clean = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/**
 * Validate and normalise W-9 answers.
 *
 * `requireTin` is false for the PRE-FILL staff send (we never ask staff for the vendor's TIN, and
 * would not store it if they gave it) and true for the signer's submission.
 *
 * Returns { ok, errors: {field: message}, values }. `values` never contains the TIN on the prefill
 * path — it is stripped, not just left empty.
 */
export function validateW9(input = {}, { requireTin = true } = {}) {
  const v = {
    name: clean(input.name, 120),
    business_name: clean(input.business_name, 120),
    classification: W9_CLASSIFICATIONS.some(c => c[0] === input.classification) ? input.classification : '',
    llc_class: clean(input.llc_class, 1).toUpperCase(),
    other_text: clean(input.other_text, 60),
    foreign_partners: !!input.foreign_partners && input.foreign_partners !== 'false' && input.foreign_partners !== '0',
    exempt_payee: clean(input.exempt_payee, 3),
    fatca_code: clean(input.fatca_code, 3).toUpperCase(),
    address: clean(input.address, 120),
    city_state_zip: clean(input.city_state_zip, 120),
    account_numbers: clean(input.account_numbers, 120),
    tin_type: ['ssn', 'ein'].includes(input.tin_type) ? input.tin_type : '',
    tin: digits(input.tin),
    backup_withholding: !!input.backup_withholding && input.backup_withholding !== 'false' && input.backup_withholding !== '0'
  };
  const errors = {};
  if (requireTin) {
    if (!v.name) errors.name = 'Enter the name shown on your income tax return.';
    if (!v.classification) errors.classification = 'Choose one federal tax classification.';
    if (!v.address) errors.address = 'Enter your street address.';
    if (!v.city_state_zip) errors.city_state_zip = 'Enter your city, state and ZIP code.';
  }
  if (v.classification === 'llc' && v.llc_class && !['C', 'S', 'P'].includes(v.llc_class)) errors.llc_class = 'For an LLC, enter C, S or P.';
  if (requireTin && v.classification === 'llc' && !v.llc_class) errors.llc_class = 'For an LLC, enter its tax classification: C, S or P.';
  if (v.classification !== 'llc') v.llc_class = '';
  if (requireTin && v.classification === 'other' && !v.other_text) errors.other_text = 'Describe the classification.';
  if (v.classification !== 'other') v.other_text = '';
  if (v.exempt_payee && !/^([1-9]|1[0-3])$/.test(v.exempt_payee)) errors.exempt_payee = 'Exempt payee codes are 1 to 13.';
  if (v.fatca_code && !/^[A-M]$/.test(v.fatca_code)) errors.fatca_code = 'FATCA exemption codes are a single letter, A to M.';

  if (requireTin) {
    if (!v.tin_type) errors.tin_type = 'Choose whether you are giving a Social Security number or an EIN.';
    else if (v.tin.length !== 9) errors.tin = `A ${v.tin_type === 'ssn' ? 'Social Security number' : 'EIN'} has 9 digits.`;
    else if (v.tin_type === 'ssn' && (/^(000|666|9)/.test(v.tin) || v.tin.slice(3, 5) === '00' || v.tin.slice(5) === '0000')) {
      errors.tin = 'That is not a valid Social Security number.';
    } else if (/^(\d)\1{8}$/.test(v.tin) || v.tin === '123456789') errors.tin = 'That does not look like a real number — please check it.';
    // Sole proprietors may give either; entities give an EIN. The form's own instructions.
    if (!errors.tin_type && v.tin_type === 'ssn' && ['c_corp', 's_corp', 'partnership', 'trust'].includes(v.classification)) {
      errors.tin_type = 'A corporation, partnership or trust gives its EIN, not a Social Security number.';
    }
  } else {
    // Staff pre-fill: the TIN is not accepted at all, so it cannot be stored by accident.
    v.tin = ''; v.tin_type = ''; v.backup_withholding = false;
  }
  return { ok: Object.keys(errors).length === 0, errors, values: v };
}

/** Answers → PDF field values, for lib/pdffill.js. */
export function w9FieldValues(v, { requester = '' } = {}) {
  const out = {
    [W9_FIELDS.name]: v.name || '',
    [W9_FIELDS.business_name]: v.business_name || '',
    [W9_FIELDS.llc_class]: v.llc_class || '',
    [W9_FIELDS.other_text]: v.other_text || '',
    [W9_FIELDS.foreign_partners]: !!v.foreign_partners,
    [W9_FIELDS.exempt_payee]: v.exempt_payee || '',
    [W9_FIELDS.fatca_code]: v.fatca_code || '',
    [W9_FIELDS.address]: v.address || '',
    [W9_FIELDS.city_state_zip]: v.city_state_zip || '',
    [W9_FIELDS.account_numbers]: v.account_numbers || '',
    [W9_FIELDS.requester]: requester || ''
  };
  for (const [key, , field] of W9_CLASSIFICATIONS) out[field] = v.classification === key;
  const t = v.tin || '';
  const ssn = v.tin_type === 'ssn' && t.length === 9, ein = v.tin_type === 'ein' && t.length === 9;
  out[W9_FIELDS.ssn1] = ssn ? t.slice(0, 3) : ''; out[W9_FIELDS.ssn2] = ssn ? t.slice(3, 5) : ''; out[W9_FIELDS.ssn3] = ssn ? t.slice(5) : '';
  out[W9_FIELDS.ein1] = ein ? t.slice(0, 2) : ''; out[W9_FIELDS.ein2] = ein ? t.slice(2) : '';
  return out;
}

/** What the vendor record keeps from a signed W-9. No full TIN, by construction. */
export function w9Summary(v) {
  return {
    legal_name: v.name,
    business_name: v.business_name || null,
    tax_classification: v.classification === 'trust' ? 'other' : v.classification,
    tin_type: v.tin_type,
    tin_last4: v.tin ? v.tin.slice(-4) : null,
    address: [v.address, v.city_state_zip].filter(Boolean).join(', '),
    backup_withholding: !!v.backup_withholding
  };
}

/** A TIN as it may appear on screen or in a log: last four only. */
/** A TIN as it may appear on screen, in a log, or on a certificate: last four only, in words
 * (the certificate's base-14 font has no bullet glyph, so "•••" printed as "---"). */
export const maskTin = (type, tin) => `${String(type || '').toUpperCase()} ending ${String(tin || '').slice(-4)}`;

/**
 * The completed W-9: the official form, filled, then signed and dated on the page.
 *
 * `base` is the PDF the signer was SENT (blank or pre-filled). Both steps append to it, so the sent
 * bytes are an unchanged prefix of the result — the property the certificate relies on.
 *
 * Throws if the fill cannot be verified; a W-9 that opens blank in Acrobat is worse than an error.
 */
export function renderSignedW9({ base, values, signature, dateText, requester = '' }) {
  const filled = fillAndVerify(base, w9FieldValues(values, { requester }));
  if (!filled.ok) throw new Error('The W-9 could not be filled reliably: ' + (filled.error || (filled.checks || []).filter(c => !c.ok).map(c => c.name + ' — ' + (c.detail || '')).join('; ')));
  const L = W9_LAYOUT;
  const ops = [];
  if (signature && signature.kind === 'typed' && signature.typed) {
    ops.push(textOps(signature.typed, L.signatureBox[0] + 2, L.signatureBox[1] + 5, { size: 15, font: 'GFHelvO', colour: [0, 0, 0.55] }));
  } else if (signature && signature.strokes) {
    ops.push(signatureOps(signature.strokes, L.signatureBox));
  }
  if (dateText) ops.push(textOps(dateText, L.date.x, L.date.y, { size: L.date.size }));
  if (values.backup_withholding) {
    // Item 2 crossed out, as the form instructs for someone the IRS has notified.
    for (const line of L.item2Lines) ops.push(lineOps(line.x0, line.y, L.item2Right, line.y, { width: 0.9 }));
    ops.push(textOps('Item 2 crossed out by signer: subject to backup withholding', 360, 330, { size: 6.5, colour: [0.6, 0, 0] }));
  }
  return { bytes: stampPage(filled.bytes, L.page, ops.join('\n')), filled };
}

/** The as-sent form: blank, or pre-filled with what staff already know (never a TIN). */
export function renderSentW9({ prefill = null, requester = '' } = {}) {
  const blank = w9Blank();
  const hasAny = prefill && Object.entries(prefill).some(([k, v]) => v && !['tin', 'tin_type'].includes(k));
  if (!hasAny && !requester) return blank;
  const vals = w9FieldValues({ ...(prefill || {}), tin: '', tin_type: '' }, { requester });
  const r = fillAndVerify(blank, vals);
  if (!r.ok) throw new Error('The W-9 could not be pre-filled reliably: ' + (r.error || 'verification failed'));
  return r.bytes;
}
