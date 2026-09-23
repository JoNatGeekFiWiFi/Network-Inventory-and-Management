// Document assembly, merge fields, and the tamper-evident audit chain.
//
// Everything here is pure: it takes data and returns data, with no database and no filesystem. That
// is deliberate — these are the parts whose correctness is hard to argue about after the fact, so
// they need to be testable without standing up a server.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPdf, wrapText, textWidth } from './pdf.js';

// ---- merge fields -----------------------------------------------------------------------------

/**
 * Fields a template may reference, and where each comes from.
 *
 * Declared rather than discovered so the template editor can offer a list and so an unknown field
 * is caught at save time. A typo that silently renders an empty string into a rate or a term length
 * is the failure mode here, and it is not one anybody notices until the document is signed.
 */
export const MERGE_FIELDS = {
  'customer.name': 'Customer name',
  'customer.email': 'Customer email',
  'customer.phone': 'Customer phone',
  'customer.address': 'Customer address',
  'site.name': 'Site name',
  'site.address': 'Site service address',
  'site.unit': 'Unit within the site',
  'pop.name': 'POP name',
  'pop.address': 'POP address',
  'company.name': 'Our company name',
  'company.address': 'Our company address',
  'company.email': 'Our contact email',
  'company.phone': 'Our contact phone',
  'document.title': 'Document title',
  'document.date': "Today's date"
};

// signer.name and signer.role were offered here and could never be filled.
//
// The body is merged ONCE, for the whole document, but a document has several signers — so there is
// no single signer to substitute, and the field printed "[signer.name — NOT SET]" on every document
// that used it. Offering a field that can never have a value is worse than not offering it: the
// editor advertises it, somebody reasonably uses it, and the flaw only shows up in the finished PDF.
//
// Each signer's name is already printed above their own signature block by renderDocument, which is
// where a per-signer value actually belongs.

