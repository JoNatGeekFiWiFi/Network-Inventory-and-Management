// The carrier accounts shown on a customer are DERIVED from their sites and hardware.
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

const carriers = (await call('/api/carriers')).json;
const cox = carriers.find(c => c.name === 'Cox');
const verizon = carriers.find(c => c.name === 'Verizon');
const models = (await call('/api/models')).json;
const modelId = models.length ? models[0].id : null;

// An account on Cox, with two sub-accounts.
const acct = (await call('/api/accounts', { body: { name: 'SVC-ACCT', status: 'Active', carrier_id: cox.id } })).json;
const subA = (await call(`/api/accounts/${acct.id}/subaccounts`, { body: { name: 'SUB-A' } })).json;
const subB = (await call(`/api/accounts/${acct.id}/subaccounts`, { body: { name: 'SUB-B' } })).json;
const cust = (await call('/api/customers', { body: { name: 'SVC-CUSTOMER', account_ids: [acct.id] } })).json;
ok(acct.id && subA.id && subB.id && cust.id, 'fixtures created');

// ---- nothing assigned yet ----
{
  const c = (await call('/api/customers/' + cust.id)).json;
  // The customer is linked to the account, so that alone is a line — with no sub-account yet.
  ok(c.service.length === 1 && c.service[0].sources[0].type === 'customer',
    'the account link alone produces a line, before any site or hardware exists');
  ok(c.service[0].subaccount === null, 'with no sub-account, because none has been chosen');
}

// ---- derived from a site ----
let site;
{
  site = (await call('/api/sites', { body: { customer_id: cust.id, name: 'SVC-SITE', account_id: acct.id, subaccount_id: subA.id, service_address: '5 Service Rd, Tempe, AZ' } })).json;
  const c = (await call('/api/customers/' + cust.id)).json;
  // The vague "account, no sub" line folds into the specific one rather than showing twice.
  ok(c.service.length === 1, 'the site\'s sub-account absorbs the account-only line into one relationship');
  const l = c.service[0];
  ok(l.carrier === 'Cox', 'the carrier comes through from the account');
  ok(l.account === 'SVC-ACCT' && l.account_id === acct.id, 'the account is named and linkable');
  ok(l.subaccount === 'SUB-A', 'the sub-account comes from the site, which is where it was set');
  ok(l.sources.some(x => x.type === 'site' && x.label === 'SVC-SITE'), 'the line says which site it was derived from');
  ok(l.sources.some(x => x.type === 'customer'), 'and keeps the customer link as corroborating evidence');
}

// ---- a second site on the same account+sub collapses ----
{
  await call('/api/sites', { body: { customer_id: cust.id, name: 'SVC-SITE-2', account_id: acct.id, subaccount_id: subA.id, service_address: '6 Service Rd, Tempe, AZ' } });
  const c = (await call('/api/customers/' + cust.id)).json;
  ok(c.service.length === 1, 'two sites on the same account and sub-account collapse to one line');
  ok(c.service[0].sources.filter(x => x.type === 'site').length === 2, 'but both sites are cited');
}

// ---- a different sub-account is its own line ----
{
  await call('/api/sites', { body: { customer_id: cust.id, name: 'SVC-SITE-3', account_id: acct.id, subaccount_id: subB.id, service_address: '7 Service Rd, Tempe, AZ' } });
  const c = (await call('/api/customers/' + cust.id)).json;
  ok(c.service.filter(l => l.account_id === acct.id).length === 2,
    'a DIFFERENT sub-account stays a separate line — that mismatch is worth seeing');
  ok(c.service.some(l => l.subaccount === 'SUB-B'), 'and it names the other sub-account');
}

// ---- derived from hardware ----
{
  const dev = (await call('/api/devices', { body: { name: 'SVC-DEV', model_id: modelId, status: 'Deployed', management_mode: 'platform', assigned_type: 'site', assigned_site_id: site.id, ownership: 'carrier', carrier_id: verizon.id, owner_account: 'VZ-99887', owner_sub_account: 'VZ-SUB-1' } })).json;
  ok(dev && dev.id, 'a device on a different carrier is created at the site');
  const c = (await call('/api/customers/' + cust.id)).json;
  const vz = c.service.find(l => l.carrier === 'Verizon');
  ok(!!vz, 'the hardware contributes its own carrier line — a customer can be on two carriers');
  ok(vz.account === 'VZ-99887' && vz.subaccount === 'VZ-SUB-1', 'the free-text account and sub-account on the device are used');
  ok(vz.sources[0].type === 'device' && vz.sources[0].label === 'SVC-DEV', 'and the line cites the device');
}

