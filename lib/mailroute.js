// Where one inbound email goes. Pure, so the ordering of the rules can be tested without Google.
//
// The order is the whole point, and each step is there because of a specific wrong outcome:
//
//   1. Sent by us, and not a reply to anything we track → SKIP. Our own outbound copies are not news.
//   2. Carries a reply token (plus-address or ticket number) → CUSTOMER. It answers something we sent
//      a customer, whoever it now appears to come from — forwarded replies and aliases included.
//   3. From a vendor's address, or one of its contacts → VENDOR. Filed on the vendor page. Checked
//      BEFORE the customer rule, so a price list never lands in the support queue even if the same
//      address is, oddly, also on file as a customer.
//   4. From a customer on file → CUSTOMER.
//   5. Anything else → SKIP. Newsletters and cold pitches stay in Gmail, where they belong.
export function routeInbound(msg, { isOurs, hasReplyToken, vendorFor, isKnownCustomer }) {
  const token = !!hasReplyToken(msg);
  if (isOurs(msg.from) && !token) return { to: 'skip', why: 'ours' };
  if (token) return { to: 'customer', why: 'reply-token' };
  const vendorId = vendorFor ? vendorFor(msg.from) : null;
  if (vendorId) return { to: 'vendor', vendor_id: vendorId, why: 'vendor-address' };
  if (isKnownCustomer(msg.from)) return { to: 'customer', why: 'known-customer' };
  return { to: 'skip', why: 'unknown-sender' };
}
