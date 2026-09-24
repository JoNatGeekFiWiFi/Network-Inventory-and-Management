// Staff accounts: changing the sign-in email, deactivating instead of deleting, and the guards that
// stop an admin locking the company out of its own system.
const B = process.env.BASE ?? 'http://localhost:3000';
function client() {
  let cookie = '';
  return async function call(p, { method = 'GET', body } = {}) {
    const h = {};
    if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
    if (cookie) h.cookie = cookie;
    const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j };
  };
}
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const stamp = Date.now();

const admin = client();
await admin('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
const me = (await admin('/api/me')).json;

// ---- a user to work on ----
const email = `pat${stamp}@geekfiwifi.example`;
const created = await admin('/api/users', { body: { name: 'Pat Tech', email, password: 'first-pass-1', role: 'field' } });
ok(created.status === 200, 'a user can be created');
const id = created.json.id;
const find = async () => (await admin('/api/users')).json.find(u => u.id === id);

// ---- changing the email ----
{
  const newEmail = `Pat.Renamed${stamp}@GeekFiWiFi.example`;
  ok((await admin('/api/users/' + id, { method: 'PUT', body: { email: newEmail } })).status === 200, "a user's email can be changed");
  ok((await find()).email === newEmail.toLowerCase(), 'and is stored lower-case');
  const pat = client();
  ok((await pat('/api/login', { body: { email: newEmail, password: 'first-pass-1' } })).status === 200, 'they sign in with the new email');
  ok((await client()('/api/login', { body: { email, password: 'first-pass-1' } })).status === 401, 'and the old one no longer works');
  ok((await admin('/api/users/' + id, { method: 'PUT', body: { email: 'admin@geekitek.test' } })).status === 409, "another user's email is refused");
  ok((await admin('/api/users/' + id, { method: 'PUT', body: { email: 'not an email' } })).status === 400, 'a malformed email is refused');
  ok((await admin('/api/users/' + id, { method: 'PUT', body: { name: 'Pat T' } })).status === 200 && (await find()).email === newEmail.toLowerCase(),
    'an edit that does not mention the email leaves it alone');

  // ---- deactivating ----
  ok((await pat('/api/me')).status === 200, 'while active, their session works');
  ok((await admin('/api/users/' + id, { method: 'DELETE' })).json.deactivated === true, 'removing a user deactivates them');
  ok((await find()) && (await find()).active === 0, 'the account is still there, marked deactivated');
  ok((await pat('/api/me')).status === 401, 'their existing session ends immediately');
  ok((await client()('/api/login', { body: { email: newEmail, password: 'first-pass-1' } })).status === 401, 'and they cannot sign in again');
  ok((await admin('/api/users/' + id, { method: 'PUT', body: { active: 1 } })).status === 200, 'they can be reactivated');
  ok((await client()('/api/login', { body: { email: newEmail, password: 'first-pass-1' } })).status === 200, 'and sign in again');

  // A password reset ends the sessions that existed before it.
  const before = client();
  await before('/api/login', { body: { email: newEmail, password: 'first-pass-1' } });
  await admin('/api/users/' + id, { method: 'PUT', body: { password: 'second-pass-2' } });
  ok((await before('/api/me')).status === 401, 'resetting a password signs out the sessions opened with the old one');
}

// ---- the guards ----
{
  ok((await admin('/api/users/' + me.id, { method: 'PUT', body: { active: 0 } })).status === 400, 'you cannot deactivate yourself');
  ok((await admin('/api/users/' + me.id, { method: 'DELETE' })).status === 400, 'by either route');
  const admins = (await admin('/api/users')).json.filter(u => u.role === 'admin' && u.active);
  if (admins.length === 1) {
    ok((await admin('/api/users/' + me.id, { method: 'PUT', body: { role: 'noc' } })).status === 400, 'the only active admin cannot be demoted');
  } else ok(true, 'skipped: more than one admin');
  // Second admin: now the first can be demoted, and the guard follows whoever is last.
  const a2 = (await admin('/api/users', { body: { name: 'Second Admin', email: `a2${stamp}@x.example`, password: 'admin-two-2', role: 'admin' } })).json.id;
  ok((await admin('/api/users/' + a2, { method: 'PUT', body: { role: 'noc' } })).status === 200, 'an admin can be demoted while another admin remains');
  await admin('/api/users/' + a2, { method: 'DELETE' });
}

// ---- access ----
{
  const sup = client();
  await sup('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await sup('/api/users/' + id, { method: 'PUT', body: { email: 'x@y.example' } })).status === 403, 'only an admin can change a user');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
