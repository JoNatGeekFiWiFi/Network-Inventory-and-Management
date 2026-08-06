// Circuit consolidation: pop_circuits merged into the single `circuits` inventory.
// (The one-time legacy-data migration itself is covered by test/migration.mjs.)
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; method = method === 'GET' ? 'POST' : method; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
const pops = (await call('/api/pops')).json;
const sites = (await call('/api/sites')).json;
const accts = (await call('/api/meta')).json.accounts;

// options expose all four endpoint types
const o = (await call('/api/circuits-options')).json;
ok(Array.isArray(o.accounts) && o.accounts.length > 0, 'circuits-options exposes accounts');
ok(Array.isArray(o.carriers) && Array.isArray(o.sites) && Array.isArray(o.pops), 'circuits-options exposes sites/pops/carriers');

// account -> pop (the shape POP upstream feeds migrate into)
let r = await call('/api/circuits', { method: 'POST', body: { a_type: 'account', a_ref_id: accts[0].id, z_type: 'pop', z_ref_id: pops[0].id, circuit_id: 'COX-1', bandwidth: '1 Gbps' } });
ok(r.status === 200, 'can create account->pop upstream circuit');
const upId = r.json.id;
const c = (await call('/api/circuits/' + upId)).json;
ok(c.a_name === accts[0].name, 'account endpoint resolves its name');
ok(c.a_href === '#/account/' + accts[0].id, 'account endpoint links to the account page');

// at least one end must be ours
ok((await call('/api/circuits', { method: 'POST', body: { a_type: 'account', a_ref_id: accts[0].id, z_type: 'carrier', z_ref_id: 1 } })).status === 400, 'account<->carrier rejected (no internal end)');
ok((await call('/api/circuits', { method: 'POST', body: { a_type: 'pop', a_ref_id: pops[0].id, z_type: 'pop', z_ref_id: pops[0].id } })).status === 400, 'self-loop rejected');

// legacy POP-circuit API is gone
ok((await call('/api/pops/' + pops[0].id + '/circuits', { method: 'POST', body: { source_type: 'pop', source_pop_id: pops[0].id } })).status === 404, 'legacy POST /api/pops/:id/circuits removed');
ok((await call('/api/pops/' + pops[0].id)).json.circuits === undefined, 'POP GET no longer returns legacy .circuits');

// POP page finds its upstream through the unified inventory
const byPop = (await call('/api/circuits?ref=pop:' + pops[0].id)).json;
ok(byPop.some(x => x.id === upId), 'ref=pop filter surfaces the upstream circuit');

// patch panel circuit dropdown for a POP is fed by circuits
const pc = (await call('/api/patch/pop/' + pops[0].id)).json;
ok(pc.circuits.some(x => x.id === upId), 'patch panel POP circuit options come from circuits');

// a site WAN uplink can link to a circuit record
await call('/api/sites/' + sites[0].id + '/connections', { method: 'POST', body: { role: 'Primary', served_type: 'pop', served_pop_id: pops[0].id, circuit_ref_id: upId, bandwidth: '1G' } });
const sf = (await call('/api/sites/' + sites[0].id)).json;
const linked = sf.connections.find(x => x.circuit_ref_id === upId);
ok(linked && linked.circuit && linked.circuit.id === upId, 'site connection links to a circuit record');

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
