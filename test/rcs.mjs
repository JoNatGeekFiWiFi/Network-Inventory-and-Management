// RCS as a transport upgrade of the SMS channel, not a channel of its own.
//
// Most of what is tested here is that decision holding. The tempting design — 'rcs' as a fourth
// option beside sms, email and whatsapp — fails in three ways that only show up in use:
//
//   * nobody can choose correctly, because whether RCS is used depends on the recipient's handset
//     and carrier at that moment, and Twilio decides at send time;
//   * the customer sees ONE thread on their phone either way, so splitting ours models something
//     they do not experience;
//   * a failed RCS is not a failed message — it is an SMS, and showing a delivery failure there
//     would be wrong.
//
// So the channel stays `sms` and the transport is RECORDED. These tests pin that.
import {
  buildSendParams, normaliseNumber, transportFromResponse, inboundTransport,
  explainTwilioError, describeSetup
} from '../lib/rcs.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- what actually enables RCS -------------------------------------------------------------------
{
  // Addressing a Messaging Service is the whole mechanism. Twilio then selects RCS or SMS itself.
  const rcs = buildSendParams({ to: '+15559876543', body: 'a tech is on the way', messagingServiceSid: 'MG123', fallbackFrom: '+15551112222' });
  ok(rcs.params.MessagingServiceSid === 'MG123', 'a Messaging Service SID is what turns RCS on');
  ok(rcs.params.FallbackFrom === '+15551112222', 'with an explicit SMS fallback sender');
  ok(!rcs.params.From, 'and no From — the two are alternatives, and Twilio rejects both together');
  ok(rcs.transport === 'rcs-or-sms', 'the outcome is honestly described as "one or the other"');

  // Without a Messaging Service it is plain SMS, and that is a working configuration.
  const sms = buildSendParams({ to: '+15559876543', body: 'hello', fromNumber: '+15551112222' });
  ok(sms.params.From === '+15551112222' && !sms.params.MessagingServiceSid, 'without one it is ordinary SMS');
  ok(sms.transport === 'sms', 'reported as such');

  // FallbackFrom is only valid alongside a Messaging Service — Twilio errors if sent bare.
  const bare = buildSendParams({ to: '+15559876543', body: 'x', fromNumber: '+15551112222', fallbackFrom: '+15553334444' });
  ok(!bare.params.FallbackFrom, 'a fallback sender is dropped when there is no Messaging Service to attach it to');

  ok(buildSendParams({ to: 'nonsense', body: 'x', messagingServiceSid: 'MG1' }).error, 'a bad number is refused');
  ok(buildSendParams({ to: '+15559876543', body: '  ', messagingServiceSid: 'MG1' }).error, 'and an empty message');
  ok(buildSendParams({ to: '+15559876543', body: 'x' }).error, 'and a configuration with no sender at all');
}

// ---- numbers as people actually type them ---------------------------------------------------------
{
  ok(normaliseNumber('+15559876543') === '+15559876543', 'E.164 passes through');
  ok(normaliseNumber('(555) 987-6543') === '+15559876543', 'a US number typed the human way is normalised');
  ok(normaliseNumber('555.987.6543') === '+15559876543', 'dots too');
  ok(normaliseNumber('15559876543') === '+15559876543', 'and one with a leading 1');
  ok(normaliseNumber('12345') === null, 'something too short is refused rather than guessed at');
  ok(normaliseNumber('') === null && normaliseNumber(null) === null, 'as is nothing');
}

// ---- which transport actually carried it ----------------------------------------------------------
{
  ok(transportFromResponse({ channel: 'rcs' }) === 'rcs', 'a resolved RCS send is recorded as RCS');
  ok(transportFromResponse({ channel: 'sms' }) === 'sms', 'and a fallback as SMS');

  // THE HONEST NULL. Twilio usually resolves the channel AFTER accepting the message, so at send
  // time it is genuinely unknown. Claiming RCS because we asked for it would put a wrong fact in
  // the ticket — and it is the kind of wrong fact nobody ever goes back and checks.
  ok(transportFromResponse({ sid: 'SM1' }) === null, 'an unresolved send is null, not optimistically "rcs"');
  ok(transportFromResponse({}) === null && transportFromResponse() === null, 'and an empty response does not throw');
}

// ---- inbound ----------------------------------------------------------------------------------------
{
  // RCS replies arrive at the same webhook as SMS, and belong in the same thread.
  ok(inboundTransport({ Channel: 'rcs' }) === 'rcs', 'an inbound RCS reply is recognised');
  ok(inboundTransport({ From: '+15559876543', Body: 'hi' }) === 'sms', 'a plain text is recorded as SMS');
  ok(inboundTransport({}) === 'sms', 'and an unmarked payload defaults to SMS rather than claiming RCS');
  // The default direction matters: calling a plain SMS "RCS" would be asserting something about the
  // customer's phone that we have no evidence for.
}

// ---- errors during the weeks of carrier approval -----------------------------------------------------
{
  // This is the one that will dominate the first two months.
  ok(/approval is still pending/.test(explainTwilioError(30032)),
    'a not-yet-approved sender says so, rather than looking like a broken integration');
  ok(/not configured for RCS/.test(explainTwilioError(63024)), 'a service without RCS explains itself');
  ok(/no sender in its pool/.test(explainTwilioError(21703)), 'an empty sender pool names the fix');
  ok(/opted out/.test(explainTwilioError(21610)), 'a STOP reply is reported as an opt-out, not a failure to investigate');
  ok(/filtered this message as spam/.test(explainTwilioError(30007)), 'carrier filtering is named');
  ok(explainTwilioError(99999, 'Some new thing').includes('Some new thing'), 'and an unknown code passes the message through');
  ok(explainTwilioError().length > 0, 'with no code at all, something is still said');
}

// ---- telling somebody what their settings will DO -----------------------------------------------------
{
  const none = describeSetup({});
  ok(none.level === 'none' && /cannot be sent/.test(none.text), 'no sender at all is stated plainly');

  const plain = describeSetup({ fromNumber: '+15551112222' });
  ok(plain.level === 'sms', 'SMS-only is a valid, working configuration');
  ok(/Messaging Service/.test(plain.text), 'and says what to add to get RCS');

  const full = describeSetup({ messagingServiceSid: 'MG1', fromNumber: '+15551112222', fallbackFrom: '+15553334444' });
  ok(full.level === 'rcs', 'a Messaging Service means RCS is on');
  ok(/fall back to SMS/.test(full.text), 'with the fallback explained');
  ok(/\+15553334444/.test(full.text), 'naming the actual fallback number');

  // THE SENTENCE THAT SAVES TWO MONTHS OF CONFUSION. Carrier approval runs 8–16 weeks, and the
  // entire time, every message falls back to SMS. Without saying so, somebody concludes the
  // integration is broken and starts debugging a system that is behaving correctly.
  ok(/working, not broken/.test(full.text),
    'and says that pre-approval fallback is the system working, not failing');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
