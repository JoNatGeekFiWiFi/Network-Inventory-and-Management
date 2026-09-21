// Google Workspace mail: the service-account handshake, and the Gmail payloads it brings back.
//
// None of this can be checked by pointing it at a live mailbox and looking, which is exactly why it
// needs testing. Two things dominate:
//
//   * THE MIME TREE. Real mail is nested. A reply from Outlook with an attachment is multipart/mixed
//     around multipart/alternative around text/plain and text/html, and the readable text sits three
//     levels down. Reading payload.body.data at the top works on the simplest possible message and
//     returns EMPTY for most real mail — silently, with no error to notice.
//   * THREADING. A reply threads on the recipient's side via In-Reply-To and References, and in our
//     own mailbox via Gmail's threadId. These are independent, and getting only the second right
//     produces a mailbox that looks correct to us while every customer sees unrelated messages.
//
// The signing is verified against a real RSA keypair, so the assertion is checked by cryptography
// rather than by agreeing with itself.
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  parseServiceAccount, buildAssertion, createTokenSource, explainTokenError, SCOPES, ALL_SCOPES
} from '../lib/googleauth.js';
import {
  header, extractBody, htmlToText, addresses, displayName, normaliseMessage,
  replyTokenIn, visibleReply,
  encodeHeader, buildRawMessage, buildReferences, replySubject, replyRecipients,
  createGmailClient, explainApiError, syncSince
} from '../lib/gmail.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- the credential -------------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const KEY_JSON = JSON.stringify({
  type: 'service_account', project_id: 'geekitek-platform',
  client_email: 'netinv-mail@geekitek-platform.iam.gserviceaccount.com',
  client_id: '109876543210987654321', private_key: privateKey
});

{
  const p = parseServiceAccount(KEY_JSON);
  ok(p.ok && p.key.client_email.endsWith('.iam.gserviceaccount.com'), 'a service account key parses');

  // Pasting the wrong file is THE common setup mistake, and the two files look alike in the console.
  const oauthClient = parseServiceAccount(JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com' } }));
  ok(!oauthClient.ok && /OAuth client file/i.test(oauthClient.error),
    'an OAuth client file is identified as such, rather than reported as a missing field');
  ok(/Keys/.test(oauthClient.error), 'and the message says where the right file actually is');

  ok(!parseServiceAccount('not json').ok, 'non-JSON is refused');
  ok(/entire contents/i.test(parseServiceAccount('not json').error), 'with advice a person can act on');
  ok(!parseServiceAccount(JSON.stringify({ type: 'service_account', client_email: 'a@b' })).ok, 'a key with no private_key is refused');
  ok(/newlines/i.test(parseServiceAccount(JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'xyz' })).error),
    'a PEM mangled by copy-paste is diagnosed as exactly that — the usual cause of it');
}

// ---- the assertion, checked by cryptography ----------------------------------------------------------
{
  const key = parseServiceAccount(KEY_JSON).key;
  const at = Date.parse('2026-09-20T12:00:00Z');
  const { assertion, claims } = buildAssertion({ key, subject: 'support@geekitek.com', scopes: ALL_SCOPES, now: at });
  const [h, p, s] = assertion.split('.');
  const un = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  ok(createVerify('RSA-SHA256').update(`${h}.${p}`).end().verify(publicKey, un(s)),
    'the assertion verifies against the public key — the signature is genuinely RS256 over the right input');
  ok(!createVerify('RSA-SHA256').update(`${h}.${p}X`).end().verify(publicKey, un(s)),
    'and a single altered byte fails verification');

  ok(JSON.parse(un(h)).alg === 'RS256', 'the header declares RS256, which is what Google requires');
  ok(claims.iss === key.client_email, 'iss is the service account');
  ok(claims.sub === 'support@geekitek.com', 'sub names the mailbox to impersonate — this is what delegation means');
  ok(claims.aud === 'https://oauth2.googleapis.com/token', 'aud is the token endpoint');
  ok(claims.scope.split(' ').length === 3, 'scopes are space-separated, as the spec requires');

  // A clock a second fast makes Google reject the assertion as future-dated, and the resulting
  // error looks like a broken credential.
  ok(claims.iat < Math.floor(at / 1000), 'iat is backdated slightly, so a marginally fast server clock is tolerated');
  ok(claims.exp - claims.iat <= 3600, "and the lifetime stays within Google's one-hour cap");
  ok(!/[=+/]/.test(assertion), 'the encoding is base64url with no padding');

  ok(!ALL_SCOPES.includes('https://www.googleapis.com/auth/gmail.full') &&
     ALL_SCOPES.includes(SCOPES.modify),
    'we ask for gmail.modify, never gmail.full — the platform has no business being able to permanently delete mail');
}

