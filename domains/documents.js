// Documents and electronic signatures.
//
// The flow: write a template once → produce a document against a customer, site or POP → send each
// signer a link → they consent, review and sign → the completed PDF plus a certificate of
// completion is filed against that customer or site permanently.
//
// THE PART THAT IS NOT LIKE THE REST OF THIS APPLICATION. Everywhere else, a record is a statement
// about the present that gets corrected when it is wrong. A signed document is a statement about
// the past that must NOT change, and whose integrity may have to be defended to someone who would
// rather it were not true. Three rules follow, and they are enforced here rather than left to
// callers:
//
//   1. Once sent, the document bytes are frozen and hashed. Editing a sent document is refused —
//      you void it and issue a new one.
//   2. A signing link is a bearer credential. Only its hash is stored, it expires, it is bound to
//      one signer, and it is scoped so tightly that holding it reveals nothing but that document.
//   3. Every state change is appended to a hash-chained log before the state change is reported as
//      done, so the log cannot be missing an event that happened.
//
// Legal note, recorded because it shapes the code rather than as a disclaimer: ESIGN and UETA ask
// for intent to sign, consent to transact electronically, attribution to a person, association of
// the signature with the record, and a retained reproducible copy. Consent is captured separately
// from the signature itself for that reason, and the certificate prints the attribution evidence.
// None of this is legal advice and a lawyer should review the finished flow.
// No unlink here on purpose: a document's PDF is evidence and is never deleted by this module, not
// even when the document is voided. Voiding records that it was voided; it does not erase what was
// sent.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MERGE_FIELDS, fieldsUsed, unknownFields, mergeBody, makeToken, hashToken,
  eventHash, verifyChain, sha256, renderDocument, drawCertificate,
  signingState, canSign, roleLabel, longDate
} from '../lib/docsign.js';

const SIGNER_ROLES = ['customer', 'lessor', 'witness', 'countersign'];
const DELIVERY = ['email', 'sms', 'whatsapp', 'portal', 'in_person'];
const PARENTS = ['customer', 'site', 'pop'];
const TEMPLATE_KINDS = ['agreement', 'lease', 'consent', 'work_order', 'other'];