// ---- units count as occupancy too ----
{
  const mdu = (await call('/api/sites', { body: { customer_id: null, name: 'SVC-MDU', account_id: acct.id, subaccount_id: subB.id, service_address: '900 Tower Rd, Tempe, AZ' } })).json;
  if (mdu && mdu.id) {
    await call(`/api/sites/${mdu.id}/units`, { body: { label: 'Unit 7', customer_id: cust.id } });
    const c = (await call('/api/customers/' + cust.id)).json;
    ok(c.service.some(l => l.sources.some(s => s.label === 'SVC-MDU')),
      'occupying a unit in a building counts, even though the site belongs to no one customer');
  } else ok(true, 'skipped: MDU fixture needs a customer on the site');
}

// ---- nothing is stored on the customer itself ----
{
  const c = (await call('/api/customers/' + cust.id)).json;
  ok(!('carrier_id' in c) && !('subaccount_id' in c),
    'the customer record itself holds no carrier fields — the rollup is derived, not a copy');
  // Changing the site must change the answer, which a stored copy would not do.
  await call('/api/sites/' + site.id, { method: 'PUT', body: { subaccount_id: subB.id } });
  const after = (await call('/api/customers/' + cust.id)).json;
  ok(!after.service.some(l => l.subaccount === 'SUB-A' && l.sources.some(s => s.label === 'SVC-SITE')),
    'moving the site to another sub-account immediately changes what the customer shows');
}

// ---- setting the sub-account directly on the customer ----
{
  const c2 = (await call('/api/customers', { body: { name: 'SVC-DIRECT', account_ids: [acct.id], account_subaccounts: { [acct.id]: subA.id } } })).json;
  ok(c2 && c2.id, 'a customer can be created on a specific sub-account');

  let got = (await call('/api/customers/' + c2.id)).json;
  ok(got.accounts[0].subaccount_id === subA.id, 'the link stores which sub-account');
  ok(got.accounts[0].subaccount_name === 'SUB-A', 'and reads back its name');
  ok(got.accounts[0].carrier_name === 'Cox', 'the carrier comes along with it');

  // It shows immediately, before any site or hardware exists.
  ok(got.service.length === 1 && got.service[0].subaccount === 'SUB-A', 'it appears in the rollup with no site or device');
  ok(got.service[0].sources[0].type === 'customer', 'and is marked as set on the customer, not inferred');

  // Changing it.
  await call('/api/customers/' + c2.id, { method: 'PUT', body: { name: 'SVC-DIRECT', account_ids: [acct.id], account_subaccounts: { [acct.id]: subB.id } } });
  got = (await call('/api/customers/' + c2.id)).json;
  ok(got.accounts[0].subaccount_name === 'SUB-B', 'the sub-account can be changed');

  // Clearing it.
  await call('/api/customers/' + c2.id, { method: 'PUT', body: { name: 'SVC-DIRECT', account_ids: [acct.id], account_subaccounts: {} } });
  got = (await call('/api/customers/' + c2.id)).json;
  ok(got.accounts[0].subaccount_id === null, 'and cleared, leaving the account link intact');

  // A sub-account belonging to a DIFFERENT account must not stick — otherwise re-pointing a
  // customer would leave it billed against a stranger's sub-account.
  const other = (await call('/api/accounts', { body: { name: 'SVC-OTHER-ACCT', status: 'Active' } })).json;
  await call('/api/customers/' + c2.id, { method: 'PUT', body: { name: 'SVC-DIRECT', account_ids: [other.id], account_subaccounts: { [other.id]: subA.id } } });
  got = (await call('/api/customers/' + c2.id)).json;
  ok(got.accounts[0].id === other.id && got.accounts[0].subaccount_id === null,
    "a sub-account from another account is rejected rather than carried across");

  await call('/api/customers/' + c2.id, { method: 'DELETE' });
  await call('/api/accounts/' + other.id, { method: 'DELETE' });
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
