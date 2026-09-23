// A W-9, end to end: requested from a vendor page, filled and signed on /sign, filed on the vendor.
//
// The assertion that matters most is near the end: the database FILE is read from disk and searched
// for the taxpayer ID. Checking API responses would only prove we do not return it; the question is
// whether it was ever written, and only the bytes on disk can answer that.
import { readFileSync, existsSync } from 'node:fs';
import { PdfDocument, formFields } from '../lib/pdfread.js';
import { W9_FIELDS } from '../lib/w9.js';

const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
async function call(p, { method = 'GET', body, keepCookie = true } = {}) {
  const h = {};
  if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie && keepCookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && keepCookie) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: r.status, json: j, buf, headers: r.headers };
}
// The signing surface is public: no staff cookie is sent, exactly as a vendor would reach it.
const pub = (p, body) => call(p, { body, keepCookie: false });
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const TIN = '876543219';                // what the vendor types, as 87-6543219
const stamp = Date.now();
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

const ven = (await call('/api/vendors', { body: { name: 'W9-TEST Splicer ' + stamp, vendor_kind: 'contractor', email: `ap${stamp}@splicer.example`, is_1099: true } })).json;

// ---- requesting it ----
let docId, token;
{
  ok((await call('/api/vendors/' + ven.id + '/w9-request', { body: { email: 'not-an-email', mode: 'blank' } })).status === 400, 'a bad address is refused');
  const r = await call('/api/vendors/' + ven.id + '/w9-request', { body: {
    email: `ap${stamp}@splicer.example`, name: 'Ada Splicer', mode: 'prefill',
    // Staff try to pre-fill a TIN. It must be thrown away, not stored.
    prefill: { name: 'Ada Splicer', classification: 'llc', llc_class: 'P', address: '12 Splice Rd', city_state_zip: 'Mesa, AZ 85201', tin_type: 'ein', tin: '11-2233445' }
  } });
  ok(r.status === 200 && r.json.id, 'a pre-filled W-9 request is created');
  docId = r.json.id;
  ok(r.json.delivery && /\/sign#/.test(r.json.delivery.url || ''), 'and a personal signing link is issued (returned to staff in case email is not set up)');
  token = String(r.json.delivery.url).split('#')[1];

  const d = (await call('/api/documents/' + docId)).json;
  ok(d.status === 'sent' && d.content_sha256 && d.form_kind === 'w9', 'the form is frozen and hashed at send, like any document');
  ok(d.parent_type === 'vendor' && d.parent_id === ven.id, 'it belongs to the vendor');
  ok(!JSON.stringify(d).includes('2233445'), 'the TIN staff tried to pre-fill appears nowhere in the document record');
  const sent = await call('/api/documents/' + docId + '/pdf');
  const f = formFields(PdfDocument.open(sent.buf)).fields;
  ok((f.find(x => x.name === W9_FIELDS.ein2) || {}).value == null || (f.find(x => x.name === W9_FIELDS.ein2) || {}).value === '', 'nor on the PDF that was sent');
  ok((f.find(x => x.name === W9_FIELDS.name) || {}).value === 'Ada Splicer', 'but the pre-filled name is');
}

// ---- the vendor opens it ----
{
  const o = await pub('/api/sign/open', { token });
  ok(o.status === 200 && o.json.form && o.json.form.kind === 'w9', 'the signing page is told this is a W-9');
  ok(o.json.form.prefill.name === 'Ada Splicer' && o.json.form.prefill.classification === 'llc', 'with what was pre-filled');
  ok(o.json.form.certification.length === 5 && /penalties of perjury/.test(o.json.form.certification[0]), 'and the certification, to be shown in full');
  ok(!('tin' in o.json.form.prefill), 'no TIN field in the pre-fill at all');
}

// ---- preview ----
{
  const p = await pub('/api/sign/form-preview', { token, form: { name: 'Ada Splicer', classification: 'llc', llc_class: 'P', tin_type: 'ein', tin: '87-6543219' } });
  ok(p.status === 200 && p.headers.get('content-type') === 'application/pdf', 'the preview is a PDF');
  ok(p.headers.get('cache-control') === 'no-store', 'which the browser is told not to cache — it has a TIN on it');
  const f = formFields(PdfDocument.open(p.buf)).fields;
  ok((f.find(x => x.name === W9_FIELDS.ein2) || {}).value === '6543219', 'showing the number in the right boxes, so they can check it');
  ok((await pub('/api/sign/form-preview', { token: 'x'.repeat(40), form: {} })).status === 404, 'a bad token gets no preview');
}

// ---- signing ----
const form = { name: 'Ada Splicer', business_name: 'Ada Fiber', classification: 'llc', llc_class: 'P', address: '12 Splice Rd', city_state_zip: 'Mesa, AZ 85201', tin_type: 'ein', tin: '87-6543219', backup_withholding: false };
const strokes = [[{ x: 0, y: 30 }, { x: 40, y: 0 }, { x: 80, y: 28 }]];
{
  ok((await pub('/api/sign/submit', { token, kind: 'drawn', strokes, form })).status === 400, 'signing before consenting to sign electronically is refused');
  await pub('/api/sign/consent', { token });
  const bad = await pub('/api/sign/submit', { token, kind: 'drawn', strokes, form: { ...form, tin: '87-654' } });
  ok(bad.status === 400 && bad.json.fields && bad.json.fields.tin, 'a short TIN is refused, with the field named so the page can highlight it');
  const d = (await call('/api/documents/' + docId)).json;
  ok(d.signers[0].status !== 'signed', 'and nothing was marked signed by the failed attempt');

  const r = await pub('/api/sign/submit', { token, kind: 'drawn', strokes, form, geo_status: 'denied', tz: '-07:00', client_at: new Date().toISOString() });
  ok(r.status === 200 && r.json.complete === true, 'a complete, valid W-9 is signed' + (r.status === 200 ? '' : ' — ' + r.status + ' ' + JSON.stringify(r.json)));
  ok((await pub('/api/sign/submit', { token, kind: 'drawn', strokes, form })).status === 409, 'and cannot be signed twice');
}

// ---- what was filed ----
{
  const d = (await call('/api/documents/' + docId)).json;
  ok(d.status === 'signed' && d.signed_stored_name && d.certificate_stored_name, 'the signed W-9 and its certificate are both filed');
  ok(/^vendor\//.test(d.signed_stored_name) && /\/documents\//.test(d.signed_stored_name), `in the vendor's own documents folder (${d.signed_stored_name.split('/').slice(0, 3).join('/')}/…)`);
  const ev = d.events.map(e => e.kind);
  ok(ev.includes('form_completed') && ev.includes('signed') && ev.includes('completed'), 'the event chain records the form, the signature and completion');
  ok(d.chain && d.chain.ok, 'and the chain verifies');
  ok(!JSON.stringify(d).includes(TIN) && !JSON.stringify(d).includes('87-6543219'), 'no event, signer row or document field contains the TIN');
  ok(JSON.stringify(d.events).includes('EIN ending 3219'), 'the events show the last four only');

  const verify = (await call('/api/documents/' + docId + '/verify')).json;
  ok(verify.files.signed.matches && verify.files.certificate.matches, 'both files match their recorded hashes');
  ok(verify.files.signed.extends_sent === true, 'and the signed W-9 begins with the exact bytes that were sent');

  const signed = await call('/api/documents/' + docId + '/pdf?signed=1');
  const f = formFields(PdfDocument.open(signed.buf)).fields;
  const val = (n) => (f.find(x => x.name === n) || {}).value;
  ok(val(W9_FIELDS.name) === 'Ada Splicer' && val(W9_FIELDS.ein1) === '87' && val(W9_FIELDS.ein2) === '6543219', 'the signed PDF carries their name and EIN in the right boxes');
  const cert = await call('/api/documents/' + docId + '/pdf?certificate=1');
  ok(cert.status === 200 && cert.buf.slice(0, 5).toString() === '%PDF-', 'the certificate of completion downloads');

  const mine = await fetch(B + '/api/sign/pdf?token=' + encodeURIComponent(token));
  ok(mine.status === 200, 'the vendor can download their own signed copy with their link');
}

// ---- the vendor record ----
{
  const v = (await call('/api/vendors/' + ven.id)).json;
  ok(v.tin_last4 === '3219' && v.tin_type === 'ein', 'the vendor record gets the TIN type and last four');
  ok(v.legal_name === 'Ada Splicer' && v.tax_classification === 'llc', 'and the legal name and classification from the form');
  ok(v.w9_received_at && v.w9_document_id === docId, 'and is marked W-9 received, linked to the signed form');
  const listed = (await call('/api/vendors')).json.find(x => x.id === ven.id);
  ok(listed.w9_received_at, 'so the vendor list stops flagging it as "no W-9"');
}

// ---- THE DATABASE FILE ----
{
  const path = process.env.TEST_DB_PATH;
  if (path && existsSync(path)) {
    const bytes = Buffer.concat([readFileSync(path), existsSync(path + '-wal') ? readFileSync(path + '-wal') : Buffer.alloc(0)]);
    const hay = bytes.toString('latin1');
    ok(!hay.includes(TIN) && !hay.includes('87-6543219') && !hay.includes('876543219'.split('').join(' ')),
      'the full TIN does not appear anywhere in the database file or its write-ahead log');
    ok(!hay.includes('112233445') && !hay.includes('11-2233445'), 'nor does the TIN staff tried to pre-fill');
  } else ok(true, 'skipped: database path not provided (run through test/run.mjs)');
}

// ---- access ----
{
  cookie = '';
  await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await call('/api/vendors/' + ven.id + '/w9-request', { body: { email: 'x@y.example', mode: 'blank' } })).status === 403, 'support staff cannot request a W-9');
  ok((await call('/api/documents/' + docId + '/pdf?signed=1')).status === 403, 'or open a signed one');

  cookie = '';
  await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  await call('/api/vendors/' + ven.id, { method: 'DELETE', body: {} });
  ok((await call('/api/vendors/' + ven.id + '/w9-request', { body: { email: 'x@y.example', mode: 'blank' } })).status === 409, 'a deactivated vendor cannot be sent a W-9');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