// ---- token caching, which is not an optimisation ------------------------------------------------------
{
  const key = parseServiceAccount(KEY_JSON).key;
  let calls = 0, clock = Date.parse('2026-09-20T12:00:00Z');
  const fakeFetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ access_token: 'tok-' + calls, expires_in: 3600 }) }; };
  const src = createTokenSource({ key, fetchImpl: fakeFetch, now: () => clock });

  await src.token('support@geekitek.com', ALL_SCOPES);
  await src.token('support@geekitek.com', ALL_SCOPES);
  ok(calls === 1, 'a second request for the same mailbox reuses the cached token rather than signing again');

  await src.token('carriers@geekitek.com', ALL_SCOPES);
  ok(calls === 2, 'a different mailbox gets its own token — they are not interchangeable');

  await src.token('support@geekitek.com', [SCOPES.read]);
  ok(calls === 3, 'and a different scope set does too');

  clock += 59 * 60 * 1000;                      // 59 minutes on
  await src.token('support@geekitek.com', ALL_SCOPES);
  ok(calls === 4, 'a token is renewed a minute BEFORE it expires, so a slow request cannot start with seconds left');

  // Invalidation gets its own source. Reusing the one above would test nothing: the clock advance
  // has already expired every token in it, so a "still cached" assertion would pass or fail for a
  // reason that has nothing to do with invalidate.
  let calls2 = 0;
  const src2 = createTokenSource({
    key, now: () => clock,
    fetchImpl: async () => { calls2++; return { ok: true, status: 200, json: async () => ({ access_token: 't' + calls2, expires_in: 3600 }) }; }
  });
  await src2.token('support@geekitek.com', ALL_SCOPES);
  await src2.token('carriers@geekitek.com', ALL_SCOPES);
  ok(calls2 === 2, 'two mailboxes, two tokens');

  src2.invalidate('support@geekitek.com');
  await src2.token('carriers@geekitek.com', ALL_SCOPES);
  ok(calls2 === 2, 'invalidating one mailbox leaves the others cached');
  await src2.token('support@geekitek.com', ALL_SCOPES);
  ok(calls2 === 3, 'while the invalidated one is re-minted');

  src2.invalidate();
  await src2.token('carriers@geekitek.com', ALL_SCOPES);
  ok(calls2 === 4, 'and invalidating with no argument clears everything — what a credential change needs');
}

// ---- Google's OAuth errors, translated ------------------------------------------------------------------
{
  ok(/Admin Console/.test(explainTokenError(400, { error: 'unauthorized_client' })),
    'unauthorized_client points at the Admin Console delegation entry, which is where the fix is');
  ok(/propagat/i.test(explainTokenError(400, { error: 'unauthorized_client' })),
    'and mentions propagation delay, which is the answer often enough to try first');
  ok(/Google Group/.test(explainTokenError(400, { error: 'invalid_grant', error_description: 'Account not found' })),
    'an unknown mailbox suggests the Google Group trap — the single most confusing failure here');
  ok(/clock/i.test(explainTokenError(400, { error: 'invalid_grant' })),
    'a bare invalid_grant points at clock skew');
  ok(/Admin Console/.test(explainTokenError(400, { error: 'invalid_scope' })),
    'and a scope problem says that adding it in code does nothing on its own');
}

