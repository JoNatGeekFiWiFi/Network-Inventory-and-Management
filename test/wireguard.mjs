// WireGuard alongside ZeroTier, managed without SSH.
//
// Two things get the hardest treatment here.
//
// The first is the subnet maths. An overlap between the WireGuard range and the ZeroTier range
// does not fail loudly — it hands two devices the same address and shows up weeks later as
// "the tunnel is flaky". So overlap, containment and allocation are tested exhaustively.
//
// The second is command construction. The hub runs `wg` as root via sudo, and the public keys it
// passes come from device records a user can influence. Every value is validated before it is used,
// and the tests include the shapes an attacker would try.
import {
  parseCidr, overlaps, contains, supernetOf, carveRange, planOverlay,
  nextFreeAddress, hubAddress, capacity, isPrivate, inRange
} from '../lib/ipam.js';
import {
  isWgKey, addPeerArgs, removePeerArgs, showDumpArgs, parseWgDump, diffPeers, createHub
} from '../lib/wghub.js';
import { readFileSync } from 'node:fs';

const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const KEY = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
const KEY2 = 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=';

// ---- CIDR maths ----
{
  ok(parseCidr('10.147.20.0/24').size === 256, 'a /24 holds 256 addresses');
  // JavaScript shifts modulo 32, so `0xffffffff << 32` is not 0. Getting this wrong turns a
  // default route into a single host and every containment test silently inverts.
  ok(parseCidr('0.0.0.0/0').size === 4294967296, 'a /0 is the whole address space, not a /32');
  ok(parseCidr('10.147.20.999/24') === null, 'an impossible octet is rejected');
  ok(parseCidr('not an address') === null, 'so is nonsense');
  ok(parseCidr('10.1.1.5').bits === 32, 'a bare address is a /32');
  ok(parseCidr('10.147.20.5/24').network === parseCidr('10.147.20.0/24').network, 'a host address normalises to its network');

  ok(overlaps('10.147.20.0/24', '10.147.20.0/24'), 'identical ranges overlap');
  ok(!overlaps('10.147.20.0/24', '10.147.21.0/24'), 'ADJACENT ranges do not overlap — this is the whole design');
  ok(overlaps('10.147.0.0/16', '10.147.20.0/24'), 'a contained range overlaps its container');
  ok(overlaps('10.147.20.5/32', '10.147.20.0/24'), 'a single address overlaps the range holding it');
  ok(!overlaps('10.147.20.0/24', '192.168.1.0/24'), 'unrelated ranges do not overlap');

  ok(contains('10.147.0.0/16', '10.147.21.0/24'), 'a /16 contains a /24 inside it');
  ok(!contains('10.147.21.0/24', '10.147.0.0/16'), 'and not the other way round');
  ok(inRange('10.147.21.0/24', '10.147.21.99'), 'an address inside the range is recognised');
  ok(!inRange('10.147.21.0/24', '10.147.22.1'), 'and one outside it is not');

  ok(supernetOf(['10.147.20.0/24', '10.147.21.0/24']) === '10.147.20.0/23', 'two adjacent /24s make a /23');
  ok(supernetOf(['10.147.20.0/24']) === '10.147.20.0/24', 'one range is its own supernet');
  ok(contains(supernetOf(['10.147.20.0/24', '10.200.5.0/24']), '10.200.5.0/24'), 'a distant pair still produces a covering block');

  ok(isPrivate('10.147.21.0/24') && isPrivate('192.168.1.0/24') && isPrivate('172.16.5.0/24'), 'RFC 1918 ranges are recognised');
  ok(!isPrivate('8.8.8.0/24'), 'and public space is not');
}

// ---- carving a range that cannot collide ----
{
  const wg = carveRange('10.147.0.0/16', ['10.147.20.0/24'], 24);
  ok(!!wg && !overlaps(wg, '10.147.20.0/24'), `carved ${wg}, which avoids ZeroTier`);
  ok(contains('10.147.0.0/16', wg), 'and stays inside the container');

  // Every /24 taken: it must give up rather than return something that overlaps.
  const busy = Array.from({ length: 256 }, (_, i) => `10.147.${i}.0/24`);
  ok(carveRange('10.147.0.0/16', busy, 24) === null, 'a full container yields nothing rather than a collision');
  ok(carveRange('10.147.20.0/24', [], 16) === null, 'a range larger than its container is refused');
}

