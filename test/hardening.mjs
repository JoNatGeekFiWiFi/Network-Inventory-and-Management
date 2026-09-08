// Regressions for the security review.
//
// Every case here corresponds to a defect that was live in the running app. They are grouped by
// what an attacker or a mistaken user could actually do, not by which file was changed, because
// the point of the test is the capability — if a refactor reintroduces the hole by another route,
// this should still fail.
import { clientIp, contentDisposition } from '../lib/core.js';
import { readFileSync } from 'node:fs';

const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body, headers = {} } = {}) { const h = { ...headers }; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t, headers: r.headers }; }
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- client IP resolution (pure) ----
//
// nginx is configured with proxy_add_x_forwarded_for, which APPENDS the real peer to whatever the
// client sent. Trusting the first entry made every rate limit in the app bypassable.
{
  const req = (headers, remote = '10.0.0.9') => ({ headers, socket: { remoteAddress: remote } });
  ok(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })) === '203.0.113.7',
    'the LAST forwarded entry wins — the first is whatever the client claimed');
  ok(clientIp(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': 'evil, 203.0.113.7' })) === '203.0.113.7',
    'X-Real-IP, which our own nginx sets, is preferred');
  ok(clientIp(req({})) === '10.0.0.9', 'with no proxy headers it falls back to the socket');
  ok(clientIp(req({ 'x-forwarded-for': '' })) === '10.0.0.9', 'an empty header does not become the identity');
  // The whole point: two requests forging different XFF must not look like two different clients.
  const a = clientIp(req({ 'x-forwarded-for': 'aaa, 203.0.113.7' }));
  const b = clientIp(req({ 'x-forwarded-for': 'bbb, 203.0.113.7' }));
  ok(a === b, 'forging a different X-Forwarded-For does not produce a different client');
}

// ---- Content-Disposition ----
{
  ok(!/[^\x00-\x7F]/.test(contentDisposition('Cox — template.xlsx')), 'a non-ASCII filename cannot reach the header');
  ok(!contentDisposition('x\r\nSet-Cookie: a=b').includes('\r'), 'CRLF cannot be injected into headers');
}

// ---- login throttle cannot be defeated by forging X-Forwarded-For ----
{
  cookie = '';
  const attempt = (n) => call('/api/login', {
    body: { email: 'admin@geekitek.test', password: 'definitely-wrong' },
    headers: { 'x-forwarded-for': `10.9.9.${n}, 198.51.100.42` }   // a different claimed client each time
  });
  let throttled = false;
  for (let i = 0; i < 14 && !throttled; i++) if ((await attempt(i)).status === 429) throttled = true;
  ok(throttled, 'repeated failures from one real client are throttled despite a rotating X-Forwarded-For');
  cookie = '';
}

// ---- role enforcement lives on the server, not only in the page ----
await login('admin@geekitek.test', 'admin123');
const acct = (await call('/api/accounts')).json[0];
const site = (await call('/api/sites', { body: { account_id: acct.id, name: 'HARDENING site', service_address: '9 Hardening Way, Tempe, AZ' } })).json;
const dev = (await call('/api/devices', { body: { name: 'HARDENING device', status: 'Stock', admin_password: 'orig-admin-pw' } })).json;
ok(!!site.id && !!dev.id, 'fixtures created as admin');

const att = await call('/api/attachments', { body: { parent_type: 'site', parent_id: site.id, filename: 'x.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') } });
ok(att.status === 200, 'an attachment exists to try to delete');

{
  await login('support@geekitek.test', 'support123');
  // The page hides these behind isPriv(). The server has to say no as well.
  ok((await call('/api/devices/' + dev.id, { method: 'DELETE' })).status === 403, 'support cannot delete a device');
  ok((await call('/api/sites/' + site.id, { method: 'DELETE' })).status === 403, 'support cannot delete a site');
  ok((await call('/api/attachments/' + att.json.id, { method: 'DELETE' })).status === 403, 'support cannot delete an attachment');

  // Credentials are NOC-only to read. They must be NOC-only to write, or support can lock
  // everyone out of a router by replacing a password they cannot themselves see.
  await call('/api/devices/' + dev.id, { method: 'PUT', body: { name: 'HARDENING device', admin_password: 'hijacked' } });
  await login('admin@geekitek.test', 'admin123');
  const revealed = (await call('/api/devices/' + dev.id + '/reveal', { body: {} })).json;
  ok(revealed.credentials.admin_password === 'orig-admin-pw', 'a support edit did not overwrite the admin password');

  await login('support@geekitek.test', 'support123');
  const created = await call('/api/devices', { body: { name: 'HARDENING support device', admin_password: 'sneaky' } });
  await login('admin@geekitek.test', 'admin123');
  const r2 = (await call('/api/devices/' + created.json.id + '/reveal', { body: {} })).json;
  ok(!r2.credentials.admin_password, 'nor could support set one on a device they created');
  await call('/api/devices/' + created.json.id, { method: 'DELETE' });
}

