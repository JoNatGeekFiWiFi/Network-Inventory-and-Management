// Document signing, end to end and then attacked.
//
// A signed agreement is the only thing this application produces that someone might one day dispute
// in front of a third party. That changes what the tests are for. Elsewhere a bug means a wrong
// number on a screen; here it means either a document that cannot be relied on, or — worse — one
// that binds somebody who never agreed to it.
//
// So this file is in two halves. The first walks the happy path. The second tries to break it:
// signing out of turn, signing with someone else's link, signing without consenting, editing a sent
// document, and forging the audit trail. Those are the tests that matter.
import { readFileSync } from 'node:fs';
import {
  mergeBody, fieldsUsed, unknownFields, makeToken, tokenMatches, hashToken, MERGE_FIELDS,
  eventHash, verifyChain, signingState, canSign, longDate
} from '../lib/docsign.js';

const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
async function call(p, { method = 'GET', body, raw = false } = {}) {
  const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t };
}
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- the pure pieces, which need no server ------------------------------------------------------
{
  // A missing merge value must be VISIBLE. An agreement that reads "a charge of  per month" is one
  // somebody notices; an invisible gap gets signed.
  const t = 'Between {{company.name}} and {{customer.name}} at {{site.address}}.';
  const m = mergeBody(t, { 'company.name': 'GeekiTek', 'customer.name': 'Acme', 'site.address': '' });
  ok(m.missing.includes('site.address'), 'a blank merge value is reported as missing, not silently dropped');
  ok(m.text.includes('[site.address — NOT SET]'), 'and renders as a marker somebody will notice before sending');
  ok(!m.text.includes('{{'), 'no raw placeholder survives into the text');

  ok(unknownFields('{{customer.nmae}} and {{customer.name}}').join() === 'customer.nmae',
    'a misspelled field is identified — this is caught when the template is saved, not after signing');
  ok(fieldsUsed('{{a.b}} {{a.b}} {{c.d}}').length === 2, 'fields are deduplicated');

  // Every offered field must be fillable. signer.name and signer.role were advertised and could
  // never have a value: the body is merged once for a document that has several signers, so they
  // printed "NOT SET" on every document that used them. A field the editor offers and the renderer
  // cannot fill is worse than an absent one — it invites the mistake.
  ok(!('signer.name' in MERGE_FIELDS) && !('signer.role' in MERGE_FIELDS),
    'no per-signer field is offered for the shared body, because there is no single signer to fill it with');
  ok(Object.keys(MERGE_FIELDS).every(k => /^(customer|site|pop|company|document)\./.test(k)),
    'every offered field names a record the merge actually reads');

  const { token, hash } = makeToken();
  ok(token.length >= 40, `a signing token is long (${token.length} chars of base64url)`);
  ok(hash !== token && hash.length === 64, 'and only its SHA-256 is stored');
  ok(tokenMatches(token, hash) && !tokenMatches(token.slice(0, -1) + 'x', hash),
    'the right token verifies and a near-miss does not');
  ok(!tokenMatches('', hash) && !tokenMatches(token, ''), 'empty values never verify');
  ok(makeToken().token !== makeToken().token, 'tokens are not repeated');

  ok(/^\d{1,2} \w+ \d{4}$/.test(longDate(new Date('2026-09-20T00:00:00Z'))),
    'dates are written out in full, so 09/20 is never read as 20 September in the wrong order');
}

