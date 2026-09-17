// WhatsApp direct from Meta, with no BSP in between.
//
// The hardest treatment goes to the webhook, because it is a PUBLIC endpoint that writes into
// customer support tickets. Everything else here is a parsing convenience; the signature check is
// the only thing standing between the open internet and somebody injecting messages into a
// customer's conversation history.
import {
  verifyMetaSignature, verifyChallenge, parseMetaWebhook, messageText,
  sendRequest, explainSendError, serviceWindow, GRAPH_VERSION
} from '../lib/metawa.js';
import { createHmac } from 'node:crypto';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const SECRET = 'app-secret-value';
const sign = (body, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

// ---- signature verification: the only runtime protection this endpoint has -----------------------
{
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

  ok(verifyMetaSignature(body, sign(body), SECRET).ok, 'a correctly signed delivery is accepted');

  // Every one of these is somebody posting to a public URL.
  ok(!verifyMetaSignature(body, sign(body, 'wrong-secret'), SECRET).ok, 'a signature from the wrong secret is refused');
  ok(!verifyMetaSignature(body, undefined, SECRET).ok, 'an unsigned delivery is refused');
  ok(!verifyMetaSignature(body, 'sha1=abcdef', SECRET).ok, 'sha1 is not accepted in place of sha256');
  ok(!verifyMetaSignature(body, 'sha256=' + 'f'.repeat(64), SECRET).ok, 'a plausible-looking wrong signature is refused');
  ok(!verifyMetaSignature(body, 'sha256=nothex!!', SECRET).ok, 'a non-hex signature is refused rather than throwing');
  ok(!verifyMetaSignature(body, sign(body), '').ok, 'and with NO app secret configured, nothing is accepted');
  ok(/app secret/.test(verifyMetaSignature(body, sign(body), '').reason),
    '  ...saying why, because an unconfigured secret silently accepting everything is the worst outcome');

  // THE RAW-BYTES RULE. Meta signs the exact bytes it sent. Re-serialising parsed JSON reorders
  // keys and changes whitespace, so a hash over JSON.stringify(req.body) never matches — and the
  // tempting "fix" is to skip the check, which opens the endpoint.
  //
  // Note the example: key ORDER survives a round trip for string keys, so `{"b":1,"a":2}` would
  // prove nothing. Whitespace is what actually differs, and real webhook bodies carry it.
  const original = Buffer.from('{ "messaging_product" : "whatsapp" }');
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString())));
  ok(original.toString() !== reserialised.toString(), 'round-tripping JSON really does change the bytes');
  ok(verifyMetaSignature(original, sign(original), SECRET).ok, 'the raw body verifies');
  ok(!verifyMetaSignature(reserialised, sign(original), SECRET).ok,
    'and the re-serialised one does not — which is why the route must take the raw body');

  // A single flipped byte must fail.
  const tampered = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ evil: true }] }));
  ok(!verifyMetaSignature(tampered, sign(body), SECRET).ok, 'a modified payload fails its original signature');
}

// ---- the one-time GET handshake -----------------------------------------------------------------
{
  const q = (o) => ({ 'hub.mode': 'subscribe', 'hub.verify_token': 'my-token', 'hub.challenge': '12345', ...o });

  const good = verifyChallenge(q(), 'my-token');
  ok(good.ok && good.challenge === '12345', 'a matching verify token returns the challenge');
  // The classic setup failure: replying with JSON. Meta wants the raw value, so the challenge is
  // returned as a bare string for the route to send as text.
  ok(typeof good.challenge === 'string', 'as a raw string, not wrapped in an object');

  ok(!verifyChallenge(q({ 'hub.verify_token': 'guessed' }), 'my-token').ok, 'a wrong verify token is refused');
  ok(verifyChallenge(q({ 'hub.verify_token': 'guessed' }), 'my-token').status === 403, 'with a 403');
  ok(!verifyChallenge(q({ 'hub.mode': 'unsubscribe' }), 'my-token').ok, 'a non-subscribe request is refused');
  ok(verifyChallenge(q(), '').status === 500, 'and an unconfigured server says so rather than accepting anything');
  ok(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'my-token' }, 'my-token').challenge === '',
    'a missing challenge yields an empty string rather than "undefined"');
}

// ---- parsing what Meta actually sends ------------------------------------------------------------
{
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15551230000', phone_number_id: 'PNID1' },
          contacts: [{ profile: { name: 'Maria Pino' }, wa_id: '15559876543' }],
          messages: [{ from: '15559876543', id: 'wamid.ABC', timestamp: '1789600000', type: 'text', text: { body: 'my internet is down' } }]
        }
      }]
    }]
  };
  const r = parseMetaWebhook(payload);
  ok(r.messages.length === 1, 'a text message is found through the nesting');
  const m = r.messages[0];
  ok(m.body === 'my internet is down', 'with its text');
  ok(m.from === '+15559876543', 'and the sender normalised to +E.164, which is how customers are matched');
  ok(m.name === 'Maria Pino', 'plus the WhatsApp profile name — useful for an unrecognised number');
  ok(m.external_id === 'wamid.ABC', 'and the message id, which is what de-duplicates retries');
  ok(m.ts.startsWith('20'), 'with the timestamp converted from unix seconds');

  // Delivery receipts arrive through the same webhook with no messages at all.
  const statusOnly = parseMetaWebhook({ entry: [{ changes: [{ value: {
    statuses: [{ id: 'wamid.X', status: 'failed', recipient_id: '15559876543', timestamp: '1789600000',
                 errors: [{ title: 'Message undeliverable' }] }] } }] }] });
  ok(statusOnly.messages.length === 0 && statusOnly.statuses.length === 1, 'a status-only delivery parses');
  ok(statusOnly.statuses[0].status === 'failed' && /undeliverable/.test(statusOnly.statuses[0].error),
    'with the failure reason, which is the only status worth surfacing');

  // Nothing here may throw on a shape it has not seen. This endpoint is public.
  ok(parseMetaWebhook({}).messages.length === 0, 'an empty payload is empty, not an error');
  ok(parseMetaWebhook(null).messages.length === 0, 'and so is null');
  ok(parseMetaWebhook('not json').error === 'not JSON', 'a non-JSON body is reported rather than thrown');
  ok(parseMetaWebhook({ entry: [{}] }).messages.length === 0, 'an entry with no changes does not throw');
  ok(parseMetaWebhook({ entry: [{ changes: [{ value: {} }] }] }).messages.length === 0, 'nor a change with no value');
  ok(parseMetaWebhook(Buffer.from(JSON.stringify(payload))).messages.length === 1, 'a Buffer body parses too');
}

