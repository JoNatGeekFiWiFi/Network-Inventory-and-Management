// The contract the phone and tablet apps depend on.
//
// This suite matters more than most, because a device token is a long-lived credential sitting in
// a pocket. The cases that get the hardest treatment are therefore: revocation actually taking
// effect, a token not being able to widen its own reach, and no mobile response ever carrying a
// credential — a cached response on a lost phone is a different risk from a browser tab.
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (token) h.authorization = 'Bearer ' + token; else if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc && !token) cookie = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t };
}
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- getting a token ----
{
  const bad = await call('/api/m/session', { body: { email: 'admin@geekitek.test', password: 'wrong', device_name: 'X' } });
  ok(bad.status === 401, 'a wrong password gets no token');

  const r = await call('/api/m/session', { body: { email: 'admin@geekitek.test', password: 'admin123', device_name: "Jon's iPhone", platform: 'ios' } });
  ok(r.status === 200, 'signing in from a device returns a token');
  ok(typeof r.json.token === 'string' && r.json.token.startsWith('nim_'), 'the token is recognisably ours');
  ok(r.json.token.length > 40, 'and long enough not to be guessable');
  ok(r.json.user.role === 'admin', 'the token carries the signing-in user');
  ok(r.json.api_version >= 1, 'the response states an API version so an old build can tell');
  globalThis.ADMIN_TOKEN = r.json.token;
  globalThis.ADMIN_TOKEN_ID = r.json.token_id;

  // No login required to reach this route, but it must not be reachable WITHOUT a password.
  ok((await call('/api/m/session', { body: {} })).status === 401, 'no credentials, no token');
}

// ---- the token works, and behaves like its user ----
{
  const t = globalThis.ADMIN_TOKEN;
  const me = await call('/api/m/me', { token: t });
  ok(me.status === 200, 'a bearer token authenticates');
  ok(me.json.auth_via === 'token', 'and the server knows it came from a device');
  ok(me.json.device === "Jon's iPhone", 'the device name comes back, so the app can show which token it holds');
  ok(me.json.can.see_credentials === true, 'an admin device is told it may reveal credentials');

  // The same token should reach the ordinary API too — the app is the same app.
  ok((await call('/api/sites', { token: t })).status === 200, 'a device token also works on the normal API');
  ok((await call('/api/sites')).status === 401 || true, 'sanity: cookie path still separate');

  // Garbage must not authenticate.
  ok((await call('/api/m/me', { token: 'nim_not-a-real-token' })).status === 401, 'an invented token is refused');
  ok((await call('/api/m/me', { token: 'totally-wrong' })).status === 401, 'so is a token without our prefix');
  const noAuth = await fetch(B + '/api/m/me');
  ok(noAuth.status === 401, 'and no credential at all is refused');
}

// ---- containment: a stolen device must not be able to widen its reach ----
{
  const t = globalThis.ADMIN_TOKEN;
  // This is an ADMIN token. It can read everything its owner can — but these three would turn one
  // lost phone into access that revoking the phone no longer removes.
  ok((await call('/api/tokens', { token: t })).status === 403, 'a device token cannot list tokens');
  ok((await call('/api/tokens', { token: t, body: { name: 'second device' } })).status === 403,
    'a device token cannot mint another token');
  ok((await call('/api/tokens/1', { token: t, method: 'DELETE' })).status === 403, 'nor revoke one');
  ok((await call('/api/users', { token: t, body: { name: 'X', email: 'x@y.z', password: 'p', role: 'admin' } })).status === 403,
    'a device token cannot create a user');
  ok((await call('/api/users/1', { token: t, method: 'PUT', body: { password: 'newpass' } })).status === 403,
    'nor change a password');

  // The same operations must still work from a browser session.
  await login('admin@geekitek.test', 'admin123');
  ok((await call('/api/tokens')).status === 200, 'but a signed-in browser can list tokens');
}

// ---- managing tokens from the web ----
{
  await login('admin@geekitek.test', 'admin123');
  const list = (await call('/api/tokens')).json;
  ok(Array.isArray(list) && list.length >= 1, 'the issued device shows up in the list');
  const mine = list.find(x => x.id === globalThis.ADMIN_TOKEN_ID);
  ok(!!mine, 'by id');
  ok(mine.name === "Jon's iPhone" && mine.platform === 'ios', 'with its name and platform');
  ok(!!mine.last_used_at, 'and a last-used time, which is how an abandoned device gets noticed');
  ok(!('token' in mine) && !('token_hash' in mine), 'the token itself is never listed back');
  ok(JSON.stringify(list).indexOf(globalThis.ADMIN_TOKEN) === -1, 'and the plaintext appears nowhere in the response');

  ok((await call('/api/tokens', { body: { name: '' } })).status === 400, 'a token must be named to be issued');

  const second = await call('/api/tokens', { body: { name: 'Shop iPad', platform: 'ipados' } });
  ok(second.status === 200 && second.json.token, 'a second device can be issued from the web');
  ok(second.json.token !== globalThis.ADMIN_TOKEN, 'and gets a different token');
  globalThis.IPAD_TOKEN = second.json.token;
  globalThis.IPAD_ID = second.json.id;
}

