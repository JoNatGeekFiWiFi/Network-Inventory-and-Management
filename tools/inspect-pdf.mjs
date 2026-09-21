// What kind of PDF is this, and how hard will it be to sign?
//
//   node tools/inspect-pdf.mjs some-contract.pdf
//
// "PDF" is not one format. A file written by our own generator, one exported from Word, and one
// produced by Acrobat differ in ways that decide whether placing a signature on page 3 is an
// afternoon or a fortnight. This reports the things that actually drive that, so the decision is
// made from the file rather than from an assumption about it.
//
// Nothing here modifies the file. It is opened read-only.
import { readFileSync, statSync } from 'node:fs';
import { createHash as sha } from 'node:crypto';

const path = process.argv[2];
if (!path) { console.error('usage: node tools/inspect-pdf.mjs <file.pdf>'); process.exit(1); }

const buf = readFileSync(path);
const raw = buf.toString('latin1');
const size = statSync(path).size;

/**
 * Structural markers are read with stream BODIES removed.
 *
 * A PDF is part text, part compressed binary. Scanning the whole file as text means the binary is
 * searched too — and 147 KB of Flate output will contain almost any short byte sequence by
 * coincidence. The first version of this tool did exactly that and reported "existing signatures
 * present" on a form that has none, which is not a harmless cosmetic bug: it is the tool giving a
 * confident wrong answer about the file it exists to describe.
 *
 * Object dictionaries sit BEFORE the `stream` keyword, so everything this tool looks for survives.
 */
const s = raw.replace(/\bstream\r?\n[\s\S]*?endstream/g, 'stream ENDSTREAM');

const out = [];
const say = (label, value, note = '') => out.push({ label, value, note });

// ---- the basics ---------------------------------------------------------------------------------
const header = (s.match(/^%PDF-(\d\.\d)/) || [])[1];
say('File', `${path} · ${(size / 1024).toFixed(0)} KB`);
say("SHA-256", sha("sha256").update(buf).digest("hex"));
if (!header) {
  say('Format', 'NOT A PDF', 'The file does not start with %PDF-. Check it is not a .docx renamed.');
  report(); process.exit(1);
}
say('PDF version', header);

// ---- encryption, which stops everything ------------------------------------------------------------
const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(s);
say('Encrypted', encrypted ? 'YES' : 'no',
  encrypted ? 'Password-protected or permission-restricted. It must be decrypted before anything can be added to it — and if it carries an owner password we do not have, we cannot.' : '');

// ---- how objects are indexed: the fork in the road --------------------------------------------------
//
// A classic xref TABLE is plain text and easy to extend. A cross-reference STREAM (PDF 1.5+) is
// compressed binary, and objects may additionally be packed inside object streams — which means
// finding the page tree requires decoding them first. Almost everything from Word or Acrobat is the
// second kind.
const hasXrefTable = /\nxref\s*\r?\n\s*\d+\s+\d+/.test(s);
const hasXrefStream = /\/Type\s*\/XRef/.test(s);
const objStreams = (s.match(/\/Type\s*\/ObjStm/g) || []).length;

say('Cross-reference', hasXrefStream ? 'cross-reference STREAM (PDF 1.5+)' : hasXrefTable ? 'classic xref table' : 'unclear',
  hasXrefStream
    ? 'Compressed binary index. Extending it means writing one too, and reading it means Flate-decoding first.'
    : hasXrefTable ? 'Plain text index — the easy case to extend.' : 'Could not identify the index; the file may be damaged.');

say('Object streams', objStreams ? `${objStreams} found` : 'none',
  objStreams
    ? 'Objects are packed inside compressed streams, so the page tree cannot be read by scanning the file as text. This is the single biggest cost driver.'
    : 'Objects sit at the top level and can be read directly.');

// ---- pages ------------------------------------------------------------------------------------------
let pageCount = null;
const counts = [...s.matchAll(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/g)].map(m => Number(m[1]));
if (counts.length) pageCount = Math.max(...counts);
const pageObjs = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
say('Pages', pageCount != null ? String(pageCount) : (pageObjs ? `~${pageObjs} (counted objects)` : 'unknown — likely inside an object stream'));

// Page size, which the field-placement UI needs to map a click to PDF coordinates.
const media = s.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
if (media) {
  const w = Math.abs(Number(media[3]) - Number(media[1])), h = Math.abs(Number(media[4]) - Number(media[2]));
  const name = (Math.abs(w - 612) < 2 && Math.abs(h - 792) < 2) ? ' (US Letter)'
    : (Math.abs(w - 595) < 3 && Math.abs(h - 842) < 3) ? ' (A4)' : '';
  say('Page size', `${w.toFixed(0)} x ${h.toFixed(0)} pt${name}`);
} else {
  say('Page size', 'not found at top level', 'Probably inside an object stream.');
}

