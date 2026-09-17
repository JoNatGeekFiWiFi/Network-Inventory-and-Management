// WhatsApp straight from Meta — no BSP in the middle.
//
// The platform already sends WhatsApp through Twilio or Telnyx. This adds Meta's Cloud API as a
// third provider, which matters for two reasons:
//
//   * COST. Meta charges for messages; a BSP charges Meta's price plus a markup, typically
//     $0.003–$0.010 per message. On a support channel that is most of the bill.
//   * CONTROL. The WhatsApp Business Account, the number and the templates belong to GeekiTek
//     rather than sitting inside somebody else's account — which, after the GL.iNet cloud, is a
//     distinction worth caring about.
//
// What you take on in exchange is the part a BSP was doing for you: the webhook handshake, the
// signature checking, and token rotation. That is what this file is.
//
// TWO DIFFERENT SECRETS, and confusing them is the classic setup failure:
//
//   verify token — a string you invent. Meta echoes it back ONCE, in a GET, when you first
//                  register the webhook. It proves the URL is yours. Never used again.
//   app secret   — signs EVERY POST, as HMAC-SHA256 over the raw body. It proves each delivery
//                  actually came from Meta.
//
// Only the second one protects you at runtime, and a webhook that checks the first and not the
// second is an open endpoint that anybody can post tickets into.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Graph API version. Pinned deliberately: Meta ships breaking changes between versions. */
export const GRAPH_VERSION = 'v21.0';

/**
 * Verify the `X-Hub-Signature-256` header against the RAW request body.
 *
 * The raw bytes matter. Re-serialising parsed JSON changes key order and whitespace, so the hash
 * computed over `JSON.stringify(req.body)` will not match and the endpoint would appear broken —
 * or, if someone then "fixed" it by skipping the check, be wide open.
 *
 * Compared with timingSafeEqual rather than `===`, for the same reason the Stripe webhook here
 * already does: a string comparison leaks how much of the signature was correct.
 */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret) return { ok: false, reason: 'No app secret configured — every delivery would be unverified' };
  const sig = String(header || '');
  if (!sig.startsWith('sha256=')) return { ok: false, reason: 'Missing or malformed X-Hub-Signature-256 header' };

  const expected = createHmac('sha256', appSecret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8'))
    .digest('hex');
  const given = sig.slice('sha256='.length);
  if (given.length !== expected.length) return { ok: false, reason: 'Signature length mismatch' };
  try {
    const okSig = timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
    return okSig ? { ok: true } : { ok: false, reason: 'Signature did not match — this delivery was not signed by Meta' };
  } catch { return { ok: false, reason: 'Signature was not valid hex' }; }
}

/**
 * The one-time GET handshake.
 *
 * Meta sends hub.mode=subscribe with the verify token, and expects the RAW hub.challenge back as
 * the body — not JSON, not quoted. Returning `{"challenge": "..."}` is the most common way to fail
 * this, because it looks correct and is rejected without explanation.
 */
export function verifyChallenge(query, verifyToken) {
  const mode = query['hub.mode'], token = query['hub.verify_token'], challenge = query['hub.challenge'];
  if (mode !== 'subscribe') return { ok: false, status: 400, reason: 'Not a subscribe request' };
  if (!verifyToken) return { ok: false, status: 500, reason: 'No verify token is configured on this server yet' };
  if (token !== verifyToken) return { ok: false, status: 403, reason: 'Verify token did not match' };
  return { ok: true, challenge: String(challenge ?? '') };
}

/**
 * Turn a Cloud API webhook payload into messages and delivery statuses.
 *
 * The shape is deeply nested — entry[].changes[].value.messages[] — and every level is optional,
 * so nothing here indexes without checking. A payload can also carry statuses and no messages at
 * all, which is the normal case for delivery receipts.
 */
export function parseMetaWebhook(payload) {
  let p = payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return { messages: [], statuses: [], error: 'not JSON' }; } }
  if (Buffer.isBuffer(p)) { try { p = JSON.parse(p.toString('utf8')); } catch { return { messages: [], statuses: [], error: 'not JSON' }; } }
  if (!p || typeof p !== 'object') return { messages: [], statuses: [], error: 'empty' };

  const messages = [], statuses = [];
  for (const entry of p.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const to = (v.metadata && v.metadata.display_phone_number) || null;
      // The sender's profile name, when WhatsApp supplies it. Useful for matching an unknown
      // number to a person without asking them who they are.
      const names = {};
      for (const c of v.contacts || []) if (c.wa_id) names[c.wa_id] = (c.profile && c.profile.name) || null;

      for (const m of v.messages || []) {
        messages.push({
          external_id: m.id || null,
          from: m.from ? '+' + String(m.from).replace(/^\+/, '') : null,
          to,
          name: names[m.from] || null,
          type: m.type || 'text',
          body: messageText(m),
          ts: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null
        });
      }
      for (const s of v.statuses || []) {
        statuses.push({
          external_id: s.id || null,
          status: s.status || null,                    // sent | delivered | read | failed
          recipient: s.recipient_id ? '+' + s.recipient_id : null,
          ts: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : null,
          error: (s.errors && s.errors[0] && (s.errors[0].title || s.errors[0].message)) || null
        });
      }
    }
  }
  return { messages, statuses };
}

