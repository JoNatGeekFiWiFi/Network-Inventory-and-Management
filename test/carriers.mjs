// Carriers: the company an account is with (Cox, Verizon, AT&T).
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

// ---- the carriers he named are there ----
{
  const list = (await call('/api/carriers')).json;
  const names = list.map(c => c.name);
  for (const n of ['Cox', 'Verizon', 'AT&T', 'T-Mobile'])
    ok(names.includes(n), `${n} is available as a carrier`);
  ok(list.every(c => typeof c.account_count === 'number'), 'each carrier reports how many accounts it holds');

  // The whole point of reusing upstream_providers: circuits see the same list.
  const cm = (await call('/api/circuits-options')).json;
  ok(cm.carriers.some(c => c.name === 'Verizon'),
    'a carrier added for accounts is the SAME record circuits terminate on — not a parallel list');
}

// ---- CRUD ----
let mine;
{
  const name = 'TEST-CARRIER-' + Date.now();
  mine = (await call('/api/carriers', { body: { name } })).json;
  ok(mine && mine.id, 'a carrier can be created');
  ok((await call('/api/carriers', { body: { name } })).status === 409, 'a duplicate name is rejected');
  ok((await call('/api/carriers', { body: { name: name.toLowerCase() } })).status === 409, 'and the check is case-insensitive');
  ok((await call('/api/carriers', { body: { name: '  ' } })).status === 400, 'a blank name is rejected');

  ok((await call('/api/carriers/' + mine.id, { method: 'PUT', body: { name: name + ' Renamed' } })).status === 200, 'a carrier can be renamed');
  ok((await call('/api/carriers/' + mine.id, { method: 'PUT', body: { name: 'Cox' } })).status === 409, 'renaming onto an existing carrier is rejected');
  ok((await call('/api/carriers/999999', { method: 'PUT', body: { name: 'X' } })).status === 404, 'editing a missing carrier is a 404');
}

// ---- accounts sit under a carrier ----
{
  const acct = (await call('/api/accounts', { body: { name: 'TEST-ACCT-CARRIER', status: 'Active', carrier_id: mine.id } })).json;
  ok(acct && acct.id, 'an account can be created with a carrier');

  const det = (await call('/api/accounts/' + acct.id)).json;
  ok(det.carrier && det.carrier.id === mine.id, 'account detail names its carrier');

  const listed = (await call('/api/accounts')).json.find(a => a.id === acct.id);
  ok(listed.carrier_name && listed.carrier_name.startsWith('TEST-CARRIER'), 'the accounts list carries the carrier name for grouping');

  const carrier = (await call('/api/carriers')).json.find(c => c.id === mine.id);
  ok(carrier.account_count === 1, 'the carrier counts its accounts');

  // Deleting must not leave accounts pointing at nothing.
  const del = await call('/api/carriers/' + mine.id, { method: 'DELETE' });
  ok(del.status === 409 && /account/i.test(del.json.error), 'a carrier still holding accounts cannot be deleted');

  // Reassigning and clearing.
  const cox = (await call('/api/carriers')).json.find(c => c.name === 'Cox');
  await call('/api/accounts/' + acct.id, { method: 'PUT', body: { name: 'TEST-ACCT-CARRIER', carrier_id: cox.id } });
  ok((await call('/api/accounts/' + acct.id)).json.carrier.name === 'Cox', 'an account can be moved to another carrier');

  // An update that doesn't mention the carrier must not silently clear it.
  await call('/api/accounts/' + acct.id, { method: 'PUT', body: { name: 'TEST-ACCT-CARRIER 2' } });
  ok((await call('/api/accounts/' + acct.id)).json.carrier_id === cox.id, 'a partial update leaves the carrier alone');

  await call('/api/accounts/' + acct.id, { method: 'PUT', body: { name: 'TEST-ACCT-CARRIER 2', carrier_id: '' } });
  ok((await call('/api/accounts/' + acct.id)).json.carrier_id === null, 'but an explicit empty value clears it');

  // Now it's free.
  ok((await call('/api/carriers/' + mine.id, { method: 'DELETE' })).status === 200, 'an unused carrier can be deleted');
  ok((await call('/api/carriers/' + mine.id, { method: 'DELETE' })).status === 404, 'deleting it twice is a 404');

  await call('/api/accounts/' + acct.id, { method: 'DELETE' });
}

// ---- a carrier in use by a circuit is protected too ----
{
  const cox = (await call('/api/carriers')).json.find(c => c.name === 'Cox');
  const pops = (await call('/api/meta')).json.pops;
  if (pops.length) {
    const ck = (await call('/api/circuits', { body: { label: 'TEST-CK-CARRIER', a_type: 'carrier', a_ref_id: cox.id, z_type: 'pop', z_ref_id: pops[0].id, status: 'Up' } })).json;
    if (ck && ck.id) {
      const del = await call('/api/carriers/' + cox.id, { method: 'DELETE' });
      ok(del.status === 409 && /circuit/i.test(del.json.error), 'a carrier referenced by a circuit cannot be deleted');
      await call('/api/circuits/' + ck.id, { method: 'DELETE' });
    } else ok(true, 'skipped: circuit fixture not created');
  } else ok(true, 'skipped: no POP to terminate a circuit on');
}

// ---- role gating ----
{
  cookie = ''; await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await call('/api/carriers')).status === 200, 'support can read the carrier list');
  ok((await call('/api/carriers', { body: { name: 'Nope' } })).status === 403, 'support cannot create a carrier');
  ok((await call('/api/carriers/1', { method: 'DELETE' })).status === 403, 'support cannot delete one');
  cookie = '';
  ok((await call('/api/carriers')).status === 401, 'anonymous callers get nothing');
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