// ---- reading real mail shapes ------------------------------------------------------------------------
{
  // The flat case: a plain-text message with nothing nested.
  const plain = {
    id: 'm1', threadId: 't1', internalDate: '1789905600000', labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: 'Maria Olsen <maria@example.com>' }, { name: 'Subject', value: 'Slow speeds' },
                { name: 'To', value: 'support@geekitek.com' }, { name: 'Message-ID', value: '<abc@example.com>' }],
      body: { data: b64u('The connection drops every evening around 7pm.') }
    }
  };
  const n1 = normaliseMessage(plain);
  ok(n1.text.includes('drops every evening'), 'a flat text message reads');
  ok(n1.from === 'maria@example.com' && n1.fromName === 'Maria Olsen', 'the sender splits into address and display name');
  ok(n1.unread === true && n1.outbound === false, 'labels give read state and direction');

  // THE REAL CASE. multipart/mixed → multipart/alternative → text/plain + text/html, plus a PDF.
  const nested = {
    id: 'm2', threadId: 't1', internalDate: '1789909200000', labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: '"Olsen, Maria" <maria@example.com>' },
                { name: 'To', value: 'support@geekitek.com, billing@geekitek.com' },
                { name: 'Cc', value: 'Boss <boss@example.com>' },
                { name: 'Subject', value: 'Re: Slow speeds' },
                { name: 'Message-ID', value: '<def@example.com>' },
                { name: 'In-Reply-To', value: '<abc@example.com>' },
                { name: 'References', value: '<abc@example.com>' }],
      body: { size: 0 },
      parts: [
        {
          mimeType: 'multipart/alternative',
          body: { size: 0 },
          parts: [
            { mimeType: 'text/plain', body: { data: b64u('Here is the speed test as requested.') } },
            { mimeType: 'text/html', body: { data: b64u('<div>Here is the <b>speed test</b> as requested.</div>') } }
          ]
        },
        { mimeType: 'application/pdf', filename: 'speedtest.pdf', body: { size: 88123, attachmentId: 'att-1' } }
      ]
    }
  };
  const n2 = normaliseMessage(nested);
  ok(n2.text.includes('speed test as requested'),
    'THE IMPORTANT ONE: text three levels down in a nested tree is found — reading the top-level body would return empty here');
  ok(n2.html.includes('<b>speed test</b>'), 'the HTML part is kept alongside it');
  ok(n2.attachments.length === 1 && n2.attachments[0].filename === 'speedtest.pdf',
    'the attachment is listed, with its id for later fetching');
  ok(!n2.text.includes('speedtest.pdf'), 'and attachment bytes never leak into the body text');
  ok(n2.to.length === 2 && n2.cc[0] === 'boss@example.com', 'every recipient is parsed');
  ok(n2.fromName === 'Olsen, Maria', 'a quoted display name containing a comma survives');
  ok(n2.inReplyTo === '<abc@example.com>', 'threading headers are kept');

  // HTML-only mail, which plenty of senders produce.
  const htmlOnly = {
    id: 'm3', threadId: 't2', internalDate: '1789912800000', labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'From', value: 'noreply@carrier.example' }, { name: 'Subject', value: 'Maintenance' }],
      body: { data: b64u('<html><style>p{color:red}</style><body><p>Planned work</p><script>alert(1)</script><p>2am Tuesday</p></body></html>') }
    }
  };
  const n3 = normaliseMessage(htmlOnly);
  ok(n3.text.includes('Planned work') && n3.text.includes('2am Tuesday'), 'HTML-only mail is converted to readable text');
  ok(!n3.text.includes('alert(1)') && !n3.text.includes('color:red'),
    'and script and style CONTENT is removed, not merely stripped of its tags');

  // Outbound mail lands in the mailbox too.
  ok(normaliseMessage({ id: 'm4', threadId: 't1', labelIds: ['SENT'], payload: { headers: [], body: {} } }).outbound === true,
    'a message we sent is marked outbound — otherwise every reply we send is ingested as if the customer wrote it');

  // internalDate over the Date header.
  const liar = { id: 'm5', threadId: 't3', internalDate: '1789905600000', labelIds: [],
    payload: { headers: [{ name: 'Date', value: 'Fri, 01 Jan 2100 00:00:00 +0000' }], body: {} } };
  ok(new Date(normaliseMessage(liar).date).getUTCFullYear() === 2026,
    "Gmail's internalDate is trusted over a sender's Date header, which is wrong often enough to matter");

  // Malformed input must not throw mid-sync.
  let threw = false;
  try { normaliseMessage({ id: 'x', payload: null }); normaliseMessage({}); extractBody(null); } catch { threw = true; }
  ok(!threw, 'a malformed or empty payload returns empty rather than throwing and stopping the sync');

  // Deep nesting must terminate.
  let deep = { mimeType: 'text/plain', body: { data: b64u('bottom') } };
  for (let i = 0; i < 40; i++) deep = { mimeType: 'multipart/mixed', body: {}, parts: [deep] };
  let deepThrew = false;
  try { extractBody({ payload: deep }); } catch { deepThrew = true; }
  ok(!deepThrew, 'absurdly deep nesting is bounded rather than recursing without limit');
}

