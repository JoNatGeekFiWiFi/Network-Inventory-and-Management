// Sites as buildings: units within a site, and matching an address to an existing site.
import { addressKey, unitFromAddress, sameAddress } from '../lib/address.js';
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- address normalisation (pure) ----
{
  ok(sameAddress('10738 N 75Th Ave, Peoria, AZ', '10738 north 75th avenue, peoria, arizona'),
    'spelled-out directionals, suffixes and state names match the abbreviated form');
  ok(sameAddress('500 E Main Street', '500 E. Main St.'), 'punctuation and suffix spelling are folded');
  ok(sameAddress('22 SW Oak Blvd', '22 southwest oak boulevard'), 'compound directionals are folded');
  ok(sameAddress('1400 W Elliot Rd Apt 12', '1400 W Elliot Rd Unit 7'), 'two units in one building resolve to the same site');
  ok(sameAddress('10 Oak Ln #4b', '10 Oak Ln #5c'), 'hash-style unit numbers are stripped too');

  // These must NOT match — a wrong match files someone at another address.
  ok(!sameAddress('10738 N 75th Ave, Peoria AZ', '10739 N 75th Ave, Peoria AZ'), 'a different house number does not match');
  ok(!sameAddress('10738 N 75th Ave, Peoria AZ', '10738 S 75th Ave, Peoria AZ'), 'a different directional does not match');
  ok(!sameAddress('500 E Main St, Tempe AZ', '500 E Main St, Mesa AZ'), 'a different city does not match');
  ok(!sameAddress('', ''), 'two blanks are not a match');
  ok(addressKey('Peoria') === '' && addressKey('') === '', 'a single token is too vague to be a key');

  ok(unitFromAddress('1400 W Elliot Rd Apt 12') === '12', 'unit is pulled out of "Apt 12"');
  ok(unitFromAddress('500 Main St Suite B') === 'B', 'and out of "Suite B"');
  ok(unitFromAddress('10 Oak Ln #4b') === '4B', 'and out of "#4b", uppercased');
  ok(unitFromAddress('22 Pine Rd') === null, 'a plain address has no unit');
}

// ---- API ----
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
const cust = (await call('/api/customers')).json[0];
ok(!!cust, 'a customer exists to attach sites to');

const site = (await call('/api/sites', { body: { customer_id: cust.id, name: 'UNIT-TEST Apartments', service_address: '1400 W Elliot Rd, Tempe, AZ' } })).json;
ok(site && site.id, 'site created');

// ---- units ----
{
  for (const label of ['Unit 101', 'Unit 2', 'Unit 10', 'Suite B', 'Suite A'])
    ok((await call(`/api/sites/${site.id}/units`, { body: { label } })).status === 200, `added ${label}`);

  const units = (await call(`/api/sites/${site.id}/units`)).json;
  ok(units.map(u => u.label).join('|') === 'Suite A|Suite B|Unit 2|Unit 10|Unit 101',
    'units sort naturally — Unit 2 before Unit 10, not alphabetically');

  ok((await call(`/api/sites/${site.id}/units`, { body: { label: 'unit 101' } })).status === 409,
    'a duplicate label is rejected regardless of case');
  ok((await call(`/api/sites/${site.id}/units`, { body: { label: '  ' } })).status === 400, 'a blank label is rejected');
  ok((await call('/api/sites/999999/units', { body: { label: 'X' } })).status === 404, 'adding to a missing site is a 404');

  const det = (await call('/api/sites/' + site.id)).json;
  ok(det.is_mdu === 1, 'a site with units is flagged as an MDU');
  ok(det.units.length === 5, 'site detail carries its units');

  const listed = (await call('/api/sites')).json.filter(x => x.id === site.id);
  ok(listed.length === 1, 'the building is ONE row in the sites list, not one per unit');
  ok(listed[0].unit_count === 5, 'and reports how many units it holds');

  // Attach a customer to a unit.
  const u = (await call(`/api/sites/${site.id}/units`)).json[0];
  ok((await call('/api/units/' + u.id, { method: 'PUT', body: { customer_id: cust.id } })).status === 200, 'a unit can be assigned a customer');
  const after = (await call(`/api/sites/${site.id}/units`)).json.find(x => x.id === u.id);
  ok(after.customer_name === cust.name, 'the unit reports its customer by name');
  ok((await call('/api/units/' + u.id, { method: 'PUT', body: { customer_id: null } })).status === 200, 'and can be emptied again');

  ok((await call('/api/units/' + u.id, { method: 'PUT', body: { label: 'Unit 2' } })).status === 409, 'renaming onto an existing label is rejected');
  ok((await call('/api/units/999999', { method: 'PUT', body: { label: 'X' } })).status === 404, 'editing a missing unit is a 404');
  ok((await call('/api/units/' + u.id, { method: 'DELETE' })).status === 200, 'a unit can be removed');
  ok((await call('/api/units/' + u.id, { method: 'DELETE' })).status === 404, 'removing it twice is a 404');
}