// ---- credentials never reach a non-privileged reader ----
{
  await login('support@geekitek.test', 'support123');
  const d = (await call('/api/devices/' + dev.id)).json;
  const leaked = ['admin_password', 'factory_password', 'acct_portal_password', 'acct_pin'].filter(k => k in d);
  ok(leaked.length === 0, 'the device read strips every NOC credential');
  ok(d.has_admin_password === true, 'and reports only that one is set');
  const rev = (await call('/api/devices/' + dev.id + '/reveal', { body: {} })).json;
  ok(!('admin_password' in rev.credentials), 'reveal gives support the tech account only');
  await login('admin@geekitek.test', 'admin123');
}

// ---- a doctored billing backup cannot inject SQL through its column names ----
{
  const before = (await call('/api/users')).status;   // admin can list users; proves the table is there
  const evil = {
    format: 'netinv-billing-backup', version: 2,
    invoices: [{ 'id) VALUES (9999); DROP TABLE users; --': 1 }],
    items: [], payments: [], recurring: [], quotes: [], quote_items: [], products: []
  };
  const r = await call('/api/billing/restore', { body: evil });
  ok(r.status === 500 || r.status === 400, 'a backup whose columns are not real columns is refused');
  const after = await call('/api/users');
  ok(after.status === before && Array.isArray(after.json) && after.json.length > 0,
    'and the users table is still there afterwards');

  // A legitimate round trip must still work.
  const dump = await call('/api/billing/backup');
  ok(dump.status === 200, 'a real backup still downloads');
  const restored = await call('/api/billing/restore', { body: JSON.parse(dump.t) });
  ok(restored.status === 200, 'and restores');
}

// ---- errors do not hand the caller a stack trace ----
{
  const r = await call('/api/import/template/' + encodeURIComponent('../../etc/passwd'));
  ok(r.status === 404, 'an unknown template is a clean 404, not a traversal');
  ok(!r.t.includes('/sessions/') && !r.t.includes('at file:'),
    'no server path or stack frame appears in the response body');
}

// ---- staged imports expire, and cannot be replayed ----
{
  const csv = 'Customer / Business Name,Service Address,Carrier,Account Number,Portal Password\nStage Test,1 Stage St Tempe AZ,Cox,STAGE-1,secret-pw';
  const h = { 'content-type': 'application/octet-stream', cookie };
  const r = await fetch(B + '/api/import/analyze?filename=stage.csv', { method: 'POST', headers: h, body: Buffer.from(csv) });
  const a = JSON.parse(await r.text());
  const first = await call('/api/import/commit', { body: { token: a.token } });
  ok(first.status === 200, 'a staged import commits once');
  ok((await call('/api/import/commit', { body: { token: a.token } })).status === 410,
    'and the token is gone afterwards, so a double submit cannot import twice');
  ok((await call('/api/import/commit', { body: { token: 'made-up-token' } })).status === 410,
    'an invented token is refused');
}

// ---- session cookie flags ----
{
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@geekitek.test', password: 'admin123' }) });
  const sc = r.headers.get('set-cookie') || '';
  ok(/HttpOnly/i.test(sc), 'the session cookie is HttpOnly, so script cannot read it');
  ok(/SameSite=Lax/i.test(sc), 'and SameSite=Lax, which is what blocks cross-site state changes');
  cookie = sc.split(';')[0];
}

// clean up
await login('admin@geekitek.test', 'admin123');
await call('/api/devices/' + dev.id, { method: 'DELETE' });
await call('/api/sites/' + site.id, { method: 'DELETE' });

// ---- the deploy script cannot fill the disk and then be unable to clean up ----
//
// This actually happened: 16 database copies at ~700 MB filled a 9.8 GB volume. Two causes, both
// pinned here. The retention count was written when the database was small, and the prune ran
// AFTER the copy — so once the disk filled, the copy failed, `set -e` exited, and the cleanup
// could never run again. Every retry failed identically.
{
  const sh = readFileSync('deploy/deploy.sh', 'utf8');
  const pruneAt = sh.indexOf('tail -n +"$KEEP"');
  const copyAt = Math.min(
    ...['sqlite3 "$DB_PATH" ".backup', 'cp "$DB_PATH" "$BAK_FILE"']
      .map(t => { const i = sh.indexOf(t); return i === -1 ? Infinity : i; })
  );
  ok(pruneAt > -1, 'the deploy prunes old database backups');
  ok(pruneAt < copyAt, 'and prunes BEFORE writing the new one, so a full disk can still recover');

  ok(/KEEP="\$\{KEEP_BACKUPS:-([1-5])\}"/.test(sh), 'retention is a small number, not one sized for a tiny database');
  ok(/-size 0 -delete/.test(sh), 'zero-length backups left by a previous failure are cleared');
  ok(/FREE_KB/.test(sh) && /NEED_KB/.test(sh), 'free space is checked before anything is touched');
  ok(sh.indexOf('FREE_KB') < sh.indexOf('systemctl stop'), 'and checked BEFORE the service is stopped');

  // The outage: no sqlite3, so it stopped the service, the copy failed, and set -e exited with the
  // service still down. A trap makes that impossible.
  const noSqlite = sh.slice(sh.indexOf('No sqlite3'), sh.indexOf('No sqlite3') + 600);
  ok(/trap .*systemctl start/.test(sh), 'a failure mid-backup always restarts the service');
  ok(sh.indexOf('trap') < sh.indexOf('systemctl stop'), 'with the trap set before the service is stopped');
  ok(/install .*sqlite3/.test(sh), 'and it suggests sqlite3, which avoids stopping the service at all');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
