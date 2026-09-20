// Connecting Google Workspace mailboxes: credential handling and access control.
//
// The service account key stored here can read every mailbox a super admin has authorised. That
// makes this a credential of a different order from the others in this application — a carrier
// portal password reaches one account, this reaches the company's mail. So the tests below care
// most about two things: that it never comes back out over the API, and that only an admin can
// change it.
//
// The live connection test cannot run here — it needs Google. What IS tested is everything that
// decides whether it will work: the two-address distinction, and that nothing is silently assumed.
import { generateKeyPairSync } from 'node:crypto';

const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t };
}
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const KEY = JSON.stringify({
  type: 'service_account', project_id: 'geekitek-platform',
  client_email: 'netinv-mail@geekitek-platform.iam.gserviceaccount.com',
  client_id: '109876543210987654321', private_key: privateKey
});
const SECRET_FRAGMENT = privateKey.split('\n')[1].slice(0, 32);   // a distinctive slice of the key body

await login('admin@geekitek.test', 'admin123');

// ---- the credential -----------------------------------------------------------------------------
{
  ok((await call('/api/mail/credential')).json.configured === false, 'no credential is configured to begin with');

  const bad = await call('/api/mail/credential', { method: 'PUT', body: { key: JSON.stringify({ installed: { client_id: 'x' } }) } });
  ok(bad.status === 400 && /OAuth client file/i.test(bad.json.error),
    'pasting an OAuth client file — the easy mistake, since it sits on the same Google Cloud screen — is named as such');

  ok((await call('/api/mail/credential', { method: 'PUT', body: { key: 'nonsense' } })).status === 400, 'and nonsense is refused');

  const saved = await call('/api/mail/credential', { method: 'PUT', body: { key: KEY } });
  ok(saved.status === 200 && saved.json.client_id === '109876543210987654321',
    'a real service account key saves, and returns the client ID needed for the Admin Console step');

  const read = (await call('/api/mail/credential')).json;
  ok(read.configured && read.valid, 'the credential reads back as configured');
  ok(read.client_email.endsWith('.iam.gserviceaccount.com'), 'with the service account address, which the admin needs to see');

  // THE ONE THAT MATTERS.
  const body = JSON.stringify(read);
  ok(!body.includes('PRIVATE KEY') && !body.includes(SECRET_FRAGMENT),
    'and the private key NEVER comes back over the API — this key can read the company\'s mail');
  ok(!('private_key' in read) && !('key' in read), 'not under any field name');

  // The client_id is returned on purpose; it identifies the service account but does not
  // authenticate it, and making someone re-derive it invites pasting the wrong long number.
  ok(read.client_id === '109876543210987654321', 'the client ID is returned deliberately — it is an identifier, not a secret');
  ok(Array.isArray(read.scopes) && read.scopes.every(s => s.startsWith('https://www.googleapis.com/auth/gmail.')),
    'along with the exact scopes to authorise');
  ok(!read.scopes.some(s => s.endsWith('gmail.full')), 'and gmail.full is not among them');
}

