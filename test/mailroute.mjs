// Which inbound email goes where: customer queue, vendor page, or left in Gmail.
import { routeInbound } from '../lib/mailroute.js';
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const env = {
  isOurs: (a) => a === 'support@geekfiwifi.com',
  hasReplyToken: (m) => !!m.token,
  vendorFor: (a) => ({ 'ap@ubnt.example': 7, 'rep@ubnt.example': 7, 'both@x.example': 9 }[a] || null),
  isKnownCustomer: (a) => ['cust@home.example', 'both@x.example'].includes(a)
};
const r = (from, token = false) => routeInbound({ from, token }, env);

ok(r('support@geekfiwifi.com').to === 'skip', 'our own copies are skipped');
ok(r('support@geekfiwifi.com', true).to === 'customer', 'unless they carry a reply token (a staff reply from the same box)');
ok(r('ap@ubnt.example').to === 'vendor' && r('ap@ubnt.example').vendor_id === 7, "a vendor's own address files on that vendor");
ok(r('rep@ubnt.example').vendor_id === 7, "so does one of its contacts' addresses");
ok(r('cust@home.example').to === 'customer', 'a customer on file goes to the customer queue, as before');
ok(r('both@x.example').to === 'vendor', 'an address on file as BOTH goes to the vendor page — a price list must never open a ticket');
ok(r('ap@ubnt.example', true).to === 'customer', 'but a reply token wins: it answers something we sent a customer');
ok(r('news@random.example').to === 'skip', 'strangers and newsletters stay in Gmail');
ok(routeInbound({ from: 'ap@ubnt.example' }, { ...env, vendorFor: null }).to === 'skip',
  'with no vendor module loaded, vendor mail is skipped rather than mis-filed as a customer');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