// ---- address parsing ------------------------------------------------------------------------------------
{
  ok(addresses('A <a@b.com>, "C, D" <c@d.co.uk>').join() === 'a@b.com,c@d.co.uk', 'multiple addresses parse');
  ok(addresses('Support@GeekiTek.com')[0] === 'support@geekitek.com', 'and are lowercased, so matching works');
  ok(addresses('nothing here').length === 0, 'a header with no address yields none');
  ok(addresses(null).length === 0 && addresses('').length === 0, 'and null is safe');
  ok(addresses('a@b.com, a@b.com').length === 1, 'duplicates collapse');
  ok(addresses('Support <support+e277a597d044c4e2f9f546fc3d746900@geekfiwifi.com>')[0]
      === 'support+e277a597d044c4e2f9f546fc3d746900@geekfiwifi.com',
    'a plus-addressed reply token survives — that is how a reply is matched back to the customer');
  ok(displayName('<a@b.com>') === null, 'an address with no display name gives null, not an empty string');
}

// ---- composing a reply that threads ------------------------------------------------------------------------
{
  const raw = buildRawMessage({
    from: 'support@geekitek.com', fromName: 'GeekiTek Support',
    to: ['maria@example.com'], cc: ['boss@example.com'],
    subject: 'Re: Slow speeds', text: 'We have raised this with the carrier.',
    inReplyTo: '<def@example.com>', references: '<abc@example.com>'
  });

  ok(/^From: GeekiTek Support <support@geekitek\.com>/m.test(raw), 'the From header carries the display name');
  ok(/^To: maria@example\.com/m.test(raw) && /^Cc: boss@example\.com/m.test(raw), 'recipients are set');
  ok(/^In-Reply-To: <def@example\.com>/m.test(raw),
    'THE OTHER IMPORTANT ONE: In-Reply-To is present — without it the customer sees an unrelated message, however well it threads for us');
  ok(/^References: <abc@example\.com> <def@example\.com>/m.test(raw),
    'and References carries the ancestry in order');
  ok(raw.includes('\r\n'), 'lines end CRLF, as RFC 5322 requires');
  ok(/Content-Transfer-Encoding: base64/.test(raw),
    'the body is base64 — an 8-bit body with a line over 998 characters, which a pasted log easily exceeds, is illegal in SMTP');

  const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '');
  ok(Buffer.from(body, 'base64').toString('utf8').includes('raised this with the carrier'), 'and it decodes back to the text');

  // No line anywhere may exceed the limit.
  const longLine = buildRawMessage({ from: 'a@b.com', to: ['c@d.com'], subject: 'x', text: 'y'.repeat(5000) });
  ok(longLine.split('\r\n').every(l => l.length <= 998), 'even a 5000-character paragraph produces no over-long line');

  // Non-ASCII in a subject.
  const accented = buildRawMessage({ from: 'a@b.com', to: ['c@d.com'], subject: 'Café outage — Zürich', text: 'x' });
  ok(/^Subject: =\?UTF-8\?B\?/m.test(accented), 'a non-ASCII subject is RFC 2047 encoded rather than sent raw');
  ok(Buffer.from(accented.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)[1], 'base64').toString('utf8') === 'Café outage — Zürich',
    'and decodes back exactly');
  ok(encodeHeader('plain ascii') === 'plain ascii', 'while plain ASCII is left alone and stays readable in logs');
  ok(!encodeHeader('a\r\nBcc: attacker@evil.com').includes('\n'),
    'and a newline in a header value is neutralised — header injection is how a Bcc gets added to your mail');

  // HTML alternative.
  const alt = buildRawMessage({ from: 'a@b.com', to: ['c@d.com'], subject: 's', text: 'plain', html: '<b>rich</b>' });
  ok(/multipart\/alternative; boundary="/.test(alt) && (alt.match(/Content-Type: text\//g) || []).length === 2,
    'an HTML message carries both a plain and an HTML part');

  let noRecipient = false;
  try { buildRawMessage({ from: 'a@b.com', to: [], subject: 's', text: 't' }); } catch { noRecipient = true; }
  ok(noRecipient, 'a message with no recipient is refused rather than sent into the void');
}