// ---- the audit chain, attacked -------------------------------------------------------------------
//
// THE CENTRAL CLAIM of a self-hosted signing system is that its own operator cannot quietly rewrite
// history. These tests are that claim.
{
  const build = () => {
    let prev = ''; const evs = [];
    for (const [i, kind] of ['created', 'sent', 'viewed', 'consented', 'signed'].entries()) {
      const e = { id: i + 1, document_id: 1, signer_id: 1, kind, detail: `${kind} detail`, actor: 'someone', ip: '10.0.0.5', at: `2026-09-20T10:0${i}:00Z` };
      e.prev_hash = prev; e.hash = eventHash(e, prev); prev = e.hash; evs.push(e);
    }
    return evs;
  };

  ok(verifyChain(build()).ok, 'an untouched chain verifies');

  const edited = build(); edited[2].detail = 'viewed from a different address';
  const r1 = verifyChain(edited);
  ok(!r1.ok && r1.index === 2, `editing event 3 is detected, and pinpointed (index ${r1.index})`);

  const removed = build().filter((_, i) => i !== 2);
  ok(!verifyChain(removed).ok, 'DELETING an event breaks the chain — the usual way a log is doctored');

  const reordered = build(); [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  ok(!verifyChain(reordered).ok, 'and so does reordering two events');

  // The interesting attack: re-hash the edited event so it is internally consistent. Every
  // subsequent hash must then fail, because each covers the one before.
  const relinked = build();
  relinked[1].detail = 'sent somewhere else';
  relinked[1].hash = eventHash(relinked[1], relinked[1].prev_hash);
  const r2 = verifyChain(relinked);
  ok(!r2.ok && r2.index === 2,
    'recomputing the altered event\'s own hash does not help — the NEXT event still points at the old one');

  // Rebuilding the whole chain is the one attack a hash chain alone cannot stop. Worth stating
  // plainly rather than pretending otherwise: the defence there is the append-only log being
  // backed up off-box, not the hash.
  const rebuilt = build(); rebuilt[1].detail = 'sent somewhere else';
  let prev = '';
  for (const e of rebuilt) { e.prev_hash = prev; e.hash = eventHash(e, prev); prev = e.hash; }
  ok(verifyChain(rebuilt).ok,
    'a fully rebuilt chain does verify — the hash proves internal consistency, so off-box backups are what catch this');

  // A chain must not be forgeable by swapping field boundaries: ("ab","c") and ("a","bc").
  const a = eventHash({ document_id: 1, signer_id: 1, kind: 'ab', detail: 'c', at: 't' }, '');
  const b = eventHash({ document_id: 1, signer_id: 1, kind: 'a', detail: 'bc', at: 't' }, '');
  ok(a !== b, 'field boundaries are part of the hash, so contents cannot be shuffled between columns');
}

// ---- signing order --------------------------------------------------------------------------------
{
  const s = [
    { id: 1, role: 'lessor', order_index: 0, status: 'pending' },
    { id: 2, role: 'countersign', order_index: 1, status: 'pending' }
  ];
  ok(signingState(s).next.map(x => x.role).join() === 'lessor', 'the first signer is up first');
  ok(!canSign(s[1], s), 'and the countersigner CANNOT sign first — a lease we signed before the lessor did is indefensible');
  s[0].status = 'signed';
  ok(canSign(s[1], s) && signingState(s).status === 'partially_signed', 'once the lessor signs, the countersigner may');
  s[1].status = 'signed';
  ok(signingState(s).status === 'signed', 'and then it is complete');

  const parallel = [
    { id: 1, role: 'customer', order_index: 0, status: 'pending' },
    { id: 2, role: 'witness', order_index: 0, status: 'pending' }
  ];
  ok(signingState(parallel).next.length === 2, 'signers sharing an order may sign in either order');

  const declined = [{ id: 1, role: 'customer', order_index: 0, status: 'declined' }, { id: 2, role: 'countersign', order_index: 1, status: 'pending' }];
  ok(signingState(declined).status === 'declined', 'one decline stops the document');
  ok(!canSign(declined[1], declined), 'and nobody else is asked to sign it');
}

// ---- end to end against the server ----------------------------------------------------------------
await login('admin@geekitek.test', 'admin123');

let docId = null, custId = null;
{
  const customers = (await call('/api/customers')).json;
  custId = customers && customers.length ? customers[0].id : null;
  if (!custId) {
    const made = await call('/api/customers', { body: { name: 'DOCTEST Customer', email: 'doctest@example.com' } });
    custId = made.json && made.json.id;
  }
  ok(!!custId, 'a customer exists to attach a document to');

  // A template with a bad field must be refused at save time.
  const bad = await call('/api/doc-templates', { body: { name: 'DOCTEST bad', body: 'Hello {{customer.nmae}}' } });
  ok(bad.status === 400 && /nmae/.test(bad.json.error || ''),
    'a template with a misspelled merge field is refused when saved, naming the field');

  const tpl = await call('/api/doc-templates', {
    body: {
      name: 'DOCTEST Service Agreement', kind: 'agreement',
      body: 'This agreement is made on {{document.date}} between {{company.name}} and {{customer.name}}.\n\nService is provided at {{site.address}}.\n\nSigned below.',
      signer_roles: ['customer']
    }
  });
  ok(tpl.status === 200 && tpl.json.id, 'a valid template saves');
  const tplId = tpl.json.id;

  const prev = await call(`/api/doc-templates/${tplId}/preview`, { body: { parent_type: 'customer', parent_id: custId } });
  ok(prev.status === 200 && !prev.json.text.includes('{{'), 'previewing merges it against a real customer');

  const made = await call('/api/documents', {
    body: {
      template_id: tplId, parent_type: 'customer', parent_id: custId,
      signers: [{ role: 'customer', name: 'Dana Okafor', email: 'dana@example.com', delivery: 'email' }]
    }
  });
  ok(made.status === 200 && made.json.id, 'a document is created from the template');
  docId = made.json.id;

  const noSigner = await call('/api/documents', { body: { template_id: tplId, parent_type: 'customer', parent_id: custId, signers: [] } });
  ok(noSigner.status === 400, 'a document with no signers is refused');

  const badEmail = await call('/api/documents', {
    body: { template_id: tplId, parent_type: 'customer', parent_id: custId, signers: [{ name: 'No Address', delivery: 'email' }] }
  });
  ok(badEmail.status === 400 && /email/i.test(badEmail.json.error || ''),
    'a signer set to receive by email with no email address is refused, rather than failing silently at send');
}

let token = null;
{
  const before = (await call(`/api/documents/${docId}`)).json;
  ok(before.status === 'draft', 'it starts as a draft');
  ok(!before.content_sha256, 'with no hash yet — nothing has been frozen');

  const edit = await call(`/api/documents/${docId}`, { method: 'PUT', body: { title: 'DOCTEST Renamed' } });
  ok(edit.status === 200, 'a draft can be edited');

  const sent = await call(`/api/documents/${docId}/send`, { body: {} });
  ok(sent.status === 200 && sent.json.sha256, 'sending freezes and hashes the document');
  ok(sent.json.deliveries && sent.json.deliveries.length === 1, 'and reports what happened for each signer');
  const url = sent.json.deliveries[0].url;
  token = url.split('#')[1];
  ok(!!token && token.length > 30, 'a signing link carries a long token in the URL fragment');

  // The token must be in the FRAGMENT, not the path or query. Browsers do not transmit a fragment,
  // so it stays out of the server's own access log, out of Referer headers, and out of any proxy in
  // between. A bearer credential in a path is a bearer credential in every log it passes through.
  ok(!url.split('#')[0].includes(token), 'and the token appears nowhere in the path or query');
  ok(url.split('#')[0].endsWith('/sign'), `the signing page is at a clean /sign path (${url.split('#')[0]})`);

  // The public URL is derived from the request when it is not configured. Requiring a setting for
  // this produced links like "/sign#token" — dead in an email — because nobody had filled in a
  // field buried on the Settings page.
  ok(/^https?:\/\//.test(url),
    `the link is absolute even with no public URL configured, derived from the request (${url.split('#')[0]})`);

  const afterSend = (await call(`/api/documents/${docId}`)).json;
  ok(afterSend.status === 'sent' && afterSend.content_sha256, 'the document records the hash of what was sent');

  // THE RULE THAT PROTECTS THE SIGNATURE. Editing after sending would let the text change under
  // somebody who already reviewed it.
  const lateEdit = await call(`/api/documents/${docId}`, { method: 'PUT', body: { body: 'Completely different terms.' } });
  ok(lateEdit.status === 409 && /void/i.test(lateEdit.json.error || ''),
    'a SENT document cannot be edited, and the error explains to void and reissue instead');

  const pdf = await call(`/api/documents/${docId}/pdf`, { raw: true });
  ok(pdf.status === 200 && pdf.type.includes('pdf') && pdf.buf.slice(0, 5).toString() === '%PDF-',
    `the as-sent PDF is retrievable and is a real PDF (${pdf.buf.length} bytes)`);

  const verify = (await call(`/api/documents/${docId}/verify`)).json;
  ok(verify.chain.ok, 'the audit chain verifies');
  ok(verify.files.sent && verify.files.sent.matches,
    'and the PDF on disk still hashes to what was recorded — the file has not been swapped');
}

// ---- the signer's side, including the ways in ------------------------------------------------------
{
  // Signing endpoints take no session. That is the point, and also the risk.
  cookie = '';

  const nonsense = await call('/api/sign/open', { body: { token: 'x'.repeat(64) } });
  ok(nonsense.status === 404, 'an invented token is rejected');
  ok(!/expired|exists/i.test(nonsense.json.error || '') || /may have/i.test(nonsense.json.error),
    'and the message does not reveal whether it was wrong, expired or already used');
  ok((await call('/api/sign/open', { body: { token: '' } })).status === 404, 'an empty token is rejected');
  ok((await call('/api/sign/open', { body: {} })).status === 404, 'a missing token is rejected');

  const open = await call('/api/sign/open', { body: { token } });
  ok(open.status === 200 && open.json.title, 'the real token opens the document');
  ok(open.json.can_sign === true, 'and this signer may sign');
  ok(open.json.sha256, 'the signer is shown the fingerprint of what they are signing');

  // Scope: holding a signing link must not turn into a view of the business.
  const j = JSON.stringify(open.json);
  ok(!/token_hash|private_key|portal_password|"email":/.test(j),
    'the signing payload leaks no credentials and no other party\'s contact details');

  // Consent is a separate act, and signing without it is refused.
  const early = await call('/api/sign/submit', { body: { token, kind: 'typed', typed: 'Dana Okafor' } });
  ok(early.status === 400 && /consent/i.test(early.json.error || ''),
    'signing before consenting is refused — consent is recorded as its own act, which is what ESIGN asks for');

  ok((await call('/api/sign/consent', { body: { token } })).status === 200, 'consent is recorded');

  ok((await call('/api/sign/submit', { body: { token, kind: 'typed', typed: 'D' } })).status === 400,
    'a one-character name is not a signature');
  ok((await call('/api/sign/submit', { body: { token, kind: 'drawn', strokes: [] } })).status === 400,
    'nor is an empty signature pad');

  // Attacker-controlled geometry goes into the database and then into a PDF.
  const huge = [Array.from({ length: 25000 }, (_, i) => ({ x: i, y: i }))];
  ok((await call('/api/sign/submit', { body: { token, kind: 'drawn', strokes: huge } })).status === 400,
    'an absurdly large signature is rejected rather than stored and rendered');

  const signed = await call('/api/sign/submit', {
    body: { token, kind: 'drawn', strokes: [[{ x: 0, y: 20 }, { x: 25, y: 2 }, { x: 50, y: 22 }], [{ x: 60, y: 11 }]] }
  });
  ok(signed.status === 200 && signed.json.complete === true, 'a real signature completes the document');

  // The token is spent. A forwarded email must not let someone sign twice.
  const reuse = await call('/api/sign/open', { body: { token } });
  ok(reuse.status === 404, 'the link stops working once used — a forwarded email cannot sign again');
}

// ---- what is left behind -----------------------------------------------------------------------------
{
  await login('admin@geekitek.test', 'admin123');
  const d = (await call(`/api/documents/${docId}`)).json;
  ok(d.status === 'signed' && d.completed_at, 'the document is complete');
  ok(d.signed_sha256 && d.signed_stored_name, 'a signed copy was produced and hashed');
  ok(d.content_sha256 !== d.signed_sha256, 'and it is a NEW file — the as-sent original is preserved, not overwritten');

  const kinds = d.events.map(e => e.kind);
  for (const k of ['created', 'sent', 'viewed', 'consented', 'signed', 'completed']) {
    ok(kinds.includes(k), `the trail records "${k}"`);
  }

  // Delivery is recorded whether or not it worked, and a failure says why.
  //
  // The test environment has no SMTP, so this lands on delivery_failed — which is the interesting
  // case to pin down. A send that quietly does nothing leaves a document nobody can sign and no way
  // to find out why, and that is precisely what an unrecorded failure would produce.
  const delivery = d.events.find(e => e.kind === 'delivered' || e.kind === 'delivery_failed');
  ok(!!delivery, 'the trail records the delivery attempt, successful or not');
  if (delivery && delivery.kind === 'delivery_failed') {
    ok(/smtp|not configured|no address/i.test(delivery.detail || ''),
      `and when delivery fails it records the reason ("${(delivery.detail || '').slice(0, 60)}")`);
  } else {
    ok(true, 'and delivery succeeded, so SMTP is configured in this environment');
  }
  ok(d.chain.ok, 'and the whole chain still verifies');

  const signer = d.signers[0];
  ok(signer.signed_ip && signer.signed_at && signer.consent_at, 'attribution evidence is stored: IP, signing time, consent time');
  ok(signer.signature_strokes && JSON.parse(signer.signature_strokes).length === 2,
    'the pen strokes are kept — better evidence of a human signing than a flat image');
  ok(!('token_hash' in signer), 'and the token hash never leaves the server');

  const pdf = await call(`/api/documents/${docId}/pdf?signed=1`, { raw: true });
  ok(pdf.status === 200 && pdf.buf.slice(0, 5).toString() === '%PDF-', `the signed PDF downloads (${pdf.buf.length} bytes)`);
  // The certificate is part of the same file, so a copy cannot be circulated without its provenance.
  const body = pdf.buf.toString('latin1');
  ok(body.includes('/Count 2') || /\/Count [2-9]/.test(body), 'and carries the certificate as extra pages, in the one file');
  ok(pdf.buf.length > (await call(`/api/documents/${docId}/pdf`, { raw: true })).buf.length,
    'the signed copy is larger than the unsigned one, as it holds the signature and certificate');

  const v = (await call(`/api/documents/${docId}/verify`)).json;
  ok(v.files.signed && v.files.signed.matches, 'the signed file on disk matches its recorded hash');

  // It is filed where it belongs, which is the whole request.
  const onCustomer = (await call(`/api/documents?parent_type=customer&parent_id=${custId}`)).json;
  ok(Array.isArray(onCustomer) && onCustomer.some(x => x.id === docId),
    'and it is listed against the customer it belongs to');
}

// ---- who may see any of this ---------------------------------------------------------------------------
{
  await login('support@geekitek.test', 'support123');
  ok((await call('/api/documents')).status === 403, 'documents are NOC-only to list');
  ok((await call(`/api/documents/${docId}`)).status === 403, 'and to read');
  ok((await call(`/api/documents/${docId}/pdf`)).status === 403, 'a signed agreement is not readable by support');
  ok((await call('/api/doc-templates')).status === 403, 'nor are the templates');
  ok((await call(`/api/documents/${docId}/void`, { body: { reason: 'x' } })).status === 403, 'and it cannot be voided');

  cookie = '';
  ok((await call('/api/documents')).status === 401 || (await call('/api/documents')).status === 403,
    'and signed out, nothing is readable at all');
  await login('admin@geekitek.test', 'admin123');
}

// ---- a completed document is permanent -------------------------------------------------------------------
{
  const v = await call(`/api/documents/${docId}/void`, { body: { reason: 'changed my mind' } });
  ok(v.status === 409, 'a COMPLETED document cannot be voided — it is superseded, never erased');

  // Clean up the draft-side fixtures, but leave the signed document: deleting evidence in a test is
  // a habit worth not forming. It is named DOCTEST and is harmless.
  const tpls = (await call('/api/doc-templates')).json.filter(t => t.name.startsWith('DOCTEST'));
  for (const t of tpls) await call('/api/doc-templates/' + t.id, { method: 'DELETE' });
  const still = (await call(`/api/documents/${docId}`)).json;
  ok(still.status === 'signed' && still.body,
    'deleting the template leaves the signed document intact and readable — what was signed stays signed');
}

// ---- the interface actually reaches all of it ----------------------------------------------------
//
// An API nobody can get to is not a feature. Everything above passed for a whole session while there
// was no way to create a document from inside the application — which is worth catching with a
// check rather than by someone asking "where is it?".
{
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  ok(/data-nav="documents"/.test(html), 'there is a Documents entry in the navigation');
  ok(/p\[0\] === 'documents'/.test(app), 'and a route for it');
  ok(/p\[0\] === 'documents' && p\[1\] === 'templates'/.test(app), 'plus one for templates');

  for (const fn of ['renderDocuments', 'renderDocument', 'renderDocTemplates', 'newDocument',
                    'createDocument', 'sendDocument', 'voidDocument', 'verifyDocument',
                    'resendSigner', 'saveTemplate', 'loadDocumentsFor']) {
    ok(new RegExp(`function ${fn}\\b`).test(app), `${fn}() exists`);
  }

  // Every endpoint the domain exposes should be reachable from the UI, or it is dead code.
  for (const [path, why] of [
    ['/documents', 'listing and creating'],
    ['/doc-templates', 'templates'],
    ['/preview', 'previewing a template against a real record before sending'],
    ['/send', 'sending for signature'],
    ['/void', 'voiding'],
    ['/verify', 'verifying the audit chain'],
    ['/resend', 'resending a signing link'],
    ['/pdf?signed=1', 'downloading the signed copy']
  ]) {
    ok(app.includes(path), `the UI calls ${path} — ${why}`);
  }

  // Documents have to appear on the record they belong to, which is where someone looks when a
  // customer disputes a term.
  ok(/docsFor-customer-/.test(app) && /docsFor-site-/.test(app),
    'signed documents surface on the customer AND the site — a rooftop lease belongs to the structure, not the subscriber');

  // The freeze-on-send rule has to be visible before it bites, not discovered afterwards.
  ok(/frozen and hashed/i.test(app), 'the interface warns that sending freezes the wording before you press it');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