/** Every {{field}} a template mentions, in order of first appearance, deduplicated. */
export function fieldsUsed(body) {
  const seen = [];
  for (const m of String(body || '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** Fields a template uses that are not in MERGE_FIELDS — a typo, or a field someone invented. */
export function unknownFields(body) {
  return fieldsUsed(body).filter(f => !(f in MERGE_FIELDS));
}

/**
 * Substitute values into a template.
 *
 * A missing value renders as a visible marker, never as an empty string. An agreement that reads
 * "monthly charge of  per month" at least stops someone before it is sent; one where the gap is
 * invisible gets signed. `missing` reports them so the caller can refuse to send.
 */
export function mergeBody(body, values) {
  const missing = [];
  const text = String(body || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = values[key];
    if (v === undefined || v === null || String(v).trim() === '') { missing.push(key); return `[${key} — NOT SET]`; }
    return String(v);
  });
  return { text, missing: [...new Set(missing)] };
}

// ---- tokens ------------------------------------------------------------------------------------

/**
 * A signing link's credential.
 *
 * 32 bytes of randomness, base64url. Only the hash is stored, so a database read does not let
 * someone sign as the customer. SHA-256 rather than scrypt for the same reason as the API tokens:
 * this is high-entropy random, not a guessable password, and it is verified on every page load.
 */
export function makeToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/** Constant-time compare, so a token cannot be recovered a character at a time by timing. */
export function tokenMatches(token, storedHash) {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(String(storedHash || ''), 'hex');
  if (a.length !== b.length || !b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- the audit chain ---------------------------------------------------------------------------

/**
 * Hash one event, covering the previous event's hash.
 *
 * Field order is fixed and explicit. Hashing a JSON.stringify of the row would make the chain
 * depend on key ordering and on which columns happen to exist, so adding a column later would
 * invalidate every historical signature — the chain has to survive the schema evolving.
 */
export function eventHash(ev, prevHash = '') {
  const parts = [
    prevHash || '',
    String(ev.document_id ?? ''),
    String(ev.signer_id ?? ''),
    String(ev.kind ?? ''),
    String(ev.detail ?? ''),
    String(ev.actor ?? ''),
    String(ev.ip ?? ''),
    String(ev.at ?? '')
  ];
  // Length-prefixed, so ("ab","c") and ("a","bc") cannot collide into the same digest.
  return createHash('sha256').update(parts.map(p => `${p.length}:${p}`).join('|')).digest('hex');
}

/**
 * Recompute a chain end to end.
 *
 * Returns the first index that fails, which is the useful answer: it identifies WHICH event was
 * altered or where one was removed, rather than only that something is wrong.
 */
export function verifyChain(events) {
  let prev = '';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expected = eventHash(e, prev);
    if (e.prev_hash !== prev) {
      return { ok: false, index: i, reason: `event ${e.id} expected to follow ${prev.slice(0, 12) || '(start)'} but records ${String(e.prev_hash).slice(0, 12)}` };
    }
    if (e.hash !== expected) {
      return { ok: false, index: i, reason: `event ${e.id} (${e.kind}) has been altered since it was written` };
    }
    prev = e.hash;
  }
  return { ok: true, index: -1, head: prev };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- rendering ---------------------------------------------------------------------------------

const M = { left: 72, right: 72, top: 56, bottom: 52 };
const BODY_W = 612 - M.left - M.right;
const PAGE_H = 792;
const LIMIT = PAGE_H - M.bottom;

/** Human date, unambiguous across regions — "20 September 2026", never 09/20 vs 20/09. */
export function longDate(d = new Date()) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Render the document itself: title, body, and a signature block per signer.
 *
 * `signatures` is optional. Without it this produces the unsigned copy that gets hashed and sent;
 * with it, the completed document. Both come from the SAME function on purpose — if the signed copy
 * were rendered by a second code path, the thing the customer signed and the thing filed afterwards
 * could drift, and nobody would notice until it mattered.
 */
/** Server clock is the time of record. The device clock is kept separately, because a phone can be wrong. */
export function signingWhen(sig = {}) {
  const server = sig.at || sig.signed_at;
  if (!server) return '';
  return /utc/i.test(String(server)) ? String(server) : `${server} UTC`;
}

export function signingDevice(sig = {}) {
  const device = sig.clientAt || sig.signed_client_at;
  if (!device) return '';
  const tz = sig.tz || sig.signed_tz;
  return `${device}${tz ? ' ' + tz : ''}`;
}

/** What the signer's device reported. Empty when this signature predates location capture. */
export function signingPlace(sig = {}) {
  const lat = sig.lat != null ? sig.lat : sig.signed_lat;
  const lng = sig.lng != null ? sig.lng : sig.signed_lng;
  if (lat != null && lng != null && lat !== '' && lng !== '') {
    const acc = sig.accuracy != null ? sig.accuracy : sig.signed_accuracy;
    const accBit = acc != null && acc !== '' ? ` (±${Math.round(Number(acc))} m)` : '';
    return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}${accBit}`;
  }
  return {
    denied: 'Location not shared (permission denied)',
    unavailable: 'Location unavailable on this device',
    timeout: 'Location request timed out',
    unsupported: 'This device does not report location'
  }[sig.geo || sig.signed_geo] || '';
}

function newPageTop() { return M.top; }

/** Split **bold** markers into runs. The markers themselves are not printed. */
function textRuns(text) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0, m;
  const src = String(text);
  while ((m = re.exec(src))) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) runs.push({ text: src.slice(last), bold: false });
  return runs.length ? runs : [{ text: src, bold: false }];
}

function wrapRuns(text, maxWidth, size) {
  const words = [];
  for (const run of textRuns(text)) {
    for (const part of run.text.split(/(\s+)/)) {
      if (part) words.push({ text: part, bold: run.bold });
    }
  }
  const lines = [];
  let line = [], width = 0;
  const fontOf = (bold) => bold ? 'Helvetica-Bold' : 'Helvetica';
  for (const word of words) {
    const ww = textWidth(word.text, fontOf(word.bold), size);
    if (line.length && width + ww > maxWidth && word.text.trim()) { lines.push(line); line = []; width = 0; }
    if (!line.length && !word.text.trim()) continue;
    line.push(word);
    width += ww;
  }
  if (line.length) lines.push(line);
  return lines;
}

function paintRuns(pdf, line, x, top, size) {
  let cx = x;
  for (const run of line) {
    const font = run.bold ? 'Helvetica-Bold' : 'Helvetica';
    pdf.text(run.text, { x: cx, top, font, size });
    cx += textWidth(run.text, font, size);
  }
}

function drawMarkedBody(pdf, body, top) {
  const room = () => { if (top > LIMIT - 16) { pdf.addPage(); top = newPageTop(); } };
  for (const raw of String(body || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { top += 8; continue; }
    let kind = 'p', text = line, size = 10.5, gap = 10.5 * 1.45;
    if (line.startsWith('## ')) { kind = 'h'; text = line.slice(3); size = 12; gap = 18; }
    else if (line.startsWith('# ')) { kind = 'h'; text = line.slice(2); size = 13; gap = 20; }
    const bullet = kind === 'p' && /^[-*]\s+/.test(line);
    if (bullet) text = line.replace(/^[-*]\s+/, '');
    const x = bullet ? M.left + 16 : M.left;
    const width = bullet ? BODY_W - 16 : BODY_W;
    if (kind === 'h') top += 8;
    const visual = kind === 'h'
      ? wrapText(text, width, 'Helvetica-Bold', size).map(t => [{ text: t, bold: true }])
      : wrapRuns(text, width, size);
    for (const runs of visual) {
      room();
      if (bullet && runs === visual[0]) pdf.text('-', { x: M.left + 4, top, size });
      paintRuns(pdf, runs, x, top, size);
      top += gap;
    }
  }
  return top;
}

function stampFooter(pdf, footer) {
  pdf.decorate((index, count) => {
    const y = PAGE_H - 32;
    pdf.line(M.left, y - 8, 612 - M.right, y - 8, { colour: [0.8, 0.8, 0.8], width: 0.4 });
    const label = wrapText(footer || '', BODY_W - 78, 'Helvetica', 8)[0] || '';
    if (label) pdf.text(label, { x: M.left, top: y, size: 8, colour: [0.45, 0.45, 0.45] });
    const page = `Page ${index + 1} of ${count}`;
    pdf.text(page, { x: 612 - M.right - textWidth(page, 'Helvetica', 8), top: y, size: 8, colour: [0.45, 0.45, 0.45] });
  });
}

export function renderDocument({ title, body, signers = [], signatures = {}, company = {}, footer = '', date = '' }) {
  const pdf = createPdf({ title, author: company.name || 'Network Inventory' });
  let top = M.top;

  if (company.name) {
    pdf.text(company.name, { x: M.left, top, font: 'Helvetica-Bold', size: 13 });
    const when = date || longDate();
    const dateW = textWidth(when, 'Helvetica', 9);
    pdf.text(when, { x: 612 - M.right - dateW, top, size: 9, colour: [0.35, 0.35, 0.35] });
    top += 16;
    const contact = [company.address, [company.phone, company.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    if (contact) {
      for (const line of wrapText(contact, BODY_W - 120, 'Helvetica', 9)) {
        if (!line) { top += 4; continue; }
        pdf.text(line, { x: M.left, top, size: 9, colour: [0.35, 0.35, 0.35] });
        top += 12;
      }
    }
    top += 6;
  }

  pdf.text(title, { x: M.left, top, font: 'Helvetica-Bold', size: 16 });
  top += 18;
  pdf.line(M.left, top, 612 - M.right, top, { colour: [0.25, 0.25, 0.25], width: 1 });
  top += 20;

  top = drawMarkedBody(pdf, body, top);
  top += 18;

  for (const signer of signers) {
    const sig = signatures[signer.id] || signatures[signer.role];
    const when = sig ? signingWhen(sig) : '';
    const device = sig ? signingDevice(sig) : '';
    const place = sig ? signingPlace(sig) : '';
    const extra = (when ? 14 : 0) + (device ? 12 : 0) + (place ? 12 : 0);
    const BLOCK = 88 + extra;
    if (top + BLOCK > LIMIT) { pdf.addPage(); top = newPageTop(); }

    pdf.text(`${roleLabel(signer.role)}: ${signer.name}`, { x: M.left, top, font: 'Helvetica-Bold', size: 10 });
    top += 16;

    pdf.rect(M.left, top, 240, 46, { stroke: [0.75, 0.75, 0.75], width: 0.6 });
    if (sig && sig.kind === 'drawn' && sig.strokes && sig.strokes.length) {
      pdf.strokes(sig.strokes, { x: M.left + 6, top: top + 4, width: 228, height: 38 });
    } else if (sig && sig.kind === 'typed' && sig.typed) {
      pdf.text(sig.typed, { x: M.left + 12, top: top + 31, font: 'Times-Italic', size: 20, colour: [0, 0, 0.55] });
    }
    top += 46;
    pdf.line(M.left, top + 2, M.left + 240, top + 2, { colour: [0.4, 0.4, 0.4], width: 0.5 });
    top += 14;

    if (when) {
      for (const line of wrapText(`Signed ${when}`, BODY_W, 'Helvetica', 8)) {
        pdf.text(line, { x: M.left, top, size: 8, colour: [0.3, 0.3, 0.3] });
        top += 11;
      }
      if (device) {
        pdf.text(`Device clock ${device}`, { x: M.left, top, size: 8, colour: [0.3, 0.3, 0.3] });
        top += 11;
      }
      if (sig.kind === 'typed') {
        pdf.text('Typed signature, adopted electronically', { x: M.left, top, size: 8, colour: [0.45, 0.45, 0.45] });
        top += 11;
      }
      if (place) {
        pdf.text(`Location ${place}`, { x: M.left, top, size: 8, colour: [0.3, 0.3, 0.3] });
        top += 12;
      }
    } else {
      pdf.text('Awaiting signature', { x: M.left, top, size: 8.5, colour: [0.55, 0.55, 0.55] });
      top += 14;
    }
    top += 12;
  }

  stampFooter(pdf, footer);
  return pdf;
}

export function roleLabel(role) {
  return { customer: 'Customer', lessor: 'Lessor', witness: 'Witness', countersign: 'Countersigned by', vendor: 'Vendor' }[role] || role;
}

/**
 * The certificate of completion, appended to the signed document.
 *
 * This page is the point of the whole exercise. A signature image proves very little on its own;
 * what carries weight is the record of how it came to be — who was sent what, to which address,
 * when they opened it, what they consented to, from which IP, and the hash of the exact bytes they
 * were shown. A dispute is argued over this page, so it prints the full chain rather than a
 * summary, and it prints the document hash so the file in evidence can be matched against it.
 */
export function renderCertificate({ document, signers, events, chain }) {
  const pdf = createPdf({ title: `Certificate of completion — ${document.title}` });
  drawCertificate(pdf, { document, signers, events, chain });
  return pdf;
}

/**
 * Draw the certificate onto an EXISTING builder, starting on its current page.
 *
 * Split out from renderCertificate so the signed document and its certificate can be one file
 * without merging two PDFs' object trees. Both paths run this same code: a second renderer would
 * eventually disagree with the first, and the disagreement would be between the copy we hand a
 * customer and the copy we keep.
 */
export function drawCertificate(pdf, { document, signers, events, chain }) {
  let top = M.top;

  pdf.text('Certificate of Completion', { x: M.left, top, font: 'Helvetica-Bold', size: 15 });
  top += 20;
  pdf.text('This page records how the attached document was signed. It is generated from an append-only log.',
    { x: M.left, top, size: 9, colour: [0.35, 0.35, 0.35] });
  top += 20;
  pdf.line(M.left, top, 612 - M.right, top, { colour: [0.75, 0.75, 0.75] });
  top += 20;

  const row = (label, value) => {
    pdf.text(label, { x: M.left, top, font: 'Helvetica-Bold', size: 9 });
    for (const line of wrapText(String(value ?? '—'), BODY_W - 130, 'Helvetica', 9)) {
      pdf.text(line, { x: M.left + 130, top, size: 9 });
      top += 12.5;
    }
    top += 3;
  };

  row('Document', document.title);
  row('Reference', `#${document.id}`);
  row('Status', document.status);
  row('Created', document.created_at);
  row('Completed', document.completed_at || '—');
  // The hash is what lets a copy produced years later be proven identical to what was signed.
  row('Document SHA-256', document.content_sha256 || '—');

  top += 8;
  pdf.text('Signers', { x: M.left, top, font: 'Helvetica-Bold', size: 11 });
  top += 16;

  for (const s of signers) {
    if (top > LIMIT - 80) { pdf.addPage(); top = M.top; }
    row(roleLabel(s.role), s.name);
    row('  Sent to', s.email || s.phone || (s.delivery === 'in_person' ? 'in person' : '—'));
    row('  Delivery', s.delivery);
    row('  Consented', s.consent_at || '—');
    row('  Signed', s.signed_at ? signingWhen(s) + (s.signature_kind ? ` (${s.signature_kind})` : '') : (s.declined_at ? `DECLINED ${s.declined_at}` : 'not yet'));
    if (signingDevice(s)) row('  Device clock', signingDevice(s));
    row('  IP address', s.signed_ip || '—');
    row('  Location', signingPlace(s) || (s.signed_at ? 'not recorded' : '—'));
    if (s.declined_reason) row('  Reason', s.declined_reason);
    top += 6;
  }

  if (signers.some(s => s.signed_at)) {
    if (top > LIMIT - 28) { pdf.addPage(); top = M.top; }
    const note = 'Location is the position the signer\'s device reported at the moment of signing. It is not a surveyed address. The server time is the time of record; the device clock is what that phone or computer showed.';
    for (const line of wrapText(note, BODY_W, 'Helvetica', 8)) {
      pdf.text(line, { x: M.left, top, size: 8, colour: [0.4, 0.4, 0.4] });
      top += 11;
    }
    top += 8;
  }

  if (top > LIMIT - 80) { pdf.addPage(); top = M.top; }
  pdf.text('Event log', { x: M.left, top, font: 'Helvetica-Bold', size: 11 });
  top += 6;
  pdf.text(chain && chain.ok
      ? 'Each entry carries the hash of the one before it; the chain below verifies intact.'
      : `WARNING: the chain does not verify — ${chain ? chain.reason : 'unknown'}`,
    { x: M.left, top: top + 10, size: 8.5, colour: chain && chain.ok ? [0.3, 0.45, 0.3] : [0.7, 0.1, 0.1] });
  top += 26;

  for (const e of events) {
    const detail = [e.detail, e.actor ? `by ${e.actor}` : '', e.ip ? `from ${e.ip}` : ''].filter(Boolean).join(' · ');
    const lines = wrapText(detail, BODY_W - 168, 'Helvetica', 8);
    if (top + 12 + lines.length * 11 > LIMIT) { pdf.addPage(); top = M.top; }
    pdf.text(e.at, { x: M.left, top, font: 'Courier', size: 8 });
    pdf.text(e.kind, { x: M.left + 108, top, font: 'Helvetica-Bold', size: 8 });
    for (const line of lines) {
      pdf.text(line, { x: M.left + 168, top, size: 8 });
      top += 11;
    }
    pdf.text(String(e.hash).slice(0, 32) + '...', { x: M.left + 108, top, font: 'Courier', size: 6.5, colour: [0.55, 0.55, 0.55] });
    top += 10;
  }

  return pdf;
}

/**
 * Whether a document is finished, and what should happen next.
 *
 * Signing order matters: a lease countersigned by us before the lessor has signed is not a document
 * anyone wants to explain. Signers share an order_index to sign in parallel; a higher index waits.
 */
export function signingState(signers) {
  const sorted = [...signers].sort((a, b) => a.order_index - b.order_index || a.id - b.id);
  const declined = sorted.filter(s => s.status === 'declined');
  if (declined.length) return { status: 'declined', next: [], declined };

  const pending = sorted.filter(s => s.status !== 'signed');
  if (!pending.length) return { status: 'signed', next: [], declined: [] };

  const turn = pending[0].order_index;
  const next = pending.filter(s => s.order_index === turn);
  const anySigned = sorted.some(s => s.status === 'signed');
  return { status: anySigned ? 'partially_signed' : 'sent', next, declined: [] };
}

/** Is it this signer's turn? A link sent early must not be signable out of order. */
export function canSign(signer, signers) {
  if (!signer || signer.status === 'signed' || signer.status === 'declined') return false;
  return signingState(signers).next.some(s => s.id === signer.id);
}