// ---- reply mechanics --------------------------------------------------------------------------------------
{
  ok(replySubject('Slow speeds') === 'Re: Slow speeds', 'a reply gets one Re:');
  ok(replySubject('Re: Slow speeds') === 'Re: Slow speeds', 'and an existing one is not doubled');
  ok(replySubject('Re: Re: RE: Slow speeds') === 'Re: Slow speeds', 'however many the other client piled on');

  const msg = { from: 'maria@example.com', replyTo: null, to: ['support@geekitek.com'], cc: ['boss@example.com', 'billing@geekitek.com'] };
  const r = replyRecipients(msg, ['support@geekitek.com', 'billing@geekitek.com']);
  ok(r.to.join() === 'maria@example.com', 'a reply goes to the sender');
  ok(r.cc.join() === 'boss@example.com',
    'and our own addresses are dropped from Cc, so the reply does not loop back into the mailbox it came from');

  const withReplyTo = { from: 'noreply@carrier.example', replyTo: 'tickets@carrier.example', to: [], cc: [] };
  ok(replyRecipients(withReplyTo, []).to[0] === 'tickets@carrier.example',
    'Reply-To wins over From — which is what a carrier ticketing system depends on');

  ok(buildReferences('<a>', '<b>') === '<a> <b>', 'References appends');
  ok(buildReferences('<a> <b>', '<b>') === '<a> <b>', 'and does not duplicate');
  const long = buildReferences(Array.from({ length: 30 }, (_, i) => `<m${i}>`).join(' '), '<new>');
  ok(long.split(' ').length === 11 && long.startsWith('<m0>') && long.endsWith('<new>'),
    'a long chain is trimmed from the middle, keeping the thread root and the recent ancestry');
}

// ---- incremental sync ----------------------------------------------------------------------------------------
{
  const client = {
    history: async (start, page) => {
      if (page === 'p2') return { history: [{ messagesAdded: [{ message: { id: 'm3' } }] }], historyId: '9100' };
      return { history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }], nextPageToken: 'p2', historyId: '9050' };
    }
  };
  const r = await syncSince(client, '9000');
  ok(!r.full && r.messageIds.length === 3, 'incremental sync collects new messages across pages');
  ok(r.historyId === '9100', 'and records the newest history point to resume from');

  ok((await syncSince(client, null)).full === true, 'with no previous point it asks for a full pass');

  // The one that matters operationally: Google expires history after about a week.
  const aged = { history: async () => { const e = new Error('Not Found'); e.status = 404; throw e; } };
  const r2 = await syncSince(aged, '1');
  ok(r2.full === true && /aged out/.test(r2.reason),
    'an expired history point asks for a full resync instead of erroring — otherwise a mailbox offline for a fortnight is stuck forever');

  const broken = { history: async () => { const e = new Error('boom'); e.status = 500; throw e; } };
  let propagated = false;
  try { await syncSince(broken, '1'); } catch { propagated = true; }
  ok(propagated, 'while a real failure still propagates rather than being mistaken for an aged-out cursor');
}

