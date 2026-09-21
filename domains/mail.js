// Google Workspace mailboxes: credential storage, and a connection test that diagnoses.
//
// THE CONNECTION TEST IS THE POINT OF THIS FILE. Domain-wide delegation has perhaps six ways to be
// almost-configured, and Google reports most of them as one of two opaque errors. A green tick
// would be worthless here. This performs a real read, a real send-as lookup, and reports what it
// found — including the cases where it technically worked but will misbehave later.
//
// The one that deserves naming: if the From address is not one the account may send as, Gmail does
// not refuse. It silently rewrites From to the account's own address and returns success. Mail goes
// out under the wrong identity, the customer replies to somewhere unexpected, and no error is
// raised anywhere. So send-as is verified against Gmail's own list at setup rather than trusted.
import { parseServiceAccount, createTokenSource, ALL_SCOPES } from '../lib/googleauth.js';
import { createGmailClient, addresses, buildRawMessage } from '../lib/gmail.js';

const PURPOSES = ['customer', 'vendor', 'billing', 'other'];

export default function registerMail(app, ctx) {
  const { db, audit, requireNoc, requireAdmin, getSetting, setSetting } = ctx;

  // One token source per credential generation. Replacing the key must not leave tokens minted from
  // the old one usable.
  let _tokenSource = null, _sourceForKey = null;

  function serviceAccount() {
    const raw = getSetting('google_sa_key');
    if (!raw) return null;
    const p = parseServiceAccount(raw);
    return p.ok ? p.key : null;
  }

  function tokenSource() {
    const key = serviceAccount();
    if (!key) return null;
    if (!_tokenSource || _sourceForKey !== key.client_email + key.private_key.slice(-40)) {
      _tokenSource = createTokenSource({ key });
      _sourceForKey = key.client_email + key.private_key.slice(-40);
    }
    return _tokenSource;
  }

  function clientFor(mailbox) {
    const src = tokenSource();
    if (!src) throw new Error('No Google service account key has been saved yet (Settings → Email).');
    return createGmailClient({ tokenSource: src, mailbox: mailbox.impersonate_as, scopes: ALL_SCOPES });
  }
  ctx.gmailClientFor = clientFor;

  /**
   * Ask Gmail which From addresses this mailbox may use, and store them.
   *
   * Saved even when the rest of a connection test fails. The alias list is a fact about the
   * account; throwing it away because the configured From is wrong is how someone ends up deleting
   * the mailbox just to see a new address.
   */
  async function refreshAliases(m) {
    const list = await clientFor(m).sendAs();
    const rows = list.sendAs || [];
    const permitted = rows.map(s => String(s.sendAsEmail || '').toLowerCase()).filter(Boolean);
    const primary = (rows.find(s => s.isPrimary) || {}).sendAsEmail || null;
    db.prepare('UPDATE mailboxes SET verified_send_as=? WHERE id=?').run(JSON.stringify(permitted), m.id);
    return { permitted, primary };
  }

  /**
   * The mailbox to send a given kind of mail from.
   *
   * Prefers one that has actually passed a connection test. An unverified mailbox may work, but it
   * may also be the one whose From address Gmail will silently rewrite — and finding that out by
   * sending a customer a contract from the wrong address is the expensive way.
   */
  function pickMailbox(purpose = 'customer') {
    const rows = db.prepare('SELECT * FROM mailboxes WHERE enabled=1 ORDER BY (verified_at IS NULL), id').all();
    return rows.find(m => m.purpose === purpose) || rows.find(m => m.purpose === 'customer') || rows[0] || null;
  }
  ctx.pickMailbox = pickMailbox;

  /** Addresses this mailbox may put in the From header. Verified ones first, then the configured pair. */
  function allowedFrom(m) {
    let verified = [];
    try { verified = m.verified_send_as ? JSON.parse(m.verified_send_as) : []; } catch { verified = []; }
    const extra = [m.send_as, m.impersonate_as].filter(Boolean);
    return [...new Set([...verified, ...extra].map(s => String(s).trim().toLowerCase()).filter(Boolean))];
  }
  function mailboxForFrom(from) {
    const want = String(from || '').trim().toLowerCase();
    if (!want) return null;
    return db.prepare('SELECT * FROM mailboxes WHERE enabled=1 ORDER BY id').all()
      .find(m => allowedFrom(m).includes(want)) || null;
  }
  ctx.listSenders = function listSenders() {
    const out = [];
    for (const m of db.prepare('SELECT * FROM mailboxes WHERE enabled=1 ORDER BY purpose, label, id').all()) {
      const preferred = String(m.send_as || m.impersonate_as || '').trim().toLowerCase();
      for (const address of allowedFrom(m)) {
        out.push({ mailbox_id: m.id, address, label: m.label, purpose: m.purpose, preferred: address === preferred });
      }
    }
    return out;
  };
  app.get('/api/mail/senders', requireNoc, (req, res) => res.json(ctx.listSenders()));

  /**
   * Send through Gmail, falling back to SMTP.
   *
   * Returns a result rather than throwing, and always says which transport carried it. A signing
   * link that silently did not arrive is the worst outcome here: the customer waits, we think it is
   * sent, and nobody finds out until someone chases. The caller records this in the audit trail.
   */
  ctx.sendMailBest = async function sendMailBest({ to, subject, text, html, purpose = 'customer', replyTo, from }) {
    const explicit = String(from || '').trim().toLowerCase();
    const mb = explicit ? mailboxForFrom(explicit) : pickMailbox(purpose);
    // A chosen From that this account cannot use must fail here. Gmail's own behaviour is to accept
    // the send and quietly rewrite the address, which is how mail leaves under the wrong name.
    if (explicit && !mb) return { ok: false, error: `${explicit} is not a send-as address on a connected mailbox.` };
    let gmailError = null;

    if (mb) {
      try {
        const client = clientFor(mb);
        const fromAddr = explicit || mb.send_as || mb.impersonate_as;
        const raw = buildRawMessage({
          from: fromAddr, fromName: getSetting('company_name') || null,
          to: Array.isArray(to) ? to : [to],
          subject, text, html,
          headers: replyTo ? { 'Reply-To': replyTo } : {}
        });
        const sent = await client.send({ raw });
        return { ok: true, via: 'gmail', from: fromAddr, id: sent && sent.id, mailbox: mb.label };
      } catch (e) {
        gmailError = e.message;
        if (explicit) return { ok: false, error: `Gmail could not send as ${explicit}: ${e.message}` };
      }
    }

    try {
      const id = await ctx.sendMail({ to, subject, text, html, replyTo });
      if (id) return { ok: true, via: 'smtp', id, gmail_error: gmailError };
      return {
        ok: false, via: null,
        error: mb
          ? `Gmail failed (${gmailError}) and SMTP is not configured as a fallback.`
          : 'No Google Workspace mailbox is connected, and SMTP is not configured (Settings → Email).'
      };
    } catch (e) {
      return { ok: false, via: null, error: `Gmail: ${gmailError || 'no mailbox connected'}. SMTP: ${e.message}` };
    }
  };

  // ---- the credential ------------------------------------------------------------------------------

  /**
   * What the UI may know about the stored key.
   *
   * Never the private key. The client_id IS returned, deliberately — it is the value that must be
   * pasted into Admin Console, it is not a secret (it identifies the service account, it does not
   * authenticate it), and making someone dig it out of Google Cloud again invites pasting the wrong
   * long number.
   */
  app.get('/api/mail/credential', requireNoc, (req, res) => {
    const raw = getSetting('google_sa_key');
    if (!raw) return res.json({ configured: false });
    const p = parseServiceAccount(raw);
    if (!p.ok) return res.json({ configured: true, valid: false, error: p.error });
    res.json({
      configured: true, valid: true,
      client_email: p.key.client_email,
      client_id: p.key.client_id,
      project_id: p.key.project_id,
      scopes: ALL_SCOPES
    });
  });

  app.put('/api/mail/credential', requireAdmin, (req, res) => {
    const raw = String((req.body || {}).key || '');
    if (!raw.trim()) return res.status(400).json({ error: 'Paste the contents of the service account JSON key file.' });
    const p = parseServiceAccount(raw);
    if (!p.ok) return res.status(400).json({ error: p.error });

    setSetting('google_sa_key', raw);
    _tokenSource = null;                       // tokens from the previous key must stop working
    // The key itself is never logged, but the fact of replacement is: this is a credential that can
    // read every authorised mailbox, and a change to it should be visible in the audit trail.
    audit(req, 'edit', 'settings', `Google service account key set (${p.key.client_email})`);
    res.json({ ok: true, client_email: p.key.client_email, client_id: p.key.client_id });
  });

  app.delete('/api/mail/credential', requireAdmin, (req, res) => {
    setSetting('google_sa_key', '');
    _tokenSource = null;
    db.prepare('UPDATE mailboxes SET verified_at=NULL, verified_send_as=NULL').run();
    audit(req, 'delete', 'settings', 'Google service account key removed');
    res.json({ ok: true });
  });

  // ---- mailboxes ------------------------------------------------------------------------------------

  const publicMailbox = (m) => ({ ...m, verified_send_as: m.verified_send_as ? JSON.parse(m.verified_send_as) : null });

  app.get('/api/mail/mailboxes', requireNoc, (req, res) => {
    res.json(db.prepare('SELECT * FROM mailboxes ORDER BY purpose, label').all().map(publicMailbox));
  });

  app.post('/api/mail/mailboxes', requireAdmin, (req, res) => {
    const b = req.body || {};
    const impersonate = String(b.impersonate_as || '').trim().toLowerCase();
    if (!addresses(impersonate).length) return res.status(400).json({ error: 'A valid email address is required.' });
    const sendAs = String(b.send_as || '').trim().toLowerCase() || null;
    if (sendAs && !addresses(sendAs).length) return res.status(400).json({ error: 'The "send as" value is not a valid email address.' });

    const exists = db.prepare('SELECT id FROM mailboxes WHERE impersonate_as=?').get(impersonate);
    if (exists) return res.status(409).json({ error: 'That mailbox is already connected.' });

    const info = db.prepare(`INSERT INTO mailboxes (label, impersonate_as, send_as, purpose)
      VALUES (?,?,?,?)`).run(String(b.label || impersonate.split('@')[0]).trim(), impersonate, sendAs,
      PURPOSES.includes(b.purpose) ? b.purpose : 'customer');
    audit(req, 'create', 'mailbox#' + info.lastInsertRowid, impersonate);
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/mail/mailboxes/:id', requireAdmin, (req, res) => {
    const m = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const sendAs = b.send_as === undefined ? m.send_as : (String(b.send_as || '').trim().toLowerCase() || null);
    db.prepare('UPDATE mailboxes SET label=?, send_as=?, purpose=?, enabled=? WHERE id=?').run(
      String(b.label ?? m.label).trim() || m.label, sendAs,
      PURPOSES.includes(b.purpose) ? b.purpose : m.purpose,
      b.enabled === undefined ? m.enabled : (b.enabled ? 1 : 0), m.id);
    audit(req, 'edit', 'mailbox#' + m.id, m.impersonate_as);
    res.json({ ok: true });
  });

  app.delete('/api/mail/mailboxes/:id', requireAdmin, (req, res) => {
    const m = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM mailboxes WHERE id=?').run(m.id);
    audit(req, 'delete', 'mailbox#' + m.id, m.impersonate_as);
    res.json({ ok: true });
  });

  // ---- the connection test ----------------------------------------------------------------------------

  /**
   * Actually connect, and report everything a person needs to fix what is wrong.
   *
   * Returns a list of checks rather than a boolean. Several of the interesting outcomes are "it
   * connected, but something will go wrong later" — a send-as that Gmail will silently rewrite, or
   * a mailbox reachable under a different address than the one that was typed.
   */
  app.post('/api/mail/mailboxes/:id/test', requireNoc, async (req, res) => {
    const m = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });

    const key = serviceAccount();
    if (!key) return res.json({ ok: false, checks: [{ name: 'Service account key', ok: false, detail: 'No key saved. Paste the JSON key under Settings → Email first.' }] });

    const checks = [{ name: 'Service account key', ok: true, detail: `${key.client_email} (client ID ${key.client_id || 'unknown'})` }];
    let client;
    try { client = clientFor(m); }
    catch (e) { checks.push({ name: 'Client', ok: false, detail: e.message }); return res.json({ ok: false, checks }); }

    // 1. Impersonation + a real read.
    let profile = null;
    try {
      profile = await client.profile();
      checks.push({
        name: 'Impersonation', ok: true,
        detail: `Signed in as ${profile.emailAddress}. ${profile.messagesTotal ?? '?'} messages, ${profile.threadsTotal ?? '?'} threads.`
      });
    } catch (e) {
      checks.push({ name: 'Impersonation', ok: false, detail: e.message });
      audit(req, 'view', 'mailbox#' + m.id, `connection test failed: ${e.message.slice(0, 120)}`);
      return res.json({ ok: false, checks });
    }

    // Google reporting a different address than we asked for means we impersonated an alias and it
    // resolved to the underlying account. It works, but storing the alias leaves a setting that is
    // true by accident, so it is worth saying plainly.
    if (profile.emailAddress && profile.emailAddress.toLowerCase() !== m.impersonate_as.toLowerCase()) {
      checks.push({
        name: 'Address', ok: true, warn: true,
        detail: `You entered ${m.impersonate_as} but Google resolved it to ${profile.emailAddress}. That is the account's primary address — worth storing instead, since delegation is only guaranteed to accept the primary.`,
        suggest_impersonate_as: profile.emailAddress.toLowerCase()
      });
    }

    // 2. Which From addresses are actually permitted.
    let permitted = null;
    let primaryEmail = null;
    try {
      const found = await refreshAliases(m);
      permitted = found.permitted;
      primaryEmail = found.primary;
      checks.push({
        name: 'Send-as addresses', ok: true,
        detail: permitted.length
          ? `${permitted.join(', ')}${primaryEmail ? ` (default: ${primaryEmail})` : ''}`
          : 'Gmail returned no send-as addresses, which is unusual.'
      });
    } catch (e) {
      // Not fatal: reading mail still works. But it means the From check below cannot be made.
      checks.push({ name: 'Send-as addresses', ok: false, warn: true, detail: `Could not read the send-as list (${e.message}). Reading mail is unaffected; outbound From cannot be verified.` });
    }

    // 3. The silent-rewrite trap.
    const wantFrom = (m.send_as || m.impersonate_as).toLowerCase();
    if (permitted) {
      if (permitted.includes(wantFrom)) {
        checks.push({ name: 'From address', ok: true, detail: `Mail will go out as ${wantFrom}, which this account is permitted to use.` });
      } else {
        checks.push({
          name: 'From address', ok: false,
          detail: `This account may NOT send as ${wantFrom}. Gmail will not refuse — it will quietly rewrite the From to ${profile.emailAddress} and report success, so mail would go out under the wrong address with no error. Either add ${wantFrom} in that account's Gmail settings (Accounts → Send mail as) and verify it, or set the send-as here to one of: ${permitted.join(', ')}.`
        });
      }
    }

    const ok = checks.every(c => c.ok || c.warn);
    if (ok) db.prepare("UPDATE mailboxes SET verified_at=datetime('now') WHERE id=?").run(m.id);
    audit(req, 'view', 'mailbox#' + m.id, `connection test: ${ok ? 'passed' : 'failed'}`);
    res.json({ ok, checks, profile: profile ? { emailAddress: profile.emailAddress, messagesTotal: profile.messagesTotal } : null });
  });

  app.post('/api/mail/mailboxes/:id/aliases', requireNoc, async (req, res) => {
    const m = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    if (!serviceAccount()) return res.status(400).json({ error: 'No Google service account key has been saved yet (Settings → Email).' });
    try {
      const { permitted, primary } = await refreshAliases(m);
      audit(req, 'view', 'mailbox#' + m.id, `send-as re-check: ${permitted.join(', ') || 'none'}`);
      res.json({ ok: true, aliases: permitted, primary });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  /**
   * Adopt the primary address the test discovered.
   *
   * Separate from the test on purpose: the test reports, the person decides. Silently rewriting a
   * setting somebody typed, on the strength of an API response, is how configuration becomes
   * something nobody can reason about.
   */
  app.post('/api/mail/mailboxes/:id/adopt-primary', requireAdmin, async (req, res) => {
    const m = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const primary = String((req.body || {}).impersonate_as || '').trim().toLowerCase();
    if (!addresses(primary).length) return res.status(400).json({ error: 'A valid address is required.' });

    // Keep the address originally entered as the send-as, unless one was set: it is what the person
    // wanted mail to come from, and that intent should survive fixing the impersonation address.
    const keepSendAs = m.send_as || m.impersonate_as;
    db.prepare('UPDATE mailboxes SET impersonate_as=?, send_as=?, verified_at=NULL WHERE id=?')
      .run(primary, keepSendAs === primary ? null : keepSendAs, m.id);
    audit(req, 'edit', 'mailbox#' + m.id, `impersonation address ${m.impersonate_as} → ${primary}`);
    res.json({ ok: true, impersonate_as: primary, send_as: keepSendAs === primary ? null : keepSendAs });
  });
}
