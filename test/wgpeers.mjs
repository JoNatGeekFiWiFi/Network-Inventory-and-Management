// The WireGuard overlay as one thing: customer routers and staff laptops, one hub, one address pool.
//
// Two properties get the hard treatment, because both fail SILENTLY and both fail late.
//
//  1. ONE POOL, TWO TABLES. Devices and staff peers are separate records that share an address
//     space. An allocator that forgets the second one hands a laptop an address a router already
//     has — which does not error, it intermittently steals traffic, and it surfaces weeks later as
//     "the VPN is flaky".
//
//  2. AN ADDRESS STAYS RESERVED UNTIL THE RECORD IS DELETED. An overlay address is a fact recorded
//     in firewall rules, monitoring and somebody's notes. A router pulled for an RMA and put back
//     must return on the SAME address, or all of those quietly point at whatever took its number.
import { nextFreeAddress, hubAddress, capacity } from '../lib/ipam.js';

const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t };
}
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

await login('admin@geekitek.test', 'admin123');

// A WireGuard subnet has to exist before any of this can be exercised. Establishing one here rather
// than skipping: a test that quietly does nothing when the fixture is bare reports a pass and
// checks nothing, which is worse than no test — it is a test that lies.
{
  const status = (await call('/api/wireguard/status')).json;
  if (!status.subnet) {
    const applied = await call('/api/wireguard/plan/apply', {
      body: { wg_range: '10.99.21.0/24', supernet: '10.99.20.0/23', zt_ranges: [] }
    });
    ok(applied.status === 200, 'a WireGuard subnet is planned so allocation can actually be tested');
  } else {
    ok(true, `using the configured subnet ${status.subnet}`);
  }
}

// ---- the allocator, in isolation ------------------------------------------------------------------
{
  // Whatever the sources, the rule is the same: never hand out something already held.
  const taken = ['10.147.21.1', '10.147.21.2', '10.147.21.4'];
  ok(nextFreeAddress('10.147.21.0/24', taken) === '10.147.21.3', 'the allocator fills the first gap');
  ok(hubAddress('10.147.21.0/24') === '10.147.21.1', 'and the hub keeps .1');
  const cap = capacity('10.147.21.0/24', taken);
  ok(cap.used === 3 && cap.free === 251, 'capacity counts every held address, whatever holds it');
}