// ---- the client's transport behaviour ---------------------------------------------------------------------------
{
  let tokens = 0, calls = [];
  const tokenSource = { token: async () => `tok-${++tokens}`, invalidate: () => {} };
  let failNext401 = true;
  const fakeFetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    if (failNext401) { failNext401 = false; return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) }; }
    return { ok: true, status: 200, json: async () => ({ emailAddress: 'support@geekitek.com', messagesTotal: 42 }) };
  };
  const c = createGmailClient({ tokenSource, mailbox: 'support@geekitek.com', scopes: ALL_SCOPES, fetchImpl: fakeFetch });
  const prof = await c.profile();
  ok(prof.messagesTotal === 42, 'a 401 mid-flight is retried once with a fresh token and then succeeds');
  ok(calls.length === 2 && calls[0].auth !== calls[1].auth, 'and the retry genuinely uses a different token');

  const always401 = createGmailClient({
    tokenSource, mailbox: 'x@y.com', scopes: ALL_SCOPES,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) })
  });
  let gaveUp = false;
  try { await always401.profile(); } catch { gaveUp = true; }
  ok(gaveUp, 'but a persistent 401 gives up rather than looping — a real authorisation failure should not look like a hang');

  ok(/mailbox address may be wrong|not found/i.test(explainApiError(404, { error: { message: 'Not Found' } }, 'a@b.com')), '404 is explained');
  ok(/Google Group/.test(explainApiError(400, { error: { message: 'failedPrecondition' } }, 'support@geekitek.com')),
    'and a failed precondition names the Google Group trap, which is what it almost always is');
  ok(/rate-limiting/.test(explainApiError(429, {}, 'a@b.com')), 'rate limiting is described as temporary, because it is');
}

// ---- filing a reply, and not the rest of the inbox ------------------------------------------------
{
  const token = 'e277a597d044c4e2f9f546fc3d746900';
  const reply = normaliseMessage({
    id: 'm9', threadId: 't9', labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Jon Fernandez <jon@geekfiwifi.com>' },
        { name: 'To', value: `support+${token}@geekfiwifi.com` },
        { name: 'Subject', value: 'Re: [Jon & Angela Solorio-Fernandez] test-3' }
      ],
      body: { data: b64u('test I got it lets hope it shows up in the system\n\nOn Mon, Sep 21, 2026 at 1:21 PM support@geekfiwifi.com wrote:\n> testing 3\n> Reply to this email to continue the conversation.\n') }
    }
  });
  ok(replyTokenIn(reply), 'a reply to our plus-address is recognised as a customer reply');
  ok(visibleReply(reply.text) === 'test I got it lets hope it shows up in the system',
    'the quoted original is dropped, so the timeline shows what the customer wrote');
  ok(reply.routedTo.includes(`support+${token}@geekfiwifi.com`), 'the token address is kept for matching');

  const deliveredOnly = normaliseMessage({
    id: 'm10', threadId: 't10', labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'jon@geekfiwifi.com' },
        { name: 'To', value: 'support@geekfiwifi.com' },
        { name: 'Delivered-To', value: `support+${token}@geekfiwifi.com` },
        { name: 'Subject', value: 'Re: test-3' }
      ],
      body: { data: b64u('still here') }
    }
  });
  ok(replyTokenIn(deliveredOnly), 'the token still counts when Gmail left it only on Delivered-To');

  const newsletter = normaliseMessage({
    id: 'm11', threadId: 't11', labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'news@vendor.example' },
        { name: 'To', value: 'support@geekfiwifi.com' },
        { name: 'Subject', value: 'September newsletter' }
      ],
      body: { data: b64u('Hello') }
    }
  });
  ok(!replyTokenIn(newsletter), 'ordinary inbox mail is not treated as a reply');
  ok(replyTokenIn({ subject: 'Re: [TKT-1001] outage', to: [], cc: [], routedTo: [] }),
    'a ticket number in the subject is enough when the plus-address was stripped');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