// ---- customers do not only send text --------------------------------------------------------------
//
// They send photos of the router's lights, voice notes, and their location. Dropping those silently
// would lose a real support message; a placeholder keeps the ticket honest.
{
  ok(messageText({ type: 'text', text: { body: 'hello' } }) === 'hello', 'text');
  ok(messageText({ type: 'image', image: { caption: 'no lights' } }) === '[photo] no lights', 'a photo keeps its caption');
  ok(messageText({ type: 'image', image: {} }) === '[photo]', 'and survives having none');
  ok(messageText({ type: 'audio' }) === '[voice message]', 'a voice note is recorded as one');
  ok(/router\.pdf/.test(messageText({ type: 'document', document: { filename: 'router.pdf' } })), 'a document names the file');
  ok(/33\.4,-112/.test(messageText({ type: 'location', location: { latitude: 33.4, longitude: -112 } })), 'a location keeps its coordinates');
  ok(messageText({ type: 'reaction', reaction: { emoji: '👍' } }) === '[reacted 👍]', 'a reaction is readable');
  ok(messageText({ type: 'something-new' }) === '[something-new message]', 'and a type nobody has seen yet still produces text');
  ok(messageText({}) === '[unknown message]', 'as does one with no type at all');
}

// ---- the outbound request ------------------------------------------------------------------------
{
  const r = sendRequest({ phoneNumberId: 'PNID1', token: 'tok', to: '+1 (555) 987-6543', body: 'on our way' });
  ok(r.url === `https://graph.facebook.com/${GRAPH_VERSION}/PNID1/messages`, 'the Graph URL is built with a pinned version');
  ok(r.body.to === '15559876543', 'and the number stripped to digits, which is what Meta wants');
  ok(r.headers.Authorization === 'Bearer tok', 'with a bearer token');
  ok(r.body.messaging_product === 'whatsapp' && r.body.text.body === 'on our way', 'and the documented envelope');
  ok(r.body.text.preview_url === false, 'link previews off — a support reply should not fetch customer URLs');

  ok(sendRequest({ token: 't', to: '+15551234567', body: 'x' }).error, 'an unconfigured phone number ID is refused');
  ok(sendRequest({ phoneNumberId: 'P', token: 't', to: 'not-a-number', body: 'x' }).error, 'so is a bad number');
  ok(sendRequest({ phoneNumberId: 'P', token: 't', to: '+15551234567', body: '   ' }).error, 'and an empty message');
}

// ---- errors a support agent has to act on ---------------------------------------------------------
{
  // THE ONE THAT WILL HAPPEN. Surfacing this as "send failed" teaches staff the channel is
  // unreliable, when the real answer is that the window closed and a template is needed.
  const closed = explainSendError({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
  ok(/24 hours/.test(closed) && /template/.test(closed), 'a closed 24-hour window explains itself and names the fix');

  ok(/expired|revoked/.test(explainSendError({ error: { code: 190 } }, 401)), 'an expired token says so');
  ok(/not reachable on WhatsApp/.test(explainSendError({ error: { code: 131026 } }, 400)), 'an unreachable number says so');
  ok(/Rate limited/.test(explainSendError({ error: { code: 80007 } }, 429)), 'rate limiting is named');
  ok(explainSendError({}, 500).includes('500'), 'and an unrecognised failure still reports something');
}

// ---- the 24-hour service window --------------------------------------------------------------------
{
  const now = Date.parse('2026-09-17T12:00:00Z');
  const open = serviceWindow('2026-09-17T02:00:00Z', now);
  ok(open.open === true, 'ten hours after the customer wrote, the window is open');
  ok(/13h|14h/.test(open.expiresIn), 'and says roughly how long is left');

  const closed = serviceWindow('2026-09-16T02:00:00Z', now);
  ok(closed.open === false, 'thirty-four hours later it is closed');
  ok(/template/.test(closed.reason), 'and names what a reply now requires');

  // The boundary, and it must not be off by an hour in the wrong direction.
  ok(serviceWindow(new Date(now - 23.9 * 3600e3).toISOString(), now).open === true, 'just inside 24h is open');
  ok(serviceWindow(new Date(now - 24.1 * 3600e3).toISOString(), now).open === false, 'just outside is closed');

  ok(serviceWindow(null, now).open === false, 'a customer who has never written has no window');
  ok(/never messaged/.test(serviceWindow(null, now).reason), 'stated plainly rather than as an error');
  ok(serviceWindow('not a date', now).open === false, 'and an unparseable timestamp is closed, not open');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