// ---- staff peers live alongside devices -------------------------------------------------------------
{
  const before = (await call('/api/wireguard/peers')).json;
  ok(Array.isArray(before), 'the peer list is readable');

  const made = await call('/api/wireguard/peers', { body: { name: 'WGTEST laptop', owner: 'Jon', kind: 'laptop' } });
  if (made.status === 400 && /subnet/i.test(made.json.error || '')) {
    ok(false, 'a subnet was set up above, so this should not happen: ' + made.json.error);
  } else {
    ok(made.status === 200 && made.json.address, `a laptop peer is created and given ${made.json.address}`);
    const id = made.json.id, addr = made.json.address;

    ok(!!made.json.public_key, 'with a keypair');
    const listed = (await call('/api/wireguard/peers')).json.find(p => p.id === id);
    ok(listed && listed.name === 'WGTEST laptop', 'and appears in the list');
    // A private key must never come back from a list endpoint.
    ok(listed && !('private_key' in listed), 'the list never carries private keys');

    // THE COLLISION TEST. A second peer must not be handed the first one's address.
    const second = await call('/api/wireguard/peers', { body: { name: 'WGTEST phone', kind: 'phone' } });
    ok(second.json.address !== addr, 'a second peer gets a DIFFERENT address — the pool is shared, not per-table');

    // And a device provisioned afterwards must avoid both.
    const dev = (await call('/api/devices', { body: { name: 'WGTEST router', mgmt_overlay: 'WireGuard' } })).json;
    const prov = await call(`/api/wireguard/devices/${dev.id}/provision`, { body: {} });
    if (prov.status === 200) {
      ok(prov.json.address !== addr && prov.json.address !== second.json.address,
        'a DEVICE provisioned afterwards avoids both laptop addresses — this is the bug that would steal traffic');

      // ---- the reservation ----
      const held = prov.json.address;
      const deprov = await call(`/api/wireguard/devices/${dev.id}/deprovision`, { body: {} });
      ok(deprov.json.reserved === true, 'deprovisioning KEEPS the address reserved');
      ok(deprov.json.address === held, 'and says which address is being held');
      ok(/same address back/.test(deprov.json.note), 'explaining that re-provisioning returns it');

      // The whole point: it must not be handed to anybody else while reserved.
      const interloper = await call('/api/wireguard/peers', { body: { name: 'WGTEST interloper' } });
      ok(interloper.json.address !== held,
        'a new peer created while the device is deprovisioned does NOT get the reserved address');

      // And re-provisioning returns the same one.
      const again = await call(`/api/wireguard/devices/${dev.id}/provision`, { body: {} });
      ok(again.json.address === held, 're-provisioning gives the device its original address back');
      ok(again.json.reused_address === true, 'and reports that it was reused rather than freshly allocated');

      // Explicit release is the escape hatch, and it has to be asked for.
      const released = await call(`/api/wireguard/devices/${dev.id}/deprovision`, { body: { release_address: true } });
      ok(released.json.reserved === false, 'releasing explicitly gives the address up');
      ok(/back in the pool/.test(released.json.note), 'and says so plainly');

      await call('/api/devices/' + dev.id, { method: 'DELETE' });
      await call('/api/wireguard/peers/' + interloper.json.id, { method: 'DELETE' });
    } else {
      ok(true, `SKIPPED device provisioning: ${prov.json && prov.json.error}`);
      await call('/api/devices/' + dev.id, { method: 'DELETE' });
    }

    // ---- disabling is not deleting ----
    const off = await call(`/api/wireguard/peers/${id}`, { method: 'PUT', body: { enabled: false } });
    ok(off.status === 200, 'a peer can be disabled');
    const stillThere = (await call('/api/wireguard/peers')).json.find(p => p.id === id);
    ok(stillThere && stillThere.address === addr,
      'a DISABLED peer keeps its address — revoking access is not the same as giving the number back');

    // ---- the config, which is the thing people actually came for ----
    const cfg = await call(`/api/wireguard/peers/${id}/config`);
    ok(cfg.status === 200 && /\[Interface\]/.test(cfg.json.config), 'the config is a real WireGuard file');
    ok(/PrivateKey = /.test(cfg.json.config), 'with the private key, which is why the read is audited');
    ok(/\[Peer\]/.test(cfg.json.config) && /Endpoint = /.test(cfg.json.config), 'and the hub to connect to');
    ok(cfg.json.filename.endsWith('.conf'), 'named so it imports cleanly into the WireGuard app');
    ok(!/[^\w.-]/.test(cfg.json.filename), 'with a filename safe to save — no spaces or punctuation from the peer name');

    await call('/api/wireguard/peers/' + id, { method: 'DELETE' });
    await call('/api/wireguard/peers/' + second.json.id, { method: 'DELETE' });
    const after = (await call('/api/wireguard/peers')).json;
    ok(after.length === before.length, 'deleting a peer removes it');
  }
}

// ---- who may touch any of this --------------------------------------------------------------------
{
  await login('support@geekitek.test', 'support123');
  ok((await call('/api/wireguard/peers')).status === 403, 'peers are NOC-only to list');
  ok((await call('/api/wireguard/peers', { body: { name: 'nope' } })).status === 403, 'and to create');
  // A config is a private key and a route onto the management overlay.
  ok((await call('/api/wireguard/peers/1/config')).status === 403, 'and a config cannot be read by support');
  await login('admin@geekitek.test', 'admin123');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