// ---- the two addresses, which is the whole point of this schema -------------------------------------
{
  const made = await call('/api/mail/mailboxes', {
    body: { label: 'Support', impersonate_as: 'support@geekfiwifi.com', send_as: 'support@geekitek.com', purpose: 'customer' }
  });
  ok(made.status === 200, 'a mailbox is added with separate impersonation and send-as addresses');
  const id = made.json.id;

  const list = (await call('/api/mail/mailboxes')).json;
  const mb = list.find(m => m.id === id);
  ok(mb.impersonate_as === 'support@geekfiwifi.com',
    'the impersonation address is the account Google issues a token for — it must be the PRIMARY, never an alias');
  ok(mb.send_as === 'support@geekitek.com',
    'while the send-as is what customers see in From — on a multi-domain Workspace these genuinely differ');
  ok(mb.verified_at === null, 'and nothing is marked verified until a real connection test says so');

  ok((await call('/api/mail/mailboxes', { body: { label: 'Dup', impersonate_as: 'SUPPORT@geekfiwifi.com' } })).status === 409,
    'the same mailbox cannot be added twice, case-insensitively');
  ok((await call('/api/mail/mailboxes', { body: { label: 'Bad', impersonate_as: 'not-an-address' } })).status === 400,
    'and an invalid address is refused');
  ok((await call('/api/mail/mailboxes', { body: { label: 'Bad2', impersonate_as: 'a@b.com', send_as: 'nope' } })).status === 400,
    'as is an invalid send-as');

  const vendor = await call('/api/mail/mailboxes', { body: { label: 'Carriers', impersonate_as: 'carriers@geekfiwifi.com', purpose: 'vendor' } });
  ok(vendor.status === 200, 'a second mailbox is added for vendors');
  ok((await call('/api/mail/mailboxes')).json.find(m => m.id === vendor.json.id).send_as === null,
    'with no send-as, meaning "use the impersonation address" rather than a guess');

  // Adopting the primary the test discovered must preserve what the person wanted in From.
  const adopted = await call(`/api/mail/mailboxes/${id}/adopt-primary`, { body: { impersonate_as: 'support@geekfiwifi.com' } });
  ok(adopted.status === 200 && adopted.json.send_as === 'support@geekitek.com',
    'adopting a corrected primary address keeps the send-as the person chose — fixing one must not silently change the other');

  // A test against a key that cannot reach Google should fail informatively, not throw.
  const tested = await call(`/api/mail/mailboxes/${id}/test`, { body: {} });
  ok(tested.status === 200 && Array.isArray(tested.json.checks),
    'the connection test returns a list of checks rather than a boolean, because several outcomes are "works, but will misbehave later"');
  ok(tested.json.checks[0].name === 'Service account key' && tested.json.checks[0].ok,
    'it confirms the credential before trying the network');
  ok(tested.json.ok === false && tested.json.checks.some(c => !c.ok),
    'and against an unauthorised key it reports failure rather than hanging or throwing');
  // What the failure says depends on where the test runs. With egress to Google it is a delegation
  // or scope problem; in CI, with none, it is connectivity. Both must be named — and the second is
  // the one this test originally caught, because "fetch failed" was being surfaced verbatim to a
  // person who would then go and check their Admin Console for an hour.
  const detail = tested.json.checks.map(c => c.detail).join(' ');
  ok(/Admin Console|delegation|clock|Group|propagat|firewall|DNS|reach Google|connectivity/i.test(detail),
    `the failure names something actionable rather than restating the error ("${(tested.json.checks.find(c => !c.ok) || {}).detail?.slice(0, 90)}…")`);
  if (/reach Google|connectivity/i.test(detail)) {
    ok(/not a credential one|firewall/i.test(detail),
      'and when Google is simply unreachable it says so plainly, instead of sending someone to check a credential that is fine');
  } else {
    ok(true, 'this environment can reach Google, so the failure is a real authorisation one');
  }

  await call('/api/mail/mailboxes/' + vendor.json.id, { method: 'DELETE' });
  await call('/api/mail/mailboxes/' + id, { method: 'DELETE' });
  ok((await call('/api/mail/mailboxes')).json.length === 0, 'mailboxes can be removed');
}

// ---- who may touch it ------------------------------------------------------------------------------
{
  await login('noc@geekitek.test', 'noc123');
  ok((await call('/api/mail/mailboxes')).status === 200, 'NOC can see which mailboxes are connected');
  ok((await call('/api/mail/credential')).status === 200, 'and that a credential exists');
  ok(!JSON.stringify((await call('/api/mail/credential')).json).includes('PRIVATE KEY'), 'still without the key itself');
  ok((await call('/api/mail/credential', { method: 'PUT', body: { key: KEY } })).status === 403,
    'but NOC cannot replace the credential — it reaches every authorised mailbox, so that is admin-only');
  ok((await call('/api/mail/mailboxes', { body: { label: 'x', impersonate_as: 'x@y.com' } })).status === 403,
    'nor connect a new mailbox');

  await login('support@geekitek.test', 'support123');
  ok((await call('/api/mail/mailboxes')).status === 403, 'support sees none of this');
  ok((await call('/api/mail/credential')).status === 403, 'including whether a credential exists');

  cookie = '';
  ok((await call('/api/mail/credential')).status === 401, 'and signed out, nothing');

  await login('admin@geekitek.test', 'admin123');
  ok((await call('/api/mail/credential', { method: 'DELETE' })).status === 200, 'an admin can remove the credential');
  ok((await call('/api/mail/credential')).json.configured === false, 'and it is gone');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
