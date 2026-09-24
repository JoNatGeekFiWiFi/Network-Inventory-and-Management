// OpenWrt writes: blocklist, DHCP, reboot, firmware, packages, WireGuard, batch firewall rules.
//
// Driven through the real driver against a pretend router that implements UCI the way rpcd does
// (staged changes, apply with rollback, confirm), so the exact sequence of calls is exercised.
import { createDriver, parseWirelessStatus } from '../lib/drivers/openwrt.js';
import { blocklistPlan, dhcpPlan, annotateLeases, wireguardPlan, firewallRuleFromBatch, PROTECTED_PACKAGES, BL_SET, BL_RULE } from '../lib/drivers/openwrt-write.js';
import { capsFor } from '../lib/drivers/index.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

function fakeRouter(initial = {}) {
  const committed = JSON.parse(JSON.stringify({ firewall: {}, dhcp: {}, network: {}, ...initial }));
  let staged = JSON.parse(JSON.stringify(committed));
  let changes = [];
  const log = [];
  const files = {};
  let validate = { valid: true, forceable: true, tests: { fwtool_signature: true, fwtool_device_match: true } };
  const call = async (object, method, params = {}) => {
    log.push(object + '.' + method);
    const k = object + '.' + method;
    if (k === 'uci.get') return { ok: true, data: { values: staged[params.config] || {} } };
    if (k === 'uci.changes') return { ok: true, data: { changes: changes.length ? { x: changes.map(c => [c, 'x']) } : {} } };
    if (k === 'uci.add') { staged[params.config][params.name] = { '.type': params.type, ...params.values }; changes.push('add ' + params.name); return { ok: true, data: {} }; }
    if (k === 'uci.set') { Object.assign(staged[params.config][params.section], params.values); changes.push('set ' + params.section); return { ok: true, data: {} }; }
    if (k === 'uci.delete') { delete staged[params.config][params.section]; changes.push('del ' + params.section); return { ok: true, data: {} }; }
    if (k === 'uci.revert') { staged = JSON.parse(JSON.stringify(committed)); changes = []; return { ok: true, data: {} }; }
    if (k === 'uci.apply') return { ok: true, data: {} };
    if (k === 'uci.confirm') { Object.assign(committed, JSON.parse(JSON.stringify(staged))); changes = []; return { ok: true, data: {} }; }
    if (k === 'system.board') return { ok: true, data: { model: 'Test', release: { version: '23.05.3', distribution: 'OpenWrt' } } };
    if (k === 'system.reboot') return { ok: false, unreachable: true, error: 'connection closed' };
    if (k === 'system.validate_firmware_image') return { ok: true, data: validate };
    if (k === 'rpc-sys.upgrade_start') return { ok: true, data: {} };
    if (k === 'network.get_proto_handlers') return { ok: true, data: { static: {}, dhcp: {}, wireguard: {} } };
    return { ok: false, error: 'no such method ' + k };
  };
  const run = async (argv, opts = {}) => {
    log.push('run ' + argv.join(' '));
    if (argv[0] === 'dd') { files['/tmp/firmware.bin'] = opts.stdin; return { ok: true, data: '' }; }
    if (argv[0] === 'wc') return { ok: true, data: `${(files[argv[2]] || []).length} ${argv[2]}` };
    if (argv[0] === 'rm') { delete files[argv[2]]; return { ok: true, data: '' }; }
    if (argv[0] === 'opkg') return argv[1] === 'install' && argv[2] === 'nonexistent-pkg' ? { ok: false, error: 'Unknown package' } : { ok: true, data: 'Installing ' + (argv[2] || '') };
    return { ok: true, data: '' };
  };
  return { transport: { kind: 'test', call, run }, committed: () => committed, log, files, setValidate: (v) => { validate = v; }, dirty: () => { changes.push('someone else'); } };
}
const drv = (r, dev = {}) => createDriver({ mgmt_address: '10.1.1.1', admin_password: 'x', ...dev }, { transport: r.transport });

// ---- the Wi-Fi section fix ----
{
  const f = JSON.parse(readFileSync(new URL('./fixtures/katalyst-k500a.json', import.meta.url)));
  ok(parseWirelessStatus(f.wireless_status).map(x => x.section).join() === 'wifi2g,wifi5g', 'Wi-Fi networks now carry their UCI section — the edit form has something to send');
}

// ---- capabilities ----
{
  const c = capsFor('openwrt');
  ok(['dhcpWrite', 'blocklistPush', 'firmware', 'reboot', 'wireguardPush', 'packages'].every(x => c.includes(x)), 'OpenWrt now claims DHCP edit, blocklist, firmware, reboot, WireGuard and packages');
}

