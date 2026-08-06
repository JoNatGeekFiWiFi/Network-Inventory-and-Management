// Public + static pages actually render. These have no JSON API surface, so nothing else
// covers them — a missing import in a domain module once broke /portal silently.
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; method = method === 'GET' ? 'POST' : method; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); return { status: r.status, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// static SPA + public pages
for (const [path, needle, label] of [
  ['/', 'Network Inventory', 'SPA index'],
  ['/app.js', 'renderCircuits', 'app.js served'],
  ['/styles.css', '.card', 'styles.css served'],
  ['/portal', 'Customer Portal', 'customer portal page'],
  ['/access', '', 'public site-access page'],
]) {
  const r = await call(path);
  ok(r.status === 200 && (!needle || r.t.includes(needle)), `${label} → ${r.status}`);
}

// tokenised public pages reject junk rather than 500
ok((await call('/pay/nope')).status === 404, 'unknown pay token → 404');
ok((await call('/quote/nope')).status === 404, 'unknown quote token → 404');
ok((await call('/portal/auth/nope')).status === 400, 'bad portal magic link → 400');

// inbound webhooks are secret-gated (no secret configured yet ⇒ reject)
ok((await call('/inbound/twilio/whatever', { method: 'POST' })).status === 403, 'twilio inbound rejects bad secret');
ok((await call('/inbound/email/whatever', { method: 'POST' })).status === 403, 'email inbound rejects bad secret');

// staff API still requires auth
ok((await call('/api/sites')).status === 401, 'API requires auth');

// malformed percent-encoding (scanner probes) → clean 400, not a thrown URIError stack
for (const bad of ['/.env.local.txt%85', '/%E0%A4%A', '/api/sites%ZZ', '/pay/%85']) {
  const r = await call(bad);
  ok(r.status === 400, `malformed URL ${bad} → 400 (got ${r.status})`);
}
// legitimate percent-encoding must still work
ok((await call('/api/sites%20')).status === 401, 'valid encoding still routes normally');

// scanner bait must 404, not hand back 200 + the whole SPA shell
for (const bait of ['/.env', '/.git/config', '/wp-login.php', '/config.php', '/.aws/credentials']) {
  const r = await call(bait);
  ok(r.status === 404, `scanner probe ${bait} → 404 (got ${r.status})`);
}
// ...and must never contain real secrets even by accident
{
  const r = await call('/.env');
  ok(!/smtp_pass|stripe_secret|twilio_token|password/i.test(r.t), '/.env body leaks nothing');
}
// Unauthenticated callers get 401 for any /api path — we deliberately don't reveal which
// endpoints exist. Once signed in, an unknown path must fail as JSON rather than HTML.
ok((await call('/api/definitely-not-a-route')).status === 401, 'unknown /api path → 401 while anonymous (no endpoint disclosure)');
await call('/api/login', { method: 'POST', body: { email: 'admin@geekitek.test', password: 'admin123' } });
{
  const r = await call('/api/definitely-not-a-route');
  ok(r.status === 404 && r.t.trim().startsWith('{'), `signed-in unknown /api path → JSON 404 (got ${r.status})`);
}
// real SPA deep links still serve the app
ok((await call('/sites')).status === 200, 'extensionless SPA path still serves index.html');

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