// ---- the plan ----
{
  const p = planOverlay(['10.147.20.0/24']);
  ok(p.ok, 'a plan is produced from the ZeroTier default range');
  ok(!overlaps(p.wg_range, '10.147.20.0/24'), 'the WireGuard range does not overlap ZeroTier');
  ok(contains(p.supernet, '10.147.20.0/24') && contains(p.supernet, p.wg_range),
    'and the supernet contains both, which is what makes them route to each other');
  ok(p.notes.length >= 2, 'the reasoning is returned, not just the answer');

  // Several ZeroTier ranges, as a real network with extra routes would have.
  const multi = planOverlay(['10.147.20.0/24', '10.147.22.0/24']);
  ok(!overlaps(multi.wg_range, '10.147.20.0/24') && !overlaps(multi.wg_range, '10.147.22.0/24'),
    'every ZeroTier range is avoided, not just the first');

  // A WireGuard range that already works must not be moved: renumbering a live overlay is
  // disruptive and should never happen as a side effect of asking for advice.
  const kept = planOverlay(['10.147.20.0/24'], { existingWg: '10.147.30.0/24' });
  ok(kept.wg_range === '10.147.30.0/24' && kept.kept, 'a non-clashing existing range is left alone');

  // One that DOES clash must be moved, and must say why.
  const moved = planOverlay(['10.147.20.0/24'], { existingWg: '10.147.20.128/25' });
  ok(moved.wg_range !== '10.147.20.128/25', 'an overlapping range is moved');
  ok(moved.notes.some(n => /overlaps/i.test(n)), 'and the reason is stated');
  ok(moved.notes.some(n => /re-provision/i.test(n)), 'including that devices will need re-provisioning');

  const standalone = planOverlay([]);
  ok(standalone.ok && standalone.standalone, 'with no ZeroTier at all it still proposes something usable');
}

// ---- addresses ----
{
  ok(hubAddress('10.147.21.0/24') === '10.147.21.1', 'the hub takes .1');
  ok(nextFreeAddress('10.147.21.0/24', ['10.147.21.1']) === '10.147.21.2', 'allocation skips the network and the hub');
  ok(nextFreeAddress('10.147.21.0/24', ['10.147.21.1', '10.147.21.2', '10.147.21.4']) === '10.147.21.3', 'and fills gaps');
  ok(nextFreeAddress('10.147.21.0/30', ['10.147.21.1', '10.147.21.2']) === null, 'a full range returns nothing rather than the broadcast address');
  const cap = capacity('10.147.21.0/24', ['10.147.21.1', '10.147.21.5']);
  ok(cap.total === 254 && cap.used === 2 && cap.free === 252, 'capacity excludes network and broadcast');
}

// ---- key validation is the injection boundary ----
{
  ok(isWgKey(KEY), 'a real WireGuard key is accepted');
  ok(!isWgKey('short='), 'a short string is not');
  ok(!isWgKey(null) && !isWgKey(undefined) && !isWgKey(42), 'nor is a non-string');
  // These are what an attacker puts in a device record hoping it reaches a root shell.
  for (const evil of ['a; rm -rf / #', '`id`', '$(reboot)', 'x" ; wg set wg0 peer y remove #', '../../etc/passwd']) {
    ok(!isWgKey(evil), `refuses ${JSON.stringify(evil.slice(0, 24))}`);
    ok(addPeerArgs('wg0', { publicKey: evil, allowedIps: '10.147.21.5/32' }) === null, 'and builds no command from it');
  }
  ok(addPeerArgs('wg0; reboot', { publicKey: KEY, allowedIps: '10.147.21.5/32' }) === null, 'a crafted interface name builds nothing');
  ok(addPeerArgs('wg0', { publicKey: KEY, allowedIps: '10.0.0.1/32; reboot' }) === null, 'nor crafted allowed-ips');
  ok(addPeerArgs('wg0', { publicKey: KEY, allowedIps: '10.0.0.1/32', keepalive: '25; id' }) === null, 'nor a crafted keepalive');
  ok(removePeerArgs('wg0', 'nope') === null, 'removal validates too');

  // The command is an argv array, never a string, so there is no shell for anything to escape into.
  const args = addPeerArgs('wg0', { publicKey: KEY, allowedIps: '10.147.21.5/32' });
  ok(Array.isArray(args), 'commands are argv arrays');
  ok(args.join(' ') === `set wg0 peer ${KEY} allowed-ips 10.147.21.5/32 persistent-keepalive 25`, 'and are built exactly as wg expects');
}