// ---- blocklist ----
{
  ok(blocklistPlan({}, []).length === 0, 'nothing to block, nothing there → no change');
  const add = blocklistPlan({}, ['203.0.113.5', '198.51.100.0/24', 'junk']);
  ok(add.length === 2 && add[0].values.entry.join() === '198.51.100.0/24,203.0.113.5' && add[1].values.target === 'DROP', 'first push: an ipset of the addresses (junk dropped) and one DROP rule');
  const fw = { [BL_SET]: { '.type': 'ipset', entry: ['198.51.100.0/24', '203.0.113.5'] }, [BL_RULE]: { '.type': 'rule' } };
  ok(blocklistPlan(fw, ['203.0.113.5', '198.51.100.0/24']).length === 0, 'same list → nothing staged, nothing applied');
  ok(blocklistPlan(fw, ['203.0.113.9']).map(o => o.op).join() === 'delete,add', 'changed list → the set is replaced, the rule kept');
  ok(blocklistPlan(fw, []).every(o => o.op === 'delete') && blocklistPlan(fw, []).length === 2, 'emptied list → both removed');

  const r = fakeRouter();
  const out = await drv(r).pushBlocklist(['203.0.113.5']);
  ok(out.ok && r.committed().firewall[BL_SET] && r.committed().firewall[BL_RULE], 'pushed through UCI and confirmed');
  ok(r.log.includes('uci.apply') && r.log.includes('uci.confirm') && r.log.indexOf('uci.apply') < r.log.indexOf('uci.confirm'), 'with apply-then-confirm (the router rolls back if we lose it)');
  const again = await drv(r).pushBlocklist(['203.0.113.5']);
  ok(again.ok && again.unchanged, 'pushing the same list again changes nothing');
  const d2 = fakeRouter(); d2.dirty();
  ok(!(await drv(d2).pushBlocklist(['203.0.113.5'])).ok, 'a router with someone else\'s unsaved edits is refused');
}

// ---- DHCP ----
{
  const mac = 'aa:bb:cc:dd:ee:01';
  ok(dhcpPlan({}, { mac, ip: '192.168.1.50', host: 'Front Desk', action: 'make-static' }).ops[0].values.name === 'Front-Desk', 'make-static adds a reservation, hostname cleaned');
  const luci = { cfg01: { '.type': 'host', mac: 'AA:BB:CC:DD:EE:01', ip: '192.168.1.20', name: 'printer' } };
  ok(dhcpPlan(luci, { mac, ip: '192.168.1.50', action: 'make-static' }).ops[0].op === 'set', 'an existing LuCI reservation is updated, not duplicated');
  const blk = dhcpPlan(luci, { mac, action: 'block' }).ops[0];
  ok(blk.values.ip === 'ignore' && blk.values.netinv_ip === '192.168.1.20', 'block tells dnsmasq to ignore the MAC and remembers the address');
  const blocked = { cfg01: { ...luci.cfg01, ip: 'ignore', netinv_ip: '192.168.1.20' } };
  ok(dhcpPlan(blocked, { mac, action: 'unblock' }).ops[0].values.ip === '192.168.1.20', 'unblock puts the reservation back');
  const ours = { netinv_h_aabbccddee01: { '.type': 'host', mac: 'AA:BB:CC:DD:EE:01', ip: 'ignore', netinv_block: '1' } };
  ok(dhcpPlan(ours, { mac, action: 'unblock' }).ops[0].op === 'delete', 'a block we created from nothing is removed entirely');
  ok(/dynamic lease/.test(dhcpPlan({}, { mac, action: 'remove' }).error), 'removing a dynamic lease explains there is nothing to remove');
  ok(dhcpPlan({}, { mac: 'nope', action: 'block' }).error && dhcpPlan({}, { mac, ip: '999.1.1.1', action: 'make-static' }).error, 'bad MAC / IP refused');
  const leases = annotateLeases([{ id: 'x', mac: 'AA:BB:CC:DD:EE:01', address: '192.168.1.20', dynamic: true }], { ...blocked, cfg02: { '.type': 'host', mac: 'AA:BB:CC:DD:EE:02', ip: 'ignore', name: 'tv' } });
  ok(leases[0].blocked && !leases[0].dynamic && leases.length === 2 && leases[1].blocked && leases[1].host === 'tv', 'the lease list shows reservations and blocks, including blocked devices with no lease');

  const r = fakeRouter();
  ok((await drv(r).dhcpAction({ mac, ip: '192.168.1.50', host: 'pc', action: 'make-static' })).ok && Object.values(r.committed().dhcp).some(h => h.ip === '192.168.1.50'), 'make-static lands on the router');
}