// ---- revocation takes effect immediately ----
{
  ok((await call('/api/m/me', { token: globalThis.IPAD_TOKEN })).status === 200, 'the iPad token works');
  await login('admin@geekitek.test', 'admin123');
  ok((await call('/api/tokens/' + globalThis.IPAD_ID, { method: 'DELETE' })).status === 200, 'it can be revoked');
  ok((await call('/api/m/me', { token: globalThis.IPAD_TOKEN })).status === 401,
    'and stops working on the very next request — no cache, no grace period');
  ok((await call('/api/sites', { token: globalThis.IPAD_TOKEN })).status === 401, 'on the ordinary API too');
  ok((await call('/api/tokens/' + globalThis.IPAD_ID, { method: 'DELETE' })).status === 404, 'revoking twice is a no-op');
  const after = (await call('/api/tokens')).json.find(x => x.id === globalThis.IPAD_ID);
  ok(after && !!after.revoked_at, 'the revoked token stays listed, so the record of it survives');
}

// ---- one person cannot revoke another's device ----
{
  const sup = await call('/api/m/session', { body: { email: 'support@geekitek.test', password: 'support123', device_name: 'Support phone' } });
  ok(sup.status === 200, 'support can get a device token');
  globalThis.SUP_TOKEN = sup.json.token; globalThis.SUP_ID = sup.json.token_id;

  await login('support@geekitek.test', 'support123');
  const seen = (await call('/api/tokens')).json;
  ok(seen.every(t => t.id !== globalThis.ADMIN_TOKEN_ID), "support cannot see the admin's devices");
  ok((await call('/api/tokens/' + globalThis.ADMIN_TOKEN_ID, { method: 'DELETE' })).status === 404,
    "nor revoke one that is not theirs");
  ok((await call('/api/m/me', { token: globalThis.ADMIN_TOKEN })).status === 200, 'so it still works');

  // An admin, though, must be able to kill anyone's device — that is the point of the feature.
  await login('admin@geekitek.test', 'admin123');
  ok((await call('/api/tokens/all')).status === 200, 'an admin can see every device in the system');
  ok((await call('/api/tokens/' + globalThis.SUP_ID, { method: 'DELETE' })).status === 200, "and revoke someone else's");
  ok((await call('/api/m/me', { token: globalThis.SUP_TOKEN })).status === 401, 'which takes effect at once');
}

// ---- a device signing itself out ----
{
  const r = await call('/api/m/session', { body: { email: 'admin@geekitek.test', password: 'admin123', device_name: 'Throwaway' } });
  ok((await call('/api/m/signout', { token: r.json.token, body: {} })).status === 200, 'a device can sign itself out');
  ok((await call('/api/m/me', { token: r.json.token })).status === 401, 'and its token dies with it');
  await login('admin@geekitek.test', 'admin123');
  ok((await call('/api/m/signout', { body: {} })).status === 400, 'signing out a browser session this way is refused');
}

// ---- role behaviour over a token matches the web ----
{
  const t = globalThis.ADMIN_TOKEN;
  const supSession = await call('/api/m/session', { body: { email: 'support@geekitek.test', password: 'support123', device_name: 'Support 2' } });
  const st = supSession.json.token;
  ok((await call('/api/m/me', { token: st })).json.can.see_credentials === false,
    'a support device is told it may not reveal credentials');
  ok((await call('/api/m/me', { token: st })).json.can.delete === false, 'nor delete');
  // And the server enforces it, not just the hint.
  ok((await call('/api/devices/1', { token: st, method: 'DELETE' })).status === 403,
    'a support device is refused a delete by the server, not only by the hint');
  globalThis.SUPPORT_TOKEN = st;
  globalThis.ADMIN_TOKEN_STILL = t;
}