// ---- reading the hub ----
{
  const dump = [
    'hubPriv=\thubPub=\t51820\toff',
    `${KEY}\t(none)\t203.0.113.9:51820\t10.147.21.5/32\t${Math.floor(Date.now() / 1000) - 30}\t1024\t2048\t25`,
    `${KEY2}\t(none)\t(none)\t10.147.21.6/32\t0\t0\t0\toff`
  ].join('\n');
  const d = parseWgDump(dump);

  ok(d.iface.listen_port === 51820, 'the listen port is read');
  ok(!('private_key' in d.iface), "the hub's private key is never returned, even internally");
  ok(d.iface.has_private_key === true, 'only the fact that it has one');
  ok(d.peers.length === 2, 'both peers are read');
  ok(d.peers[0].online === true, 'a peer that handshook 30 seconds ago is online');
  // A peer that has NEVER connected must not be reported as last seen in 1970 — that reads as a
  // broken tunnel and sends someone to site for nothing.
  ok(d.peers[1].last_handshake === null, 'a peer that has never connected has no handshake time');
  ok(d.peers[1].online === false, 'and is not online');
  ok(parseWgDump('').peers.length === 0, 'an empty dump is handled');
  ok(parseWgDump(null).peers.length === 0, 'so is no dump at all');
}

// ---- working out what to change ----
{
  const actual = parseWgDump([
    'p=\tP=\t51820\toff',
    `${KEY}\t(none)\t(none)\t10.147.21.5/32\t0\t0\t0\t25`
  ].join('\n')).peers;

  const same = diffPeers([{ publicKey: KEY, allowedIps: '10.147.21.5/32' }], actual);
  ok(!same.add.length && !same.update.length && !same.remove.length, 'a hub that already matches needs no changes');

  const moved = diffPeers([{ publicKey: KEY, allowedIps: '10.147.21.9/32', name: 'A' }], actual);
  ok(moved.update.length === 1, 'a changed address is an update');

  const added = diffPeers([{ publicKey: KEY, allowedIps: '10.147.21.5/32' }, { publicKey: KEY2, allowedIps: '10.147.21.6/32' }], actual);
  ok(added.add.length === 1, 'a new device is an addition');

  ok(diffPeers([], actual).remove[0] === KEY, 'a device removed from the database is removed from the hub');
  ok(diffPeers([{ publicKey: 'garbage', allowedIps: '10.0.0.1/32' }], actual).add.length === 0,
    'a device with an unusable key is skipped rather than crashing the sync');
}

// ---- the hub, driven without WireGuard installed ----
{
  const dump = ['p=\tP=\t51820\toff', `${KEY}\t(none)\t(none)\t10.147.21.5/32\t0\t0\t0\t25`].join('\n');
  const calls = [];
  const hub = createHub({
    iface: 'wg0',
    exec: async (bin, args) => {
      calls.push({ bin: bin.split('/').pop(), args });
      return args[0] === 'show' ? { ok: true, stdout: dump } : { ok: true, stdout: '' };
    }
  });

  const st = await hub.status();
  ok(st.available && st.peers.length === 1, 'the hub reports its peers');

  calls.length = 0;
  const r = await hub.sync([
    { publicKey: KEY, allowedIps: '10.147.21.5/32', name: 'unchanged' },
    { publicKey: KEY2, allowedIps: '10.147.21.6/32', name: 'new' }
  ]);
  ok(r.ok && r.applied.added === 1 && r.applied.removed === 0, 'sync adds only what is missing');
  // Without a save, everything added since boot vanishes on restart with no error anywhere.
  ok(calls.some(c => c.bin === 'wg-quick' && c.args[0] === 'save'), 'and writes the result to disk so it survives a reboot');

  calls.length = 0;
  await hub.sync([{ publicKey: KEY, allowedIps: '10.147.21.5/32' }]);
  ok(calls.every(c => c.args[0] !== 'save'), 'a sync with nothing to do does not rewrite the config');

  // Every failure mode gets an instruction, not a stack trace.
  for (const [err, expect] of [
    ['sudo: a password is required', /not permitted|setup/i],
    ['execvp failed: No such file or directory', /not installed/i],
    ['Unable to access interface: No such device', /does not exist/i]
  ]) {
    const s = await createHub({ exec: async () => ({ ok: false, error: err }) }).status();
    ok(!s.available && expect.test(s.reason), `"${err.slice(0, 28)}…" explains what to do`);
  }
}

