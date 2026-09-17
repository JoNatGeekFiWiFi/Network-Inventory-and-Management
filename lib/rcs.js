// RCS: a branded, verified upgrade to the SMS channel.
//
// THE DESIGN DECISION, AND IT IS THE WHOLE FILE: RCS IS NOT A FOURTH CHANNEL.
//
// The obvious implementation is to add 'rcs' beside sms, email and whatsapp, give staff a fourth
// option in the reply picker, and let them choose. That would be wrong for three reasons:
//
//   1. NOBODY CAN CHOOSE CORRECTLY. Whether a message goes as RCS or SMS depends on the recipient's
//      handset, carrier and settings at that moment. Twilio decides at send time and falls back on
//      its own. A person picking "RCS" from a menu is expressing a hope, not an instruction.
//   2. THE CUSTOMER SEES ONE THREAD. On an iPhone or an Android, RCS and SMS from the same sender
//      land in the same conversation. Splitting them in our ticket would model something the
//      customer does not experience.
//   3. A FAILED RCS IS NOT A FAILED MESSAGE. It is an SMS. Treating the channels as peers would
//      show a delivery failure where the customer got the text fine.
//
// So the channel stays `sms`, and which transport actually carried it is RECORDED rather than
// chosen — `delivery_transport` on the message. Staff pick "SMS"; the customer gets the best thing
// their phone supports; the ticket says which it was.
//
// Mechanically this is small, because Twilio does the work: send to a Messaging Service that has an
// RCS sender attached, and it selects RCS or SMS per recipient. The platform's job is to point at
// the right service, name the fallback sender, and be honest afterwards about what happened.

/**
 * Build the outbound send parameters.
 *
 * Twilio's rule: addressing a Messaging Service SID (rather than a plain From number) is what
 * enables RCS. `FallbackFrom` names the number to use when RCS cannot be delivered — without it,
 * Twilio falls back to whatever single sender is in the service's pool, which is fine but implicit.
 * Naming it explicitly means the fallback is a decision rather than a side effect of pool contents.
 */
export function buildSendParams({ to, body, messagingServiceSid, fromNumber, fallbackFrom }) {
  const num = normaliseNumber(to);
  if (!num) return { error: `"${to}" is not a usable phone number` };
  if (!String(body || '').trim()) return { error: 'Nothing to send' };

  const params = { To: num, Body: String(body) };

  if (messagingServiceSid) {
    params.MessagingServiceSid = messagingServiceSid;
    // Only meaningful alongside a Messaging Service — Twilio rejects it otherwise.
    const fb = normaliseNumber(fallbackFrom);
    if (fb) params.FallbackFrom = fb;
    return { params, transport: 'rcs-or-sms' };
  }

  const from = normaliseNumber(fromNumber);
  if (!from) return { error: 'No SMS sender number or Messaging Service configured' };
  params.From = from;
  return { params, transport: 'sms' };
}

/** E.164-ish. Deliberately permissive about punctuation, strict about the result. */
export function normaliseNumber(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, '');
  if (/^\+\d{7,15}$/.test(digits)) return digits;
  // A bare 10-digit number is a US number typed the way people type them.
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^1\d{10}$/.test(digits)) return '+' + digits;
  return null;
}

/**
 * Which transport actually carried a message Twilio accepted?
 *
 * Read from the response rather than assumed, because the whole point is that Twilio decides. When
 * it does not say, the honest answer is null — "we asked for the better one and do not yet know
 * which arrived" — rather than claiming RCS because we requested it.
 */
export function transportFromResponse(j = {}) {
  // Twilio reports the channel on the message resource once it resolves.
  const raw = String(j.messaging_service_sid && (j.channel || j.messagingChannel) || j.channel || '').toLowerCase();
  if (raw.includes('rcs')) return 'rcs';
  if (raw.includes('sms') || raw.includes('mms')) return 'sms';
  // A status callback later carries the resolved channel; at send time it is often still pending.
  return null;
}

/**
 * Did an inbound message arrive over RCS?
 *
 * Twilio delivers RCS replies to the same webhook as SMS. When nothing in the payload says which
 * it was, the answer is 'sms' — not because we know, but because that is the safe display: calling
 * a plain text "RCS" would be a claim about the customer's phone that we cannot support.
 */
export function inboundTransport(body = {}) {
  const channel = String(body.ChannelMetadata || body.Channel || '').toLowerCase();
  if (channel.includes('rcs')) return 'rcs';
  // An RCS-capable Messaging Service is a hint, never proof: the same service carries SMS too.
  return 'sms';
}

/**
 * Turn a Twilio messaging error into something a support agent can act on.
 *
 * The RCS-specific ones matter during onboarding, when the sender is registered but not yet
 * approved by the carriers — a period measured in weeks, during which "send failed" would look
 * like a broken integration rather than a queue somebody is waiting in.
 */
export function explainTwilioError(code, message) {
  const c = Number(code);
  if (c === 21211) return 'That is not a valid phone number.';
  if (c === 21610) return 'This customer has opted out of messages from this number (replied STOP).';
  if (c === 21612) return 'This number cannot be reached from the configured sender.';
  if (c === 21408) return 'This account is not permitted to send to that region.';
  if (c === 30007) return 'The carrier filtered this message as spam.';
  if (c === 30032) return 'The sender is not yet approved to send — RCS carrier approval is still pending.';
  if (c === 63024) return 'The Messaging Service is not configured for RCS yet.';
  if (c === 21703 || c === 21704) return 'The Messaging Service has no sender in its pool — add a number, or set a fallback sender.';
  return message ? `Twilio: ${message}` : `Send failed (Twilio ${code || 'unknown error'})`;
}

/**
 * Describe the configuration, for the settings page.
 *
 * Says what will ACTUALLY happen with the current settings, rather than whether fields are filled
 * in. During an 8-to-16-week carrier approval, "configured but not yet approved" is the normal
 * state and needs to read as progress rather than as breakage.
 */
export function describeSetup({ messagingServiceSid, fromNumber, fallbackFrom }) {
  if (!messagingServiceSid && !fromNumber) {
    return { level: 'none', text: 'No SMS sender configured — texts cannot be sent.' };
  }
  if (!messagingServiceSid) {
    return {
      level: 'sms',
      text: `Sending plain SMS from ${fromNumber}. To get branded, verified messages on iPhone and Android, ` +
            `create a Twilio Messaging Service with an RCS sender and put its SID here.`
    };
  }
  const fb = fallbackFrom || fromNumber;
  return {
    level: 'rcs',
    text: `Sending through Messaging Service ${messagingServiceSid}. Twilio will use RCS where the ` +
          `recipient supports it and fall back to SMS${fb ? ` from ${fb}` : ' automatically'} where they do not. ` +
          `Until carrier approval completes, everything falls back to SMS — which is working, not broken.`
  };
}