// ---- THE THING THAT WOULD MAKE THIS EASY --------------------------------------------------------------
//
// If the document is already a fillable form, it has named fields with known rectangles — so a
// signature goes where the form says, and no coordinate-picking UI is needed at all.
const acroForm = /\/AcroForm/.test(s);
const widgets = (s.match(/\/Subtype\s*\/Widget/g) || []).length;
const sigFields = (s.match(/\/FT\s*\/Sig/g) || []).length;
const textFields = (s.match(/\/FT\s*\/Tx/g) || []).length;
say('Fillable form', acroForm ? `YES — ${widgets} field widget(s)` : 'no',
  acroForm
    ? `Already has named fields (${textFields} text, ${sigFields} signature). These carry their own rectangles, so a signature can be placed by field NAME rather than by clicking coordinates — much less to build.`
    : 'No form fields. Signature positions would have to be chosen by clicking on a rendered page.');

// ---- existing signatures, and WHICH KIND ----------------------------------------------------------------
//
// Two very different things both appear as /Type /Sig, and conflating them gives the wrong answer:
//
//   * A USAGE RIGHTS signature (TransformMethod /UR3, reached via the catalog's /Perms). Applied by
//     Adobe to "Reader-enable" a form so that older Adobe Reader would let people save what they
//     typed. It is Adobe's signature, not a person's, and it asserts nothing about the content.
//   * A real SIGNER's signature, in a /FT /Sig field with a value.
//
// Both break when the file is modified, but the consequence differs entirely. Breaking a signer's
// signature destroys evidence. Breaking a usage-rights signature just makes Acrobat display an
// alarming "the document has been altered" banner over a form nobody signed — which is cosmetic,
// but alarming to a customer is not nothing.
const urSig = /\/TransformMethod\s*\/UR3?/.test(s) || /\/Perms\s*\d+\s+\d+\s+R/.test(s);
const realSig = sigFields > 0 || /\/FT\s*\/Sig/.test(s);

if (realSig) {
  say('Existing signatures', "a SIGNER's signature is present",
    'Any modification invalidates it, which destroys evidence. An incremental update preserves the original bytes and so preserves the signature; rewriting the file does not.');
} else if (urSig) {
  say('Existing signatures', 'usage-rights only (Adobe Reader-enabling)',
    "Adobe's own signature, applied so older Reader would allow saving typed data. Nobody has signed the content. Filling or stamping the form breaks it, and Acrobat then shows a \"document has been altered\" banner — cosmetic, but it looks alarming. Dropping the catalog's /Perms entry in the same update removes the banner along with the now-meaningless right.");
}

// ---- linearised / tagged, minor but worth knowing ---------------------------------------------------------
if (/\/Linearized/.test(s)) say('Linearised', 'yes', 'Optimised for web streaming. An incremental update breaks linearisation, which is harmless — readers cope.');

// ---- fonts, which matter if we add text ---------------------------------------------------------------------
const embedded = new Set([...s.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-,]+)/g)].map(m => m[1].replace(/^[A-Z]{6}\+/, '')));
if (embedded.size) say('Fonts used', [...embedded].slice(0, 6).join(', ') + (embedded.size > 6 ? ` +${embedded.size - 6} more` : ''),
  'Any text WE add uses a base-14 font of our own, so these do not have to be matched.');

// ---- the verdict ------------------------------------------------------------------------------------------
const hard = [];
if (encrypted) hard.push('it is encrypted');
if (objStreams) hard.push('objects are inside compressed object streams');
if (hasXrefStream) hard.push('it uses a cross-reference stream');

let verdict, approach;
if (encrypted) {
  verdict = 'BLOCKED until decrypted';
  approach = 'Save an unprotected copy first (in Acrobat or Preview: export/print to PDF without a password), then re-run this.';
} else if (acroForm && widgets) {
  verdict = 'EASIEST PATH AVAILABLE';
  approach = 'It is already a fillable form. Fill fields by name and flatten — no page rendering, no coordinate picking, and the layout is whatever the document already specifies.';
} else if (!objStreams && hasXrefTable) {
  verdict = 'STRAIGHTFORWARD';
  approach = 'Plain xref table and top-level objects. A signature can be stamped on by appending an incremental update, which leaves every original byte in place.';
} else {
  verdict = 'THE HARD CASE';
  approach = `Stamping onto the page needs a real parser first (${hard.join(', ')}). The alternative that works today: keep this file byte-for-byte as the exhibit, and attach a generated signature page bound to its SHA-256.`;
}
say('VERDICT', verdict, approach);

report();

function report() {
  const w = Math.max(...out.map(o => o.label.length));
  console.log('');
  for (const o of out) {
    console.log(`  ${o.label.padEnd(w)}  ${o.value}`);
    if (o.note) for (const line of wrap(o.note, 76)) console.log(`  ${''.padEnd(w)}  ${line}`);
    if (o.note) console.log('');
  }
}
function wrap(t, n) {
  const words = String(t).split(/\s+/); const lines = []; let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > n) { lines.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
