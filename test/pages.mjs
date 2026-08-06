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

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