// ---- address lookup ----
{
  const hit = (await call('/api/sites/lookup?address=' + encodeURIComponent('1400 w. elliot road, tempe, arizona'))).json;
  ok(hit.matches.length === 1 && hit.matches[0].id === site.id, 'a differently-spelled address finds the existing site');
  ok(hit.matches[0].unit_count === 4, 'the match reports its unit count');

  const withUnit = (await call('/api/sites/lookup?address=' + encodeURIComponent('1400 W Elliot Rd Apt 12, Tempe AZ'))).json;
  ok(withUnit.matches.length === 1, 'a unit-qualified address still finds the building');
  ok(withUnit.unit === '12', 'and surfaces the unit so it can be offered as a label');

  ok((await call('/api/sites/lookup?address=' + encodeURIComponent('999 Nowhere Rd, Nowhere AZ'))).json.matches.length === 0,
    'an unknown address matches nothing, so a new site would be created');
  ok((await call('/api/sites/lookup?address=')).json.matches.length === 0, 'an empty address matches nothing');
  ok((await call('/api/sites/lookup?address=Peoria')).json.key === null, 'a too-vague address returns no key rather than matching everything');

  // The lookup route must not be swallowed by /api/sites/:id.
  ok((await call('/api/sites/lookup?address=x')).status === 200, 'the lookup route is matched before the :id route');
}

// ---- editing an address keeps the match key in step ----
{
  await call('/api/sites/' + site.id, { method: 'PUT', body: { service_address: '2000 N Central Ave, Phoenix, AZ' } });
  ok((await call('/api/sites/lookup?address=' + encodeURIComponent('2000 north central avenue, phoenix, az'))).json.matches.some(m => m.id === site.id),
    'moving a site updates what it matches');
  ok(!(await call('/api/sites/lookup?address=' + encodeURIComponent('1400 W Elliot Rd, Tempe AZ'))).json.matches.some(m => m.id === site.id),
    'and it no longer matches the old address');
}

// ---- a new account is immediately assignable ----
{
  // The site form built its account picker from a list cached at sign-in, so an account created
  // mid-session could not be selected until a full page reload.
  const name = 'UNIT-TEST Acct ' + Date.now();
  const acct = (await call('/api/accounts', { body: { name, status: 'Active' } })).json;
  ok(acct && acct.id, 'account created');
  const meta = (await call('/api/meta')).json;
  ok(meta.accounts.some(a => a.id === acct.id), 'it appears in /api/meta straight away, with no reload');
}

// ---- deleting the site takes its units with it ----
{
  const s2 = (await call('/api/sites', { body: { customer_id: cust.id, name: 'UNIT-TEST Cascade', service_address: '7 Cascade Way, Tempe, AZ' } })).json;
  await call(`/api/sites/${s2.id}/units`, { body: { label: 'Unit 1' } });
  ok((await call(`/api/sites/${s2.id}/units`)).json.length === 1, 'unit created on the second site');
  await call('/api/sites/' + s2.id, { method: 'DELETE' });
  ok((await call(`/api/sites/${s2.id}/units`)).json.length === 0, 'deleting the site removes its units rather than orphaning them');
}

// ---- role gating ----
{
  cookie = ''; await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await call(`/api/sites/${site.id}/units`, { body: { label: 'Nope' } })).status === 403, 'support cannot add units');
  ok((await call(`/api/sites/${site.id}/units`)).status === 200, 'but can read them');
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