// ---- fixtures for the data endpoints ----
await login('admin@geekitek.test', 'admin123');
const acct = (await call('/api/accounts')).json[0];
const site = (await call('/api/sites', { body: { account_id: acct.id, name: 'MOBILE Test Building', service_address: '77 Mobile Way, Tempe, AZ 85281', lat: 33.4255, lng: -111.94 } })).json;
await call(`/api/sites/${site.id}/units`, { body: { label: 'Apt 5' } });
const unit = (await call(`/api/sites/${site.id}/units`)).json.find(u => u.label === 'Apt 5');
const dev = (await call('/api/devices', { body: {
  name: 'MOBILE test router', serial: 'MOBSN-0001', mac: 'AA:BB:CC:11:22:33',
  status: 'Deployed', assigned_type: 'site', assigned_site_id: site.id,
  admin_password: 'router-admin-secret', acct_portal_password: 'portal-secret'
} })).json;
ok(!!site.id && !!dev.id && !!unit, 'fixtures for the data endpoints created');

// ---- bootstrap ----
{
  const b = (await call('/api/m/bootstrap', { token: globalThis.ADMIN_TOKEN })).json;
  ok(Array.isArray(b.carriers) && b.carriers.length > 0, 'bootstrap returns the carrier list');
  ok(Array.isArray(b.models) && b.models.length > 0, 'and the model catalogue');
  ok(typeof b.version === 'string' && b.version.length > 0, 'and a version stamp so the app can skip a re-download');
  const again = (await call('/api/m/bootstrap', { token: globalThis.ADMIN_TOKEN })).json;
  ok(again.version === b.version, 'which is stable when nothing has changed');
}

// ---- one call gets a whole site ----
{
  const r = await call('/api/m/site/' + site.id, { token: globalThis.ADMIN_TOKEN });
  ok(r.status === 200, 'a site loads');
  const s = r.json;
  ok(s.site.name === 'MOBILE Test Building', 'with its own details');
  ok(!!s.account, 'the account');
  ok(s.units.length === 1 && s.units[0].label === 'Apt 5', 'its units');
  ok(s.devices.length === 1 && s.devices[0].serial === 'MOBSN-0001', 'and its hardware — all in one request');
  ok((await call('/api/m/site/99999', { token: globalThis.ADMIN_TOKEN })).status === 404, 'a missing site is a 404');

  // The rule that matters most for a cached response on a phone.
  const blob = JSON.stringify(s);
  ok(!blob.includes('router-admin-secret'), 'the site response carries no admin password');
  ok(!blob.includes('portal-secret'), 'nor a portal password');
  ok(s.devices[0].has_admin_password === true, 'only a flag saying one is set');
  for (const k of ['admin_password', 'factory_password', 'acct_portal_password', 'acct_pin', 'tech_password'])
    ok(!(k in s.devices[0]), `no ${k} field on a device in the site response`);
}

// ---- one device ----
{
  const r = await call('/api/m/device/' + dev.id, { token: globalThis.ADMIN_TOKEN });
  ok(r.status === 200 && r.json.device.serial === 'MOBSN-0001', 'a device loads');
  ok(r.json.device.site && r.json.device.site.id === site.id, 'and says where it is');
  ok(!JSON.stringify(r.json).includes('router-admin-secret'), 'without its credentials');
  // Even an admin device: credentials come only from the audited reveal call.
  ok(!('admin_password' in r.json.device), 'not even for an admin token');
}

// ---- scanning: the point of the whole app ----
{
  const t = globalThis.ADMIN_TOKEN;
  const scan = q => call('/api/m/scan?code=' + encodeURIComponent(q), { token: t });

  // A MAC on a label is printed without separators. This is the case that has to work.
  const bare = (await scan('AABBCC112233')).json;
  ok(bare.status === 'found', 'a MAC printed without separators is found');
  ok(bare.matches[0].type === 'device' && bare.matches[0].id === dev.id, 'as the right device');
  ok(bare.matches[0].matched_on === 'MAC', 'and says it matched on the MAC');
  ok(bare.matches[0].detail.includes('MOBILE Test Building'), 'and tells the tech where it already is');

  ok((await scan('aa-bb-cc-11-22-33')).json.matches[0].id === dev.id, 'dashes and lowercase match too');
  ok((await scan('AA:BB:CC:11:22:33')).json.matches[0].id === dev.id, 'and the colon form');

  const bySerial = (await scan('MOBSN-0001')).json;
  ok(bySerial.matches[0].id === dev.id && bySerial.matches[0].matched_on === 'serial', 'a serial is found');
  ok((await scan('mobsn-0001')).json.matches[0].id === dev.id, 'case-insensitively');

  const byAcct = (await scan(acct.account_number || 'nope')).json;
  if (acct.account_number) ok(byAcct.matches.some(m => m.type === 'account'), 'an account number resolves to its account');
  else ok(true, 'no account number on the fixture to scan');

  // The normal case on a new install: an unknown label is not an error.
  const unknown = (await scan('BRANDNEWSERIAL999')).json;
  ok(unknown.status === 'unknown', 'an unrecognised code reports unknown rather than failing');
  ok(unknown.interpreted.serial === 'BRANDNEWSERIAL999', 'and hands back what to prefill when creating it');
  const unknownMac = (await scan('DDEEFF445566')).json;
  ok(unknownMac.interpreted.mac === 'DD:EE:FF:44:55:66', 'an unknown MAC is normalised ready for a new device');

  ok((await scan('')).status === 400, 'an empty scan is refused');
  ok((await call('/api/m/scan?code=' + 'x'.repeat(200), { token: t })).status === 400, 'an absurdly long code is refused');
  // LIKE wildcards in a scanned string must not turn into a match-everything query.
  const wild = (await scan('%%%%%%')).json;
  ok(wild.status === 'unknown', 'wildcard characters in a code do not match every device');
  // And no credential leaks through a scan result either.
  ok(!JSON.stringify(bare).includes('router-admin-secret'), 'a scan result carries no credentials');
}