// ---- the API ----
await login('admin@geekitek.test', 'admin123');
{
  const st = await call('/api/wireguard/status');
  ok(st.status === 200, 'status answers even with no WireGuard on this machine');
  ok(st.json.hub.available === false, 'and says the hub is not available here');
  ok(/setup|installed|permitted|exist/i.test(st.json.hub.reason || ''), 'with a reason a person can act on');
  ok(typeof st.json.setup_command === 'string', 'and the command that fixes it');

  const plan = await call('/api/wireguard/plan');
  ok(plan.status === 200 && plan.json.wg_range, 'a plan is produced without ZeroTier credentials');
  ok(Array.isArray(plan.json.notes) && plan.json.notes.length > 0, 'with its reasoning');

  // Applying a plan.
  const applied = await call('/api/wireguard/plan/apply', { body: { wg_range: '10.147.21.0/24', supernet: '10.147.20.0/23' } });
  ok(applied.status === 200, 'a plan can be applied');
  ok(applied.json.hub_address === '10.147.21.1', 'and reports the hub address it implies');

  // The guards that stop a silent collision.
  ok((await call('/api/wireguard/plan/apply', { body: { wg_range: 'nonsense' } })).status === 400, 'a malformed range is refused');
  ok((await call('/api/wireguard/plan/apply', { body: { wg_range: '10.147.21.0/24', supernet: '192.168.0.0/16' } })).status === 400,
    'a supernet that does not contain the range is refused');
  const clash = await call('/api/wireguard/plan/apply', {
    body: { wg_range: '10.147.20.128/25', zt_ranges: ['10.147.20.0/24'] }
  });
  ok(clash.status === 400 && /overlap/i.test(clash.json.error), 'and a range overlapping ZeroTier is refused even when asked directly');

  // The subnet survived the refusals.
  ok((await call('/api/wireguard/status')).json.subnet === '10.147.21.0/24', 'the applied subnet is the one that stuck');
}

// ---- provisioning a device ----
{
  const acct = (await call('/api/accounts')).json[0];
  const site = (await call('/api/sites', { body: { account_id: acct.id, name: 'WG Test Site', service_address: '1 WG Way, Tempe, AZ' } })).json;
  const dev = (await call('/api/devices', { body: { name: 'WG Test Router', status: 'Deployed', assigned_type: 'site', assigned_site_id: site.id } })).json;

  const p = await call(`/api/wireguard/devices/${dev.id}/provision`, { body: {} });
  ok(p.status === 200, 'a device provisions');
  ok(inRange('10.147.21.0/24', p.json.address), 'and gets an address inside the planned subnet');
  ok(p.json.address !== '10.147.21.1', 'never the hub address');
  ok(!!p.json.public_key, 'with a public key');

  const d = (await call('/api/devices/' + dev.id)).json;
  ok(d.mgmt_overlay === 'WireGuard', 'the device is switched to WireGuard');
  ok(d.has_wg_private_key !== false, 'and holds a private key');
  ok(!('wg_private_key' in d), 'which is never returned in a normal read');

  // Provisioning again must not renumber a device that is working.
  const again = await call(`/api/wireguard/devices/${dev.id}/provision`, { body: {} });
  ok(again.json.address === p.json.address && again.json.reused_address, 're-provisioning keeps a still-valid address');

  // A second device must not be given the first one's address.
  const dev2 = (await call('/api/devices', { body: { name: 'WG Test Router 2', status: 'Stock' } })).json;
  const p2 = await call(`/api/wireguard/devices/${dev2.id}/provision`, { body: {} });
  ok(p2.json.address !== p.json.address, 'a second device gets a different address');

  // The config a router would receive.
  const cfg = await call(`/api/wireguard/devices/${dev.id}/config`);
  ok(cfg.status === 200, 'the config downloads');
  ok(cfg.json.config.includes('[Interface]') && cfg.json.config.includes('[Peer]'), 'and is a real WireGuard config');
  ok(cfg.json.config.includes(p.json.address), 'carrying the device address');
  // The supernet, not just the WireGuard range — otherwise the device cannot reach ZeroTier.
  ok(cfg.json.config.includes('10.147.20.0/23'), 'and AllowedIPs covering both overlays');

  // Reading a config is a credential read and must be audited.
  const audit = (await call('/api/audit')).json;
  ok(audit.some(a => a.action === 'credential_read' && /WireGuard/.test(a.details || '')), 'downloading a config is audited');

  ok((await call(`/api/wireguard/devices/${dev.id}/deprovision`, { body: {} })).status === 200, 'a device can be taken off WireGuard');
  ok(!(await call('/api/devices/' + dev.id)).json.mgmt_address, 'and loses its address');

  await call('/api/devices/' + dev.id, { method: 'DELETE' });
  await call('/api/devices/' + dev2.id, { method: 'DELETE' });
  await call('/api/sites/' + site.id, { method: 'DELETE' });
}