export default function registerDocuments(app, ctx) {
  const { db, audit, requireNoc, getSetting, UPLOADS_DIR, clientIp, sendMail } = ctx;

  const now = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

  // ---- the audit chain ---------------------------------------------------------------------------
  //
  // Appending reads the current head inside the same statement sequence that writes the new row.
  // Two events landing at once with the same prev_hash would fork the chain and make it unverifiable
  // for reasons that have nothing to do with tampering, which is worse than useless — it is a false
  // accusation. node:sqlite is synchronous and this process is single-threaded, so read-then-write
  // cannot interleave; the transaction is here to keep that true if either changes.
  function appendEvent({ document_id, signer_id = null, kind, detail = '', actor = null, req = null }) {
    const head = db.prepare('SELECT hash FROM doc_events WHERE document_id=? ORDER BY id DESC LIMIT 1').get(document_id);
    const ev = {
      document_id, signer_id, kind, detail, actor,
      ip: req ? clientIp(req) : null,
      user_agent: req ? String(req.headers['user-agent'] || '').slice(0, 300) : null,
      at: now()
    };
    ev.prev_hash = head ? head.hash : '';
    ev.hash = eventHash(ev, ev.prev_hash);
    db.prepare(`INSERT INTO doc_events (document_id,signer_id,kind,detail,actor,ip,user_agent,at,prev_hash,hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ev.document_id, ev.signer_id, ev.kind, ev.detail, ev.actor,
      ev.ip, ev.user_agent, ev.at, ev.prev_hash, ev.hash);
    return ev;
  }

  function sqlDate(s) {
    if (!s) return new Date();
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  function cleanClientAt(v) {
    const s = String(v || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : s.slice(0, 32);
  }
  function cleanTz(v) {
    const s = String(v || '').trim();
    return /^[+-]\d{2}:\d{2}$/.test(s) ? s : null;
  }
  // A signature is valid without a location. The certificate records why it is missing.
  function readGeo(b) {
    const allowed = ['captured', 'denied', 'unavailable', 'timeout', 'unsupported'];
    const status = allowed.includes(b.geo_status) ? b.geo_status : 'unavailable';
    if (status !== 'captured') return { status, lat: null, lng: null, accuracy: null };
    const lat = Number(b.lat), lng = Number(b.lng), accuracy = Number(b.accuracy);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return { status: 'unavailable', lat: null, lng: null, accuracy: null };
    }
    const acc = Number.isFinite(accuracy) && accuracy >= 0 && accuracy < 1e7 ? Math.round(accuracy) : null;
    return {
      status: 'captured',
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      accuracy: acc
    };
  }
  function companyProfile() {
    return {
      name: getSetting('company_name') || getSetting('bill_company') || 'GeekiTek',
      address: getSetting('company_address') || '',
      email: getSetting('mail_from') || '',
      phone: getSetting('company_phone') || ''
    };
  }
  const eventsFor = (id) => db.prepare('SELECT * FROM doc_events WHERE document_id=? ORDER BY id').all(id);
  const signersFor = (id) => db.prepare('SELECT * FROM doc_signers WHERE document_id=? ORDER BY order_index, id').all(id);

  // ---- merge values ------------------------------------------------------------------------------

  /** Gather everything a template might reference for this parent. */
  function mergeValues(parentType, parentId, extra = {}) {
    const v = {
      'company.name': getSetting('company_name') || 'GeekiTek',
      'company.address': getSetting('company_address') || '',
      'company.email': getSetting('mail_from') || '',
      'company.phone': getSetting('company_phone') || '',
      'document.date': longDate(new Date())
    };
    // The customers table has no `email` or `phone` column — contact details live in
    // billing_email / sms_number, and the richer ones on account_contacts. Reading c.email
    // returned undefined for every customer, so {{customer.email}} printed "NOT SET" on documents
    // where the address was right there in the record.
    const contactFor = (c) => {
      if (!c) return;
      v['customer.name'] = c.name;
      v['customer.email'] = c.billing_email || '';
      v['customer.phone'] = c.sms_number || c.whatsapp_number || '';
      // Fall back to the primary contact on the account, which is where a named person and a
      // direct line usually are.
      const contact = db.prepare(`SELECT ct.* FROM account_contacts ct
        JOIN account_customers ac ON ac.account_id = ct.account_id
        WHERE ac.customer_id = ? ORDER BY ct.is_primary DESC, ct.id LIMIT 1`).get(c.id);
      if (contact) {
        if (!v['customer.email']) v['customer.email'] = contact.email || '';
        if (!v['customer.phone']) v['customer.phone'] = contact.phone || '';
      }
    };

    if (parentType === 'customer') {
      const c = db.prepare('SELECT * FROM customers WHERE id=?').get(parentId);
      contactFor(c);
      const site = db.prepare('SELECT * FROM sites WHERE customer_id=? ORDER BY id LIMIT 1').get(parentId);
      if (site) {
        v['site.name'] = site.name; v['site.address'] = site.service_address || '';
        v['customer.address'] = site.service_address || '';
      }
    } else if (parentType === 'site') {
      const s = db.prepare('SELECT * FROM sites WHERE id=?').get(parentId);
      if (s) {
        v['site.name'] = s.name; v['site.address'] = s.service_address || '';
        if (s.customer_id) contactFor(db.prepare('SELECT * FROM customers WHERE id=?').get(s.customer_id));
      }
    } else if (parentType === 'pop') {
      const p = db.prepare('SELECT * FROM pops WHERE id=?').get(parentId);
      if (p) { v['pop.name'] = p.name; v['pop.address'] = p.address || ''; }
    }
    return { ...v, ...extra };
  }

  function parentLabel(type, id) {
    const table = { customer: 'customers', site: 'sites', pop: 'pops' }[type];
    if (!table) return `${type}#${id}`;
    const row = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(id);
    return row ? row.name : `${type}#${id}`;
  }

  // ---- templates ---------------------------------------------------------------------------------

  app.get('/api/doc-templates', requireNoc, (req, res) => {
    res.json(db.prepare('SELECT * FROM doc_templates ORDER BY active DESC, name').all());
  });

  /** The field list, so the editor can offer them rather than have people guess at names. */
  app.get('/api/doc-templates/fields', requireNoc, (req, res) => {
    res.json(Object.entries(MERGE_FIELDS).map(([key, label]) => ({ key, label })));
  });

  app.post('/api/doc-templates', requireNoc, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A template needs a name' });

    // Refuse unknown merge fields at SAVE time. Caught later, the symptom is a signed agreement with
    // "[customer.nmae — NOT SET]" printed in it, which is a document you cannot rely on.
    const bad = unknownFields(b.body || '');
    if (bad.length) return res.status(400).json({ error: `Unknown merge field(s): ${bad.join(', ')}. Use the field list.` });

    const roles = Array.isArray(b.signer_roles) && b.signer_roles.length
      ? b.signer_roles.filter(r => SIGNER_ROLES.includes(r)) : ['customer'];
    const info = db.prepare(`INSERT INTO doc_templates (name,kind,body,signer_roles_json,created_by)
      VALUES (?,?,?,?,?)`).run(name, TEMPLATE_KINDS.includes(b.kind) ? b.kind : 'agreement',
      String(b.body || ''), JSON.stringify(roles), (req.user && req.user.email) || null);
    audit(req, 'create', 'doc-template#' + info.lastInsertRowid, name);
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/doc-templates/:id', requireNoc, (req, res) => {
    const t = db.prepare('SELECT * FROM doc_templates WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const body = b.body === undefined ? t.body : String(b.body);
    const bad = unknownFields(body);
    if (bad.length) return res.status(400).json({ error: `Unknown merge field(s): ${bad.join(', ')}` });
    const roles = Array.isArray(b.signer_roles) && b.signer_roles.length
      ? b.signer_roles.filter(r => SIGNER_ROLES.includes(r)) : JSON.parse(t.signer_roles_json);
    db.prepare(`UPDATE doc_templates SET name=?, kind=?, body=?, signer_roles_json=?, active=?, updated_at=datetime('now') WHERE id=?`)
      .run(String(b.name ?? t.name).trim() || t.name, TEMPLATE_KINDS.includes(b.kind) ? b.kind : t.kind,
        body, JSON.stringify(roles), b.active === undefined ? t.active : (b.active ? 1 : 0), t.id);
    audit(req, 'edit', 'doc-template#' + t.id, t.name);
    res.json({ ok: true });
  });

  app.delete('/api/doc-templates/:id', requireNoc, (req, res) => {
    const t = db.prepare('SELECT * FROM doc_templates WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    // Documents keep working: template_id is ON DELETE SET NULL and the merged body is stored on the
    // document itself, so deleting a template never alters what somebody already signed.
    db.prepare('DELETE FROM doc_templates WHERE id=?').run(t.id);
    audit(req, 'delete', 'doc-template#' + t.id, t.name);
    res.json({ ok: true });
  });

  /** Preview a template against a real parent, so merge gaps are visible before anything is sent. */
  app.post('/api/doc-templates/:id/preview', requireNoc, (req, res) => {
    const t = db.prepare('SELECT * FROM doc_templates WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (!PARENTS.includes(b.parent_type)) return res.status(400).json({ error: 'parent_type must be customer, site or pop' });
    const merged = mergeBody(t.body, mergeValues(b.parent_type, Number(b.parent_id), b.extra || {}));
    res.json({ text: merged.text, missing: merged.missing, fields: fieldsUsed(t.body) });
  });

  // ---- documents ---------------------------------------------------------------------------------

  app.get('/api/documents', requireNoc, (req, res) => {
    const where = [], args = [];
    if (req.query.parent_type && req.query.parent_id) {
      where.push('parent_type=? AND parent_id=?'); args.push(req.query.parent_type, Number(req.query.parent_id));
    }
    if (req.query.status) { where.push('status=?'); args.push(req.query.status); }
    const rows = db.prepare(`SELECT id,title,parent_type,parent_id,status,source,created_at,sent_at,completed_at,expires_at
      FROM documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...args);
    for (const r of rows) {
      r.parent_label = parentLabel(r.parent_type, r.parent_id);
      r.signers = db.prepare('SELECT id,role,name,status,signed_at FROM doc_signers WHERE document_id=? ORDER BY order_index,id').all(r.id);
    }
    res.json(rows);
  });

  app.get('/api/documents/:id', requireNoc, (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const signers = signersFor(d.id);
    const events = eventsFor(d.id);
    // Never return token_hash: it is not secret in the way the token is, but it has no business
    // leaving the server and its absence makes that unambiguous.
    for (const s of signers) delete s.token_hash;
    res.json({
      ...d,
      parent_label: parentLabel(d.parent_type, d.parent_id),
      signers, events,
      chain: verifyChain(events),
      state: signingState(signers)
    });
  });

  /**
   * Create a document from a template, or from body text typed directly.
   *
   * Signers are created here rather than at send time, because who must sign is part of what the
   * document IS — a lease with the countersigner added afterwards has a different meaning.
   */
  app.post('/api/documents', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!PARENTS.includes(b.parent_type)) return res.status(400).json({ error: 'parent_type must be customer, site or pop' });
    const parentId = Number(b.parent_id);
    if (!parentId) return res.status(400).json({ error: 'parent_id is required' });

    let body = String(b.body || ''), templateId = null, title = String(b.title || '').trim();
    if (b.template_id) {
      const t = db.prepare('SELECT * FROM doc_templates WHERE id=?').get(b.template_id);
      if (!t) return res.status(400).json({ error: 'template not found' });
      templateId = t.id;
      body = t.body;
      if (!title) title = t.name;
    }
    if (!title) return res.status(400).json({ error: 'A document needs a title' });

    const merged = mergeBody(body, mergeValues(b.parent_type, parentId, { 'document.title': title, ...(b.extra || {}) }));

    const signers = Array.isArray(b.signers) ? b.signers : [];
    if (!signers.length) return res.status(400).json({ error: 'At least one signer is required' });
    for (const s of signers) {
      if (!String(s.name || '').trim()) return res.status(400).json({ error: 'Every signer needs a name' });
      const via = DELIVERY.includes(s.delivery) ? s.delivery : 'email';
      if (via === 'email' && !String(s.email || '').trim()) return res.status(400).json({ error: `${s.name} is set to sign by email but has no email address` });
      if ((via === 'sms' || via === 'whatsapp') && !String(s.phone || '').trim()) return res.status(400).json({ error: `${s.name} is set to sign by ${via} but has no phone number` });
    }

    db.exec('BEGIN');
    try {
      const info = db.prepare(`INSERT INTO documents (title,template_id,source,parent_type,parent_id,body,status,created_by,expires_at)
        VALUES (?,?,?,?,?,?, 'draft', ?, ?)`).run(title, templateId, 'generated', b.parent_type, parentId,
        merged.text, (req.user && req.user.email) || null, b.expires_at || null);
      const id = info.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO doc_signers (document_id,role,name,email,phone,delivery,order_index)
        VALUES (?,?,?,?,?,?,?)`);
      signers.forEach((s, i) => ins.run(id, SIGNER_ROLES.includes(s.role) ? s.role : 'customer',
        String(s.name).trim(), s.email || null, s.phone || null,
        DELIVERY.includes(s.delivery) ? s.delivery : 'email',
        s.order_index === undefined ? i : Number(s.order_index)));
      db.exec('COMMIT');

      appendEvent({ document_id: id, kind: 'created', detail: `${title} for ${parentLabel(b.parent_type, parentId)}`, actor: (req.user && req.user.email) || null, req });
      audit(req, 'create', 'document#' + id, title);
      res.json({ id, missing: merged.missing });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  /** Edit a draft. Refused once sent — see the note at the top of this file. */
  app.put('/api/documents/:id', requireNoc, (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (d.status !== 'draft') {
      return res.status(409).json({ error: `This document has been ${d.status}. A sent document cannot be edited — void it and create a new one, so what was signed stays what was signed.` });
    }
    const b = req.body || {};
    db.prepare('UPDATE documents SET title=?, body=?, expires_at=? WHERE id=?')
      .run(String(b.title ?? d.title).trim() || d.title, b.body === undefined ? d.body : String(b.body), b.expires_at ?? d.expires_at, d.id);
    audit(req, 'edit', 'document#' + d.id, d.title);
    res.json({ ok: true });
  });

  /**
   * Freeze, render, hash and send.
   *
   * The hash is taken over the finished PDF bytes and stored before any link goes out, so there is
   * never a window in which a signer could be looking at something we cannot later reproduce.
   */
  app.post('/api/documents/:id/send', requireNoc, async (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (d.status !== 'draft') return res.status(409).json({ error: `Already ${d.status}` });

    const signers = signersFor(d.id);
    if (!signers.length) return res.status(400).json({ error: 'No signers' });

    const company = companyProfile();
    const pdf = renderDocument({ title: d.title, body: d.body || '', signers, company, date: longDate(new Date()) });
    const bytes = pdf.build();
    // Filed under the customer, site or POP this document belongs to.
    const target = ctx.files.place(d.parent_type, d.parent_id, parentLabel(d.parent_type, d.parent_id), 'documents',
      `${d.title}.pdf`, { prefix: `doc-${d.id}` });
    writeFileSync(target.absolute, bytes);
    const stored = target.stored;
    const hash = sha256(bytes);

    db.prepare(`UPDATE documents SET stored_name=?, content_sha256=?, status='sent', sent_at=datetime('now') WHERE id=?`)
      .run(stored, hash, d.id);
    appendEvent({ document_id: d.id, kind: 'sent', detail: `document frozen, sha256 ${hash.slice(0, 16)}…`, actor: (req.user && req.user.email) || null, req });

    const base = ctx.pubBase ? ctx.pubBase(req) : '';
    const out = [];
    for (const s of signers) {
      const link = await issueLink(d, s, base, req);
      out.push(link);
    }
    audit(req, 'send', 'document#' + d.id, `${d.title} → ${signers.length} signer(s)`);
    res.json({ ok: true, sha256: hash, deliveries: out, public_base_set: !!base });
  });

  /**
   * Mint a signer's link and deliver it.
   *
   * Returned to staff in the response as well, deliberately: if SMTP is misconfigured or the public
   * URL is unset, the alternative is a document nobody can sign and no way to find out why. An
   * in-person signer has no delivery at all and the link is the whole point.
   */
  async function issueLink(doc, signer, base, req) {
    const { token, hash } = makeToken();
    const days = Number(getSetting('doc_link_days') || 14);
    const expires = new Date(Date.now() + days * 86400e3).toISOString();
    db.prepare('UPDATE doc_signers SET token_hash=?, token_expires_at=? WHERE id=?').run(hash, expires, signer.id);

    // A clean path, matching /locator and /portal. What a signer sees in their address bar is part
    // of whether they trust the link enough to open it, and a bare .html reads like something left
    // on a server by accident. /sign also says what the page is for, which /docs did not.
    const url = base ? `${base}/sign#${token}` : `/sign#${token}`;
    const result = { signer_id: signer.id, name: signer.name, role: signer.role, delivery: signer.delivery, url, sent: false, error: null };

    const subject = `Please sign: ${doc.title}`;
    const text = `${signer.name},\n\n${getSetting('company_name') || 'GeekiTek'} has sent you a document to review and sign:\n\n  ${doc.title}\n\nOpen this link to read and sign it:\n${url}\n\nThe link is personal to you and expires in ${days} days.\nIf you were not expecting this, do not open it — reply to this message instead.\n`;

    try {
      if (signer.delivery === 'email' && signer.email) {
        // Prefer the connected Workspace mailbox over SMTP. A contract arriving from the address the
        // customer already corresponds with is the point; one from a no-reply@ they do not recognise
        // is the kind of mail people delete without opening.
        const sent = ctx.sendMailBest
          ? await ctx.sendMailBest({ to: signer.email, subject, text, purpose: 'customer' })
          : { ok: !!(await sendMail({ to: signer.email, subject, text })), via: 'smtp' };
        result.sent = sent.ok;
        result.via = sent.via;
        result.from = sent.from || null;
        if (!sent.ok) result.error = sent.error || 'Could not send';
      } else if ((signer.delivery === 'sms' || signer.delivery === 'whatsapp') && signer.phone && ctx.deliverOnChannel) {
        await ctx.deliverOnChannel(signer.delivery, signer.phone, `${doc.title} — please review and sign: ${url}`);
        result.sent = true;
      } else if (signer.delivery === 'in_person' || signer.delivery === 'portal') {
        result.sent = true;    // nothing to deliver; the link is opened here or in the portal
      } else {
        result.error = 'No address or number for this delivery method';
      }
    } catch (e) {
      result.error = e.message;
    }
    appendEvent({
      document_id: doc.id, signer_id: signer.id, kind: result.sent ? 'delivered' : 'delivery_failed',
      // Records WHICH transport carried it and from what address. On the certificate this is part of
      // the attribution evidence: "sent to this address, from that one, at this time".
      detail: `${signer.delivery} to ${signer.email || signer.phone || 'this device'}` +
        (result.via ? ` via ${result.via}${result.from ? ` as ${result.from}` : ''}` : '') +
        (result.error ? ` — ${result.error}` : ''),
      actor: (req && req.user && req.user.email) || null, req
    });
    return result;
  }

  /** Re-send, with a fresh token. The old link stops working, which is the point of resending. */
  app.post('/api/documents/:id/signers/:sid/resend', requireNoc, async (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    const s = db.prepare('SELECT * FROM doc_signers WHERE id=? AND document_id=?').get(req.params.sid, req.params.id);
    if (!d || !s) return res.status(404).json({ error: 'not found' });
    if (s.status === 'signed') return res.status(409).json({ error: 'Already signed' });
    if (d.status === 'draft') return res.status(409).json({ error: 'Send the document first' });
    const out = await issueLink(d, s, ctx.pubBase ? ctx.pubBase(req) : '', req);
    res.json(out);
  });

  app.post('/api/documents/:id/void', requireNoc, (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (d.status === 'signed') return res.status(409).json({ error: 'A completed document cannot be voided. Supersede it with a new one.' });
    const reason = String((req.body || {}).reason || '').trim();
    db.prepare("UPDATE documents SET status='voided', voided_reason=? WHERE id=?").run(reason || null, d.id);
    // Every outstanding link dies with it.
    db.prepare('UPDATE doc_signers SET token_hash=NULL WHERE document_id=?').run(d.id);
    appendEvent({ document_id: d.id, kind: 'voided', detail: reason || 'no reason given', actor: (req.user && req.user.email) || null, req });
    audit(req, 'delete', 'document#' + d.id, `voided: ${reason}`);
    res.json({ ok: true });
  });

  /** The PDF. `signed=1` asks for the completed copy once it exists. */
  app.get('/api/documents/:id/pdf', requireNoc, (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const wantSigned = req.query.signed === '1' && d.signed_stored_name;
    const name = wantSigned ? d.signed_stored_name : d.stored_name;
    if (!name) return res.status(404).json({ error: 'No PDF yet — send the document to generate it' });
    const fp = ctx.files.resolveStored(name);
    if (!existsSync(fp)) return res.status(404).json({ error: 'The stored file is missing' });
    appendEvent({ document_id: d.id, kind: 'downloaded', detail: wantSigned ? 'signed copy' : 'unsigned copy', actor: (req.user && req.user.email) || null, req });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${d.title.replace(/[^\w.-]+/g, '-').toLowerCase()}${wantSigned ? '-signed' : ''}.pdf"`);
    res.send(readFileSync(fp));
  });

  /** Verify the chain on demand — the answer to "how do you know this was not edited?" */
  app.get('/api/documents/:id/verify', requireNoc, (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const events = eventsFor(d.id);
    const chain = verifyChain(events);
    const files = {};
    for (const [key, name] of [['sent', d.stored_name], ['signed', d.signed_stored_name]]) {
      if (!name) continue;
      const fp = ctx.files.resolveStored(name);
      const expected = key === 'sent' ? d.content_sha256 : d.signed_sha256;
      files[key] = existsSync(fp) ? { present: true, matches: sha256(readFileSync(fp)) === expected, expected } : { present: false };
    }
    res.json({ chain, events: events.length, files });
  });

  // ---- the signing surface, reached with a token and no login --------------------------------------
  //
  // This is the only part of the application a stranger can reach with a credential we emailed them,
  // so it is written defensively: one signer, one document, nothing else readable, and no hint
  // whether a token was valid-but-expired or never existed at all.

  const badToken = (res) => res.status(404).json({ error: 'This signing link is not valid. It may have expired, been replaced by a newer one, or already been used.' });

  function signerByToken(token) {
    if (!token || typeof token !== 'string' || token.length < 20) return null;
    const s = db.prepare('SELECT * FROM doc_signers WHERE token_hash=?').get(hashToken(token));
    if (!s) return null;
    if (s.token_expires_at && new Date(s.token_expires_at) < new Date()) return null;
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(s.document_id);
    if (!d || ['voided', 'expired'].includes(d.status)) return null;
    return { signer: s, doc: d };
  }

  app.post('/api/sign/open', (req, res) => {
    const found = signerByToken((req.body || {}).token);
    if (!found) return badToken(res);
    const { signer, doc } = found;
    const signers = signersFor(doc.id);

    if (signer.status !== 'signed' && !signer.viewed_at) {
      db.prepare("UPDATE doc_signers SET status=CASE WHEN status='pending' THEN 'viewed' ELSE status END, viewed_at=datetime('now') WHERE id=?").run(signer.id);
      appendEvent({ document_id: doc.id, signer_id: signer.id, kind: 'viewed', detail: `${signer.name} opened the document`, actor: signer.name, req });
    }

    const state = signingState(signers);
    res.json({
      title: doc.title,
      body: doc.body,
      status: doc.status,
      company: getSetting('company_name') || 'GeekiTek',
      signer: { id: signer.id, name: signer.name, role: signer.role, role_label: roleLabel(signer.role), status: signer.status, consented: !!signer.consent_at },
      // Other signers appear by role and status only. A lessor does not need the customer's email.
      others: signers.filter(s => s.id !== signer.id).map(s => ({ role_label: roleLabel(s.role), name: s.name, status: s.status })),
      can_sign: canSign(signer, signers),
      waiting_for: state.next.filter(s => s.id !== signer.id).map(s => roleLabel(s.role)),
      already_signed: signer.status === 'signed',
      declined: signer.status === 'declined',
      sha256: doc.content_sha256
    });
  });

  /**
   * Consent, recorded before and separately from the signature.
   *
   * ESIGN treats agreeing to transact electronically as its own act. Bundling it into the signature
   * click makes it impossible to show afterwards that the person was told they could have paper.
   */
  app.post('/api/sign/consent', (req, res) => {
    const found = signerByToken((req.body || {}).token);
    if (!found) return badToken(res);
    const { signer, doc } = found;
    if (signer.consent_at) return res.json({ ok: true, already: true });
    db.prepare("UPDATE doc_signers SET consent_at=datetime('now') WHERE id=?").run(signer.id);
    appendEvent({
      document_id: doc.id, signer_id: signer.id, kind: 'consented',
      detail: `${signer.name} agreed to sign electronically and was offered a paper copy`,
      actor: signer.name, req
    });
    res.json({ ok: true });
  });

  app.post('/api/sign/submit', (req, res) => {
    const b = req.body || {};
    const found = signerByToken(b.token);
    if (!found) return badToken(res);
    const { signer, doc } = found;
    const signers = signersFor(doc.id);

    if (signer.status === 'signed') return res.status(409).json({ error: 'You have already signed this document.' });
    if (!canSign(signer, signers)) {
      const waiting = signingState(signers).next.map(s => roleLabel(s.role)).join(', ');
      return res.status(409).json({ error: `It is not your turn yet — waiting on ${waiting}.` });
    }
    if (!signer.consent_at) return res.status(400).json({ error: 'Consent to sign electronically is required first.' });

    const kind = b.kind === 'typed' ? 'typed' : 'drawn';
    let strokes = null, typed = null;
    if (kind === 'drawn') {
      if (!Array.isArray(b.strokes) || !b.strokes.length) return res.status(400).json({ error: 'Please draw your signature.' });
      // Bound the stored geometry: this is attacker-controlled JSON going into the database and then
      // into a PDF. A signature is a few hundred points; a million is someone probing.
      const points = b.strokes.reduce((n, s) => n + (Array.isArray(s) ? s.length : 0), 0);
      if (points > 20000) return res.status(400).json({ error: 'Signature is too complex; please clear and try again.' });
      strokes = JSON.stringify(b.strokes.map(s => s.map(p => ({ x: Math.round(Number(p.x) * 100) / 100, y: Math.round(Number(p.y) * 100) / 100 }))));
    } else {
      typed = String(b.typed || '').trim();
      if (typed.length < 2) return res.status(400).json({ error: 'Please type your full name.' });
      if (typed.length > 120) return res.status(400).json({ error: 'That name is too long.' });
    }

    // The token is deliberately NOT cleared here.
    //
    // It was, and that broke the thing the signer needs most: the success screen offers "download
    // your copy", which is fetched with this same token, so clearing it meant the link died at the
    // exact moment somebody signed and they were told their link was invalid. A signer is entitled
    // to the record they just agreed to — ESIGN requires it be retainable and reproducible by them —
    // and denying it one second after signing is the worst possible time.
    //
    // Nothing is lost by keeping it. Signing twice is already refused by status, both here and in
    // canSign(), so a forwarded link cannot produce a second signature; it can only read a document
    // that person has already signed. The token still expires on its own schedule, and resending
    // still mints a new one and invalidates this.
    const geo = readGeo(b);
    const clientAt = cleanClientAt(b.client_at);
    const tz = cleanTz(b.tz);
    db.prepare(`UPDATE doc_signers SET status='signed', signed_at=datetime('now'), signature_kind=?,
      signature_strokes=?, signature_typed=?, signed_ip=?, signed_user_agent=?,
      signed_lat=?, signed_lng=?, signed_accuracy=?, signed_geo=?, signed_tz=?, signed_client_at=? WHERE id=?`)
      .run(kind, strokes, typed, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300),
        geo.lat, geo.lng, geo.accuracy, geo.status, tz, clientAt, signer.id);
    const saved = db.prepare('SELECT signed_at FROM doc_signers WHERE id=?').get(signer.id);
    const where = geo.status === 'captured' ? ` at ${geo.lat}, ${geo.lng}` : ` (location ${geo.status})`;
    appendEvent({
      document_id: doc.id, signer_id: signer.id, kind: 'signed',
      detail: `${signer.name} signed (${kind}) ${saved.signed_at} UTC${where}; document sha256 ${String(doc.content_sha256).slice(0, 16)}…`,
      actor: signer.name, req
    });

    const after = signersFor(doc.id);
    const state = signingState(after);
    if (state.status === 'signed') {
      finalise(doc.id, req);
      return res.json({ ok: true, complete: true });
    }
    db.prepare('UPDATE documents SET status=? WHERE id=?').run(state.status, doc.id);
    res.json({ ok: true, complete: false, waiting_for: state.next.map(s => roleLabel(s.role)) });
  });

  app.post('/api/sign/decline', (req, res) => {
    const b = req.body || {};
    const found = signerByToken(b.token);
    if (!found) return badToken(res);
    const { signer, doc } = found;
    if (signer.status === 'signed') return res.status(409).json({ error: 'You have already signed this document.' });
    const reason = String(b.reason || '').trim().slice(0, 500);
    // Token kept, for the same reason as signing: somebody who declined should still be able to
    // look at what they declined. Signing is refused by status, not by the token being gone.
    db.prepare("UPDATE doc_signers SET status='declined', declined_at=datetime('now'), declined_reason=? WHERE id=?").run(reason || null, signer.id);
    db.prepare("UPDATE documents SET status='declined' WHERE id=?").run(doc.id);
    appendEvent({ document_id: doc.id, signer_id: signer.id, kind: 'declined', detail: `${signer.name} declined${reason ? ': ' + reason : ''}`, actor: signer.name, req });
    res.json({ ok: true });
  });

  /**
   * A page, not a JSON body, when this one fails.
   *
   * Every other signing endpoint is called by fetch from sign.html, so a JSON error is read and
   * displayed properly. THIS one is a plain link a person clicks, so the browser navigates to it —
   * and a failure painted {"error":"This signing link is not valid…"} across a white page at a
   * customer who had just signed a contract.
   */
  const pdfProblem = (res, status, message) => res.status(status).type('html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Document unavailable</title>
     <div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1f1f1d">
       <h1 style="font-size:20px;margin:0 0 .6rem">This document is not available</h1>
       <p style="color:#5f5e5a;margin:0 0 .6rem">${String(message).replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' }[c]))}</p>
       <p style="color:#5f5e5a;margin:0">Reply to the message that sent you here and we will send it again.</p>
     </div>`);

  /** The signer's own copy, by token. They are entitled to it and it costs us nothing. */
  app.get('/api/sign/pdf', (req, res) => {
    const found = signerByToken(req.query.token);
    if (!found) return pdfProblem(res, 404, 'This link is no longer valid. It may have expired or been replaced by a newer one.');
    const { doc } = found;
    const name = doc.signed_stored_name || doc.stored_name;
    if (!name) return pdfProblem(res, 404, 'There is no document to download yet.');
    const fp = ctx.files.resolveStored(name);
    if (!existsSync(fp)) return pdfProblem(res, 404, 'The stored file could not be found.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.title.replace(/[^\w.-]+/g, '-').toLowerCase()}.pdf"`);
    res.send(readFileSync(fp));
  });

  // ---- completion ----------------------------------------------------------------------------------

  /**
   * Re-render the document with every signature, append the certificate, and file it.
   *
   * The signed copy is a NEW file; the as-sent file is kept. Overwriting it would destroy the
   * evidence that the signed text matches what was sent, which is the one comparison a dispute
   * actually turns on.
   */
  function finalise(documentId, req) {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(documentId);
    const signers = signersFor(documentId);

    const signatures = {};
    for (const s of signers) {
      if (s.status !== 'signed') continue;
      signatures[s.id] = {
        kind: s.signature_kind,
        strokes: s.signature_strokes ? JSON.parse(s.signature_strokes) : null,
        typed: s.signature_typed,
        at: s.signed_at,
        clientAt: s.signed_client_at,
        tz: s.signed_tz,
        lat: s.signed_lat,
        lng: s.signed_lng,
        accuracy: s.signed_accuracy,
        geo: s.signed_geo
      };
    }

    // The completion event has to exist BEFORE the certificate is drawn, or the certificate prints
    // an event log that is missing the very event it is certifying.
    appendEvent({ document_id: documentId, kind: 'completed', detail: `all ${signers.length} signer(s) signed`, actor: 'system', req });

    const events = eventsFor(documentId);
    const chain = verifyChain(events);
    const company = companyProfile();

    // One builder, two parts: the signed document, then the certificate on a fresh page. Both are
    // drawn by the same renderers used everywhere else, so the customer's copy and ours cannot drift.
    const pdf = renderDocument({
      title: doc.title, body: doc.body || '', signers, signatures, company,
      date: longDate(sqlDate(doc.sent_at || doc.created_at)),
      footer: `Document #${doc.id} · as-sent sha256 ${String(doc.content_sha256).slice(0, 24)}... · certificate attached`
    });
    pdf.addPage();
    drawCertificate(pdf, { document: doc, signers, events, chain });

    const bytes = pdf.build();
    const target = ctx.files.place(doc.parent_type, doc.parent_id, parentLabel(doc.parent_type, doc.parent_id), 'documents',
      `${doc.title}-signed.pdf`, { prefix: `doc-${doc.id}` });
    writeFileSync(target.absolute, bytes);
    const stored = target.stored;
    db.prepare(`UPDATE documents SET signed_stored_name=?, signed_sha256=?, status='signed', completed_at=datetime('now') WHERE id=?`)
      .run(stored, sha256(bytes), documentId);
    return stored;
  }

  // ---- housekeeping ----------------------------------------------------------------------------------

  /** Expire documents whose links have run out, so the list reflects reality. */
  ctx.jobs.expireDocuments = () => {
    const rows = db.prepare(`SELECT id,title FROM documents WHERE status IN ('sent','viewed','partially_signed')
      AND expires_at IS NOT NULL AND expires_at < datetime('now')`).all();
    for (const r of rows) {
      db.prepare("UPDATE documents SET status='expired' WHERE id=?").run(r.id);
      db.prepare('UPDATE doc_signers SET token_hash=NULL WHERE document_id=?').run(r.id);
      appendEvent({ document_id: r.id, kind: 'expired', detail: 'passed its expiry date', actor: 'system' });
    }
    return rows.length;
  };

  ctx.documentsFor = (parentType, parentId) =>
    db.prepare(`SELECT id,title,status,created_at,completed_at FROM documents
      WHERE parent_type=? AND parent_id=? ORDER BY id DESC`).all(parentType, parentId);
}