/**
 * Readable text for any message type.
 *
 * Customers send photos of their router, voice notes and their location, not just text. Dropping
 * those silently would lose a real support message; recording a placeholder keeps the thread
 * honest and tells whoever reads the ticket to go and look at WhatsApp.
 */
export function messageText(m = {}) {
  switch (m.type) {
    case 'text': return (m.text && m.text.body) || '';
    case 'button': return (m.button && m.button.text) || '[button]';
    case 'interactive': {
      const i = m.interactive || {};
      return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '[interactive reply]';
    }
    case 'image': return '[photo]' + captionOf(m.image);
    case 'video': return '[video]' + captionOf(m.video);
    case 'audio': return '[voice message]';
    case 'document': return `[document${m.document && m.document.filename ? ': ' + m.document.filename : ''}]`;
    case 'sticker': return '[sticker]';
    case 'location': {
      const l = m.location || {};
      return `[location${l.latitude != null ? ` ${l.latitude},${l.longitude}` : ''}${l.name ? ' — ' + l.name : ''}]`;
    }
    case 'contacts': return '[contact card]';
    case 'reaction': return `[reacted ${(m.reaction && m.reaction.emoji) || ''}]`.trim();
    case 'unsupported': return '[message type WhatsApp could not deliver]';
    default: return `[${m.type || 'unknown'} message]`;
  }
}
const captionOf = (o) => (o && o.caption ? ' ' + o.caption : '');

/** Build the outbound request. Pure, so the shape is testable without calling Meta. */
export function sendRequest({ phoneNumberId, token, to, body }) {
  if (!phoneNumberId || !token) return { error: 'WhatsApp (Meta) is not configured — phone number ID and token are required' };
  const num = String(to || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!/^\d{6,15}$/.test(num)) return { error: `"${to}" is not a usable WhatsApp number` };
  if (!String(body || '').trim()) return { error: 'Nothing to send' };
  return {
    url: `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: num, type: 'text', text: { preview_url: false, body: String(body) } }
  };
}

/**
 * Turn a Graph API error into something a support agent can act on.
 *
 * 131047 is the one that will actually happen: it is the 24-hour window closing. A generic "send
 * failed" there teaches staff that WhatsApp is unreliable, when the real answer is that the
 * customer has not messaged in a day and the reply needs an approved template.
 */
export function explainSendError(j, httpStatus) {
  const e = (j && j.error) || {};
  const code = e.code, sub = e.error_subcode;
  if (code === 131047 || sub === 131047) {
    return 'This customer has not messaged in over 24 hours, so WhatsApp will not accept a free-form reply. It needs a pre-approved template.';
  }
  if (code === 131026) return 'That number is not reachable on WhatsApp.';
  if (code === 131051) return 'WhatsApp does not support that message type here.';
  if (code === 190) return 'The Meta access token has expired or been revoked — generate a new permanent token.';
  if (code === 100) return `Meta rejected the request: ${e.message || 'invalid parameter'}`;
  if (code === 133010) return 'That WhatsApp number is not registered on the Cloud API yet.';
  if (code === 80007 || code === 130429) return 'Rate limited by WhatsApp — try again shortly.';
  return e.message ? `WhatsApp: ${e.message}` : `WhatsApp send failed (HTTP ${httpStatus})`;
}

/**
 * How long is left in the 24-hour service window for a customer?
 *
 * WhatsApp allows free-form replies only within 24 hours of the customer's last inbound message.
 * Outside it you must use an approved template. Knowing this BEFORE composing a reply is the
 * difference between a channel staff trust and one they learn to work around.
 */
export function serviceWindow(lastInboundIso, now = Date.now()) {
  if (!lastInboundIso) return { open: false, msRemaining: 0, reason: 'This customer has never messaged on WhatsApp' };
  const elapsed = now - Date.parse(lastInboundIso);
  if (!Number.isFinite(elapsed)) return { open: false, msRemaining: 0, reason: 'No valid last-message time' };
  const remaining = 24 * 3600 * 1000 - elapsed;
  if (remaining <= 0) {
    return { open: false, msRemaining: 0, reason: 'The 24-hour window has closed — a reply needs an approved template' };
  }
  const hours = Math.floor(remaining / 3600000), mins = Math.floor((remaining % 3600000) / 60000);
  return { open: true, msRemaining: remaining, expiresIn: hours ? `${hours}h ${mins}m` : `${mins}m` };
}
