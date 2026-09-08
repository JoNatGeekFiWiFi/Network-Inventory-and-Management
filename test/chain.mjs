// Creating a customer from wherever you happen to be.
//
// The case behind this file: adding a router straight from ZeroTier to a site for someone not yet
// in the system. That dead-ended, because a site needs a customer, a customer needs an account,
// and the device form only offered a picker over customers that already existed. The site form had
// grown the full chain; the device form had not — so the fix was to share one implementation, and
// these tests cover the chain itself plus the fact that both forms use it.
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

await login('admin@geekitek.test', 'admin123');

// ---- the server side of the chain, in the order the form walks it ----
{
  // A customer with no account is refused — this is why the chain has to start at the account.
  const orphan = await call('/api/customers', { body: { name: 'CHAIN Orphan Customer' } });
  ok(orphan.status === 400, 'a customer cannot be created without an account');

  const acct = await call('/api/accounts', { body: { name: 'CHAIN Test Account', account_number: 'CHAIN-001', status: 'Active' } });
  ok(acct.status === 200 && acct.json.id, 'an account can be created inline');

  const cust = await call('/api/customers', { body: { account_ids: [acct.json.id], name: 'CHAIN New Customer' } });
  ok(cust.status === 200 && cust.json.id, 'and a customer under it');

  // And now the thing that was impossible: a site for that brand-new customer.
  const site = await call('/api/sites', { body: {
    name: 'CHAIN ZeroTier Site', customer_id: cust.json.id,
    service_address: '4100 Chain Ave, Tempe, AZ 85281'
  } });
  ok(site.status === 200 && site.json.id, 'and a site for them');

  const full = (await call('/api/sites/' + site.json.id)).json;
  ok(full.customer && full.customer.id === cust.json.id, 'the site belongs to the new customer');
  ok(full.account && full.account.id === acct.json.id, "and is served by the customer's account, derived not typed");
  ok(!!full.service_address, 'the site has an address');
  ok(!!full.addr_key, 'and a normalised address key, so a second tenant will match this building');

  // The device, as the ZeroTier flow creates it.
  const dev = await call('/api/devices', { body: {
    name: 'CHAIN ZT Router', zt_node_id: 'deadbeef01', mgmt_overlay: 'ZeroTier',
    status: 'Deployed', assigned_type: 'site', assigned_site_id: site.json.id
  } });
  ok(dev.status === 200 && dev.json.id, 'a device created from a ZeroTier member saves');
  const d = (await call('/api/devices/' + dev.json.id)).json;
  ok(d.assigned_site_id === site.json.id, 'and lands on the new site');
  ok(d.zt_node_id === 'deadbeef01', 'keeping the ZeroTier node id it was prefilled with');

  globalThis.CHAIN = { acct: acct.json.id, cust: cust.json.id, site: site.json.id, dev: dev.json.id };
}

// ---- a site created this way is findable, which is the point of the address ----
{
  const { site } = globalThis.CHAIN;
  const hits = (await call('/api/search?q=' + encodeURIComponent('4100 Chain Ave'))).json;
  const flat = JSON.stringify(hits);
  ok(flat.includes('CHAIN ZeroTier Site'), 'the new site is findable by its address');

  // A second tenant at the same address must be recognised as the same building, not a new one.
  // Written without the ZIP and with the street spelled out, which is how the second tech types it.
  const look = await call('/api/sites/lookup?address=' + encodeURIComponent('4100 chain avenue, tempe arizona'));
  ok(look.status === 200, 'the address lookup answers');
  ok(look.json.matches.some(m => m.id === site),
    'and matches the differently spelled address to the same building');

  // The specific trap: the stored address HAS a ZIP and the typed one does not. Keeping the ZIP in
  // the key made these two different buildings, so a second tenant silently got a second site.
  const withZip = await call('/api/sites/lookup?address=' + encodeURIComponent('4100 Chain Ave, Tempe, AZ 85281'));
  ok(withZip.json.key === look.json.key, 'the key is the same with or without a ZIP');
  ok(withZip.json.matches.some(m => m.id === site), 'so both spellings find the building');

  // A unit in the typed address is recognised and not treated as part of the building.
  const unit = await call('/api/sites/lookup?address=' + encodeURIComponent('4100 Chain Ave Apt 7, Tempe AZ'));
  ok(unit.json.unit === '7', 'a unit is pulled out of the address');
  ok(unit.json.matches.some(m => m.id === site), 'and the building still matches');
}