// ---- role gating ----
{
  await login('support@geekitek.test', 'support123');
  for (const [path, body] of [['/api/wireguard/status', undefined], ['/api/wireguard/plan', undefined]])
    ok((await call(path, { body })).status === 403, `support cannot reach ${path}`);
  ok((await call('/api/wireguard/sync', { body: {} })).status === 403, 'nor sync the hub');
  ok((await call('/api/wireguard/plan/apply', { body: { wg_range: '10.0.0.0/24' } })).status === 403, 'nor renumber the overlay');
  await login('admin@geekitek.test', 'admin123');
}

// ---- the setup script says what it does ----
{
  const sh = readFileSync('deploy/wireguard-setup.sh', 'utf8');
  ok(/NOPASSWD: \/usr\/bin\/wg, \/usr\/bin\/wg-quick/.test(sh), 'the sudo grant is exactly two commands');
  ok(!/NOPASSWD: ALL/.test(sh), 'and never blanket root');
  ok(/visudo -cf/.test(sh), 'the sudoers file is validated before being left in place');
  ok(/EXISTING_PEERS/.test(sh), 're-running preserves peers already deployed');
  ok(/ip_forward/.test(sh), 'forwarding is enabled, which is what links the two overlays');
  ok(/FORWARD -i %i -o \$ZT_IFACE/.test(sh), 'and traffic is allowed between WireGuard and ZeroTier');
  ok(/sqlite3 "\$DB_PATH"/.test(sh), 'the hub key is read from the database, not typed on a command line');
  ok(!/PrivateKey=\$1|--private-key/.test(sh), 'so it never appears in shell history or ps output');
  ok(/wg syncconf/.test(sh), 'an already-running interface is reloaded rather than restarted');
}

// ---- the UI exposes it ----
{
  const js = readFileSync('public/app.js', 'utf8');
  ok(js.includes('async function wgStatus'), 'Settings shows the hub status');
  ok(js.includes('wgStatus();'), 'and loads it when the page renders');
  ok(js.includes('async function wgPlan'), 'there is a plan action');
  ok(js.includes('would_renumber'), 'which warns before moving an existing range');
  ok(js.includes('devices_affected'), 'and says how many devices that would affect');
  ok(js.includes('async function wgSync'), 'there is a sync action');
  ok(js.includes('async function wgPush'), 'and a push-to-router action');
  ok(js.includes('Plan from ZeroTier') && js.includes('Sync hub'), 'both are on the Settings page');
  ok(js.includes('Push to router'), 'and push is on the device page');
  // The hub being unreachable must be stated, not silently rendered as "0 peers".
  ok(js.includes('Hub not reachable'), 'an unreachable hub says so plainly');
  ok(js.includes('in sync') && js.includes('missing'), 'and drift between the database and the hub is visible');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