// ---- reboot ----
{
  ok((await drv(fakeRouter()).reboot()).ok, 'reboot: the connection dropping as it goes down counts as success');
}

// ---- firmware ----
{
  const r = fakeRouter();
  ok(!(await drv(r).sysupgrade(Buffer.alloc(10))).ok, 'a tiny file is refused before anything is sent');
  const img = Buffer.alloc(2 * 1024 * 1024, 7);
  const good = await drv(r).sysupgrade(img, { keep: true });
  ok(good.ok && good.stage === 'flashing' && r.log.includes('rpc-sys.upgrade_start'), 'a valid image is uploaded, checked by the router, then flashed');
  ok(r.log.indexOf('system.validate_firmware_image') < r.log.indexOf('rpc-sys.upgrade_start'), 'the router checks the image BEFORE the flash starts');
  const bad = fakeRouter(); bad.setValidate({ valid: false, forceable: false, tests: { fwtool_device_match: false } });
  const refused = await drv(bad).sysupgrade(img);
  ok(!refused.ok && refused.stage === 'validate' && /fwtool_device_match/.test(refused.error) && !bad.log.includes('rpc-sys.upgrade_start'), 'an image for the wrong hardware is refused and never flashed');
  ok(bad.log.includes('run rm -f /tmp/firmware.bin'), 'and the rejected image is removed from the router\'s memory');
}

// ---- packages ----
{
  const r = fakeRouter();
  ok((await drv(r).packageAction('install', 'tcpdump')).ok, 'install a package');
  ok(!(await drv(r).packageAction('install', 'bad name; rm -rf /')).ok, 'package names are validated');
  const prot = await drv(r).packageAction('remove', 'dropbear');
  ok(!prot.ok && /core/.test(prot.error) && PROTECTED_PACKAGES.has('zerotier'), 'packages we manage the router through cannot be removed');
  ok((await drv(r).packageAction('remove', 'tcpdump')).ok && (await drv(r).packageAction('update')).ok, 'remove and update lists');
}

// ---- WireGuard ----
{
  const key = 'A'.repeat(43) + '=';
  const cfg = { privateKey: key, address: '10.147.21.40', prefix: 24, serverPub: 'B'.repeat(43) + '=', endpointHost: 'hub.example.com', endpointPort: '51820', allowed: '10.147.0.0/16' };
  const p = wireguardPlan({ network: {}, firewall: {} }, cfg);
  ok(p.ops.map(o => o.type).join() === 'interface,wireguard_wg_mgmt,zone', 'interface, hub peer and a management zone');
  ok(p.ops[1].values.route_allowed_ips === '0', 'allowed IPs do not add routes (cannot hijack the path we manage it through)');
  ok(p.ops[2].values.input === 'ACCEPT' && p.ops[2].values.forward === 'REJECT', 'the zone lets us in but routes nothing through');
  ok(wireguardPlan({ network: { wg_mgmt: {}, netinv_wg_hub: {} }, firewall: { z: { '.type': 'zone', network: ['wg_mgmt'] } } }, cfg).ops.every(o => o.op === 'set'), 'a second push updates in place');
  ok(wireguardPlan({}, { ...cfg, privateKey: 'short' }).error, 'a bad key is refused');
  const r = fakeRouter();
  ok((await drv(r).pushWireguard(cfg)).ok && r.committed().network.wg_mgmt.proto === 'wireguard', 'pushed to the router through UCI');
}

// ---- batch firewall rule ----
{
  const rr = firewallRuleFromBatch({ chain: 'input', action: 'drop', protocol: 'tcp', dst_port: '23', src_address: '203.0.113.0/24' });
  ok(rr.op.values.target === 'DROP' && rr.op.values.src === 'wan' && rr.op.values.dest_port === '23' && !rr.op.values.dest, 'input rule from the Batch page');
  ok(firewallRuleFromBatch({ chain: 'forward', action: 'accept' }).op.values.dest === 'lan', 'forward rule goes wan → lan');
  ok(firewallRuleFromBatch({ chain: 'output', action: 'drop' }).error && firewallRuleFromBatch({ chain: 'input', action: 'drop', dst_port: '1;reboot' }).error, 'unsupported chain or a bad port is refused');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