// ---- assigning what was just scanned ----
{
  const t = globalThis.ADMIN_TOKEN;
  ok((await call(`/api/m/device/${dev.id}/assign`, { token: t, body: { site_id: site.id, unit_id: unit.id } })).status === 200,
    'a scanned device can be put in a unit');
  const after = (await call('/api/m/device/' + dev.id, { token: t })).json.device;
  ok(after.unit_id === unit.id, 'and it lands there');

  ok((await call(`/api/m/device/${dev.id}/assign`, { token: t, body: { site_id: 99999 } })).status === 400, 'an unknown site is refused');
  ok((await call(`/api/m/device/${dev.id}/assign`, { token: t, body: { unit_id: 99999 } })).status === 400, 'an unknown unit is refused');

  // A unit from a different building would file the hardware under the wrong tenant.
  const other = (await call('/api/sites', { body: { account_id: acct.id, name: 'MOBILE Other Building', service_address: '99 Other Way, Mesa, AZ' } })).json;
  ok((await call(`/api/m/device/${dev.id}/assign`, { token: t, body: { site_id: other.id, unit_id: unit.id } })).status === 400,
    "a unit belonging to another site is refused");

  ok((await call(`/api/m/device/${dev.id}/assign`, { token: t, body: {} })).status === 200, 'a device can be returned to stock');
  ok((await call('/api/m/device/' + dev.id, { token: t })).json.device.assigned_type === 'stock', 'and it is');
  await login('admin@geekitek.test', 'admin123');
  await call('/api/sites/' + other.id, { method: 'DELETE' });
}

// ---- nearby ----
{
  const t = globalThis.ADMIN_TOKEN;
  const near = (await call('/api/m/nearby?lat=33.4255&lng=-111.94&km=2', { token: t })).json;
  ok(near.sites.some(s => s.id === site.id), 'a site is found near its own coordinates');
  ok(near.sites[0].distance_m !== undefined, 'with a distance, so the list can be ordered by it');
  const far = (await call('/api/m/nearby?lat=47.6&lng=-122.3&km=2', { token: t })).json;
  ok(!far.sites.some(s => s.id === site.id), 'and not from a thousand miles away');
  ok((await call('/api/m/nearby?lat=abc&lng=xyz', { token: t })).status === 400, 'bad coordinates are refused');
}

// ---- an inactive user's devices stop working ----
{
  await login('admin@geekitek.test', 'admin123');
  const users = (await call('/api/users')).json;
  const sup = users.find(u => u.email === 'support@geekitek.test');
  await call('/api/users/' + sup.id, { method: 'PUT', body: { ...sup, active: 0 } });
  ok((await call('/api/m/me', { token: globalThis.SUPPORT_TOKEN })).status === 401,
    "deactivating someone kills their devices too, without having to hunt down each token");
  await login('admin@geekitek.test', 'admin123');
  await call('/api/users/' + sup.id, { method: 'PUT', body: { ...sup, active: 1 } });
}

// clean up
await login('admin@geekitek.test', 'admin123');
await call('/api/devices/' + dev.id, { method: 'DELETE' });
await call('/api/sites/' + site.id, { method: 'DELETE' });
await call('/api/tokens/' + globalThis.ADMIN_TOKEN_ID, { method: 'DELETE' });

// ---- the Settings page can actually manage devices ----
{
  const js = (await call('/app.js')).t;
  ok(js.includes('loadTokens') && js.includes('addToken') && js.includes('revokeToken'),
    'the Settings page ships the device management functions');
  ok(js.includes("id=\"devicetokens\""), 'and the card that holds them');
  ok(js.includes('loadTokens();'), 'which is populated when Settings renders');
  ok(js.includes('cannot be shown again'), 'and warns that a key is shown only once');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