// ---- role gating: creating a customer is NOC and above ----
{
  await login('support@geekitek.test', 'support123');
  const acct = await call('/api/accounts', { body: { name: 'CHAIN Support Account' } });
  ok(acct.status === 403, 'support cannot create an account');
  const cust = await call('/api/customers', { body: { account_ids: [1], name: 'CHAIN Support Customer' } });
  ok(cust.status === 403, 'nor a customer — so the form must not offer it to them');
  await login('admin@geekitek.test', 'admin123');
}

// ---- both forms use one implementation ----
//
// The bug was two copies of the same idea, one of which never grew the feature. Assert there is
// now exactly one, and that both callers reach for it.
{
  const js = readFileSync('public/app.js', 'utf8');

  ok((js.match(/function custChainHtml/g) || []).length === 1, 'the chain markup is defined once');
  ok((js.match(/async function resolveCustomerChain/g) || []).length === 1, 'and the resolver once');
  ok((js.match(/custChainHtml\(/g) || []).length >= 3, 'and it is used by more than one form');

  // No form should still be hand-rolling the old markup.
  ok(!js.includes("'ns_customer_id'"), 'the device form no longer has its own lesser customer picker');
  ok(!js.includes("id=\"ss-newcust\""), 'and its host element is gone');

  // The device form's inline new site.
  const devForm = js.slice(js.indexOf('async function formDevice'), js.indexOf('async function saveDevice'));
  ok(devForm.includes('custChainHtml('), 'the device form offers the full customer chain');
  ok(devForm.includes('ss-nsaddr'), 'and a service address for the new site');
  ok(devForm.includes('siteAddrCheck'), 'with the duplicate-building warning');
  ok(devForm.includes('attachCustChain('), 'and wires the pickers through the shared helper');
  ok(devForm.includes('META.accounts'), 'building the account picker from a freshly refreshed list');
  ok(devForm.includes('allowNew: isPriv()'), 'hiding "New customer" from roles that cannot create one');

  // The save path.
  const saveDev = js.slice(js.indexOf('async function saveDevice'), js.indexOf('async function saveDevice') + 2600);
  ok(saveDev.includes('resolveCustomerChain'), 'saving a device resolves the chain');
  ok(saveDev.includes('ns_service_address'), 'and passes the address through to the new site');
  ok(saveDev.includes('CUST_CHAIN_FIELDS'), 'and strips the helper fields before the device payload');
  ok(/delete d\[k\]/.test(saveDev), 'so no chain field leaks into the device record');

  // The site form kept its behaviour while switching to the shared code.
  const siteForm = js.slice(js.indexOf('async function formSite'), js.indexOf('async function onSiteCustomerPick'));
  ok(siteForm.includes('custChainHtml('), 'the site form uses the same markup');
  ok(siteForm.includes('attachCustChain('), 'and the same wiring');
  ok(siteForm.includes('onSiteCustomerPick'), 'while keeping its own on-pick behaviour');
  ok(js.slice(js.indexOf('async function saveSite')).includes('resolveCustomerChain'), 'and the same resolver');
}

// ---- stray chain fields must not reach the device record ----
//
// The chain's inputs live inside the device form, so collect() picks them up. If they were not
// stripped they would be posted to /api/devices; the allow-list there ignores them, but relying on
// that would be luck rather than design.
{
  const dev = await call('/api/devices', { body: {
    name: 'CHAIN Stray Fields', status: 'Stock',
    nc_name: 'should be ignored', na_name: 'should be ignored', customer_id: 999999, account_id: 999999
  } });
  ok(dev.status === 200, 'a device with stray fields still saves');
  const d = (await call('/api/devices/' + dev.json.id)).json;
  ok(!('nc_name' in d) && !('customer_id' in d), 'and none of them are stored on it');
  await call('/api/devices/' + dev.json.id, { method: 'DELETE' });
}

// clean up
{
  const { dev, site, cust, acct } = globalThis.CHAIN;
  await call('/api/devices/' + dev, { method: 'DELETE' });
  await call('/api/sites/' + site, { method: 'DELETE' });
  await call('/api/customers/' + cust, { method: 'DELETE' });
  await call('/api/accounts/' + acct, { method: 'DELETE' });
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
