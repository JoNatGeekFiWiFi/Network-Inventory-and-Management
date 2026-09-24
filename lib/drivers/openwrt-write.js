// OpenWrt writes beyond Wi-Fi: threat blocklist, DHCP reservations and blocks, reboot, firmware
// upgrade, packages, WireGuard, and batch firewall rules.
//
// The rules from openwrt.js hold here too, and matter more:
//
//   * Configuration changes are STAGED in UCI, then applied with rpcd's confirmed apply. If the
//     change cuts us off, the router rolls itself back within the timeout. Nothing is committed bare.
//   * `uci apply` applies every staged change on the device, not just ours — so a router with
//     half-made edits from LuCI is refused rather than having someone else's work go live with ours.
//   * Everything we create has a name we chose (netinv_…), so it can be found, changed and removed
//     exactly, and a second push updates instead of duplicating.
//   * Every value is validated before it reaches the device. These become root-level calls.
//
// The plan builders are pure (sections in, operations out) and exported for tests; the methods at
// the bottom bolt them onto the driver.

const UCI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const isUciName = (s) => typeof s === 'string' && UCI_NAME.test(s);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CIDR4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;
const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/\s+/).filter(Boolean));

// ---- threat blocklist ----------------------------------------------------------------------------

export const BL_SET = 'netinv_blocklist';
export const BL_RULE = 'netinv_blocklist_drop';

/**
 * Operations to make the router's blocklist equal `ips`. Nothing when it already is; removal of
 * both sections when the list is empty (an empty set with a rule pointing at it helps nobody).
 */
export function blocklistPlan(firewall, ips) {
  const want = [...new Set((ips || []).filter(ip => CIDR4.test(ip)))].sort();
  const cur = firewall && firewall[BL_SET] ? asList(firewall[BL_SET].entry).sort() : null;
  const hasRule = !!(firewall && firewall[BL_RULE]);
  if (!want.length) {
    const ops = [];
    if (cur) ops.push({ op: 'delete', config: 'firewall', section: BL_SET });
    if (hasRule) ops.push({ op: 'delete', config: 'firewall', section: BL_RULE });
    return ops;
  }
  if (cur && hasRule && cur.join() === want.join()) return [];
  const ops = [];
  if (cur) ops.push({ op: 'delete', config: 'firewall', section: BL_SET });
  ops.push({ op: 'add', config: 'firewall', type: 'ipset', name: BL_SET,
    values: { name: BL_SET, family: 'ipv4', match: ['src_net'], entry: want } });
  if (!hasRule) ops.push({ op: 'add', config: 'firewall', type: 'rule', name: BL_RULE,
    values: { name: 'netinv: threat blocklist', src: '*', ipset: BL_SET, family: 'ipv4', target: 'DROP' } });
  return ops;
}

// ---- DHCP ----------------------------------------------------------------------------------------

const macKey = (m) => String(m || '').toUpperCase();

/** The `config host` section for this MAC, whoever created it (LuCI names them cfgXXXX). */
export function findHost(dhcp, mac) {
  for (const [name, s] of Object.entries(dhcp || {})) {
    if (s['.type'] !== 'host') continue;
    if (asList(s.mac).some(m => macKey(m) === macKey(mac))) return { name, section: s };
  }
  return null;
}

/**
 * Mark leases with what the DHCP config says about them: reserved (static), blocked. Blocked hosts
 * with no current lease are listed too, so they can be unblocked from the same table.
 */
export function annotateLeases(leases, dhcp) {
  const out = leases.map(l => {
    const h = findHost(dhcp, l.mac);
    if (!h) return l;
    const blocked = h.section.ip === 'ignore';
    return { ...l, dynamic: false, blocked, comment: blocked ? 'blocked' : 'reserved' };
  });
  for (const [name, s] of Object.entries(dhcp || {})) {
    if (s['.type'] !== 'host' || s.ip !== 'ignore') continue;
    for (const m of asList(s.mac)) if (!out.some(l => macKey(l.mac) === macKey(m))) {
      out.push({ id: macKey(m), address: s.netinv_ip || '', mac: macKey(m), host: s.name || '', server: 'dnsmasq', status: 'blocked',
        dynamic: false, expires: '', blocked: true, disabled: false, lastSeen: '', comment: 'blocked (no lease)' });
    }
  }
  return out;
}

/**
 * One DHCP action as UCI operations.
 *
 *   make-static — reserve this address for this MAC
 *   block       — dnsmasq ignores the MAC (`ip 'ignore'`); the address it had is remembered
 *   unblock     — put the reservation back, or remove the block entirely if there was none
 *   remove      — delete the reservation (a dynamic lease simply expires; there is nothing to delete)
 */
export function dhcpPlan(dhcp, { mac, ip, host, action }) {
  if (!MAC.test(String(mac || ''))) return { error: 'A valid MAC address is required' };
  if (ip && !IPV4.test(ip)) return { error: 'Invalid IP address' };
  const name = String(host || '').replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  const found = findHost(dhcp, mac);
  const ours = 'netinv_h_' + macKey(mac).replace(/:/g, '').toLowerCase();
  switch (action) {
    case 'make-static': {
      if (!ip) return { error: 'The lease has no address to reserve' };
      if (found) return { ops: [{ op: 'set', config: 'dhcp', section: found.name, values: { ip, ...(name ? { name } : {}) } }] };
      return { ops: [{ op: 'add', config: 'dhcp', type: 'host', name: ours, values: { mac: macKey(mac), ip, ...(name ? { name } : {}) } }] };
    }
    case 'block': case 'disable': {
      if (found && found.section.ip === 'ignore') return { ops: [] };
      if (found) return { ops: [{ op: 'set', config: 'dhcp', section: found.name, values: { ip: 'ignore', ...(found.section.ip ? { netinv_ip: found.section.ip } : {}) } }] };
      return { ops: [{ op: 'add', config: 'dhcp', type: 'host', name: ours, values: { mac: macKey(mac), ip: 'ignore', netinv_block: '1', ...(ip ? { netinv_ip: ip } : {}), ...(name ? { name } : {}) } }] };
    }
    case 'unblock': case 'enable': {
      if (!found || found.section.ip !== 'ignore') return { ops: [] };
      if (found.section.netinv_block === '1') return { ops: [{ op: 'delete', config: 'dhcp', section: found.name }] };
      if (found.section.netinv_ip) return { ops: [{ op: 'set', config: 'dhcp', section: found.name, values: { ip: found.section.netinv_ip } }] };
      return { ops: [{ op: 'delete', config: 'dhcp', section: found.name }] };
    }
    case 'remove': {
      if (!found) return { error: 'This is a dynamic lease — it expires on its own. Only reservations can be removed.' };
      return { ops: [{ op: 'delete', config: 'dhcp', section: found.name }] };
    }
    default: return { error: 'Unknown action' };
  }
}

// ---- WireGuard -----------------------------------------------------------------------------------

export const WG_IFACE = 'wg_mgmt';
export const WG_PEER = 'netinv_wg_hub';
export const WG_ZONE = 'netinv_mgmt';

/**
 * The management tunnel as UCI: an interface, the hub as its one peer, and a firewall zone that lets
 * us in over it (input accepted) but routes nothing through it (forward rejected).
 */
export function wireguardPlan({ network, firewall }, { privateKey, address, prefix, serverPub, endpointHost, endpointPort, allowed }) {
  if (!/^[A-Za-z0-9+/]{42,43}=?$/.test(String(privateKey || ''))) return { error: 'Missing or malformed WireGuard private key' };
  if (!/^[A-Za-z0-9+/]{42,43}=?$/.test(String(serverPub || ''))) return { error: 'The hub public key is not set' };
  if (!IPV4.test(String(address || ''))) return { error: 'Missing management address' };
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(String(endpointHost || ''))) return { error: 'The hub endpoint host is not valid' };
  const allowedList = asList(allowed).filter(a => CIDR4.test(a));
  if (!allowedList.length) return { error: 'No allowed network for the tunnel' };
  const ops = [];
  const iface = { proto: 'wireguard', private_key: privateKey, addresses: [`${address}/${Number(prefix) || 24}`] };
  if (network && network[WG_IFACE]) ops.push({ op: 'set', config: 'network', section: WG_IFACE, values: iface });
  else ops.push({ op: 'add', config: 'network', type: 'interface', name: WG_IFACE, values: iface });
  const peer = { description: 'netinv hub', public_key: serverPub, endpoint_host: endpointHost, endpoint_port: String(endpointPort || 51820),
    // route_allowed_ips OFF: the allowed range can overlap the ZeroTier network we may be managing
    // this router through right now, and routing it into a tunnel that is not up yet would cut us
    // off. The tunnel subnet is reachable through the interface address alone. (Matches RouterOS,
    // where allowed-address never adds routes.)
    persistent_keepalive: '25', route_allowed_ips: '0', allowed_ips: allowedList };
  if (network && network[WG_PEER]) ops.push({ op: 'set', config: 'network', section: WG_PEER, values: peer });
  else ops.push({ op: 'add', config: 'network', type: 'wireguard_' + WG_IFACE, name: WG_PEER, values: peer });
  const zoned = Object.values(firewall || {}).some(z => z['.type'] === 'zone' && asList(z.network).includes(WG_IFACE));
  if (!zoned) ops.push({ op: 'add', config: 'firewall', type: 'zone', name: WG_ZONE,
    values: { name: 'netinv_mgmt', network: [WG_IFACE], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' } });
  return { ops };
}

// ---- packages ------------------------------------------------------------------------------------

/** Removing any of these could take the router, or our access to it, down with it. */
export const PROTECTED_PACKAGES = new Set([
  'base-files', 'busybox', 'libc', 'kernel', 'opkg', 'procd', 'ubus', 'ubusd', 'rpcd', 'uci', 'netifd', 'fstools',
  'dropbear', 'openssh-server', 'uhttpd', 'firewall', 'firewall4', 'nftables', 'dnsmasq', 'dnsmasq-full', 'odhcpd',
  'zerotier', 'wireguard-tools', 'kmod-wireguard', 'luci-proto-wireguard', 'iwinfo', 'rpcd-mod-file', 'rpcd-mod-iwinfo'
]);
export const validPackageName = (n) => /^[a-z0-9][a-z0-9+._-]{0,80}$/i.test(String(n || ''));

// ---- batch firewall rule -------------------------------------------------------------------------

/** The Batch page's "add firewall rule" in UCI terms. */
export function firewallRuleFromBatch(p, n = Date.now()) {
  const target = { accept: 'ACCEPT', drop: 'DROP', reject: 'REJECT' }[String(p.action || '').toLowerCase()];
  if (!target) return { error: 'OpenWrt rules can accept, drop or reject' };
  const chain = String(p.chain || '').toLowerCase();
  if (!['input', 'forward'].includes(chain)) return { error: 'OpenWrt rules apply to input or forward' };
  const v = { name: String(p.comment || 'netinv batch').slice(0, 60), src: 'wan', target };
  if (chain === 'forward') v.dest = 'lan';
  if (p.protocol && p.protocol !== 'any') { if (!/^(tcp|udp|icmp)$/.test(p.protocol)) return { error: 'Protocol must be tcp, udp or icmp' }; v.proto = p.protocol; }
  if (p.dst_port) { if (!/^\d{1,5}(-\d{1,5})?$/.test(String(p.dst_port))) return { error: 'Invalid port' }; v.dest_port = String(p.dst_port); }
  if (p.src_address) { if (!CIDR4.test(p.src_address)) return { error: 'Invalid source address' }; v.src_ip = p.src_address; }
  if (p.dst_address) { if (!CIDR4.test(p.dst_address)) return { error: 'Invalid destination address' }; v.dest_ip = p.dst_address; }
  return { op: { op: 'add', config: 'firewall', type: 'rule', name: 'netinv_batch_' + String(n).slice(-10), values: v } };
}

// ---- the driver methods --------------------------------------------------------------------------

export function extendWrites(driver, transport) {
  /** Stage a list of operations and apply them with rollback. Refuses if other edits are pending. */
  async function stageApply(ops, { timeoutSeconds = 45 } = {}) {
    if (!ops.length) return { ok: true, unchanged: true };
    const pending = await driver.uciChanges();
    if (pending.length) return { ok: false, error: `The router has ${pending.length} unsaved configuration change(s) from elsewhere (LuCI?). Apply or revert them there first.` };
    const touched = new Set();
    for (const o of ops) {
      touched.add(o.config);
      let r;
      if (o.op === 'add') r = await driver.uciAdd(o.config, o.type, o.name, o.values);
      else if (o.op === 'set') r = await driver.uciSet(o.config, o.section, o.values);
      else if (o.op === 'delete') r = await driver.uciDelete(o.config, o.section, o.option || null);
      if (!r || !r.ok) {
        for (const c of touched) await driver.uciRevert(c);
        return { ok: false, error: `Could not stage the change (${(r && r.error) || 'unknown error'})` };
      }
    }
    return driver.applyConfirmed({ timeoutSeconds });
  }

  const shell = async (argv, opts) => {
    if (!transport.run) throw Object.assign(new Error('This needs shell access (SSH) to the router'), { http: 400 });
    return transport.run(argv, opts);
  };

  return Object.assign(driver, {
    stageApply,

    /** A shell command on the router (SSH). Resolves { ok, data, error }; never throws. */
    run: (argv, opts) => (transport.run ? transport.run(argv, opts) : Promise.resolve({ ok: false, data: '', error: 'no shell on this transport' })),

    /** `ubus call system info`, raw: uptime, load, memory, and on newer builds root/tmp storage. */
    async systemInfo() {
      const r = await transport.call('system', 'info');
      if (!r.ok) throw Object.assign(new Error(r.error || 'system info refused'), { http: 502 });
      return r.data || {};
    },

    async pushBlocklist(ips) {
      const fw = await driver.uciGetAll('firewall');
      if (!fw.ok) return { ok: false, error: 'Could not read the firewall: ' + fw.error };
      const ops = blocklistPlan(fw.values, ips);
      const r = await stageApply(ops);
      return { ...r, total: (ips || []).length, changed: ops.length > 0 };
    },

    async dhcpLeasesAnnotated() {
      const leases = await driver.dhcpLeases();
      const dhcp = await driver.uciGetAll('dhcp');
      return dhcp.ok ? annotateLeases(leases, dhcp.values) : leases;
    },

    async dhcpAction({ mac, ip, host, action }) {
      const dhcp = await driver.uciGetAll('dhcp');
      if (!dhcp.ok) return { ok: false, error: 'Could not read the DHCP settings: ' + dhcp.error };
      const plan = dhcpPlan(dhcp.values, { mac, ip, host, action });
      if (plan.error) return { ok: false, error: plan.error };
      return stageApply(plan.ops);
    },

    async reboot() {
      const r = await transport.call('system', 'reboot');
      // The router may drop the connection as it goes down; that is success, not failure.
      if (r.ok || r.unreachable) return { ok: true };
      return { ok: false, error: r.error };
    },

    /**
     * Upgrade the firmware from an image we hold.
     *
     * The image goes to /tmp (RAM), the router is asked whether it will accept it, and only a clean
     * answer starts the flash. keep=true keeps the configuration — the default, and the only safe
     * choice for a router we reach over a tunnel that lives in that configuration.
     */
    async sysupgrade(image, { keep = true, force = false } = {}) {
      if (!Buffer.isBuffer(image) || image.length < 1024 * 1024) return { ok: false, stage: 'upload', error: 'That does not look like a firmware image (under 1 MB)' };
      const path = '/tmp/firmware.bin';
      const up = await shell(['dd', 'of=' + path, 'bs=65536'], { stdin: image, timeoutMs: 180000 });
      if (!up.ok && !/records? in/.test(up.error || '')) return { ok: false, stage: 'upload', error: up.error || 'upload failed' };
      const size = await shell(['wc', '-c', path]);
      const got = parseInt(String(size.data || '').trim(), 10);
      if (got !== image.length) return { ok: false, stage: 'upload', error: `Only ${got || 0} of ${image.length} bytes arrived` };
      const v = await driver.validateFirmwareImage(path);
      const tests = (v && v.tests) || {};
      const valid = v.ok && v.valid !== false && Object.values(tests).every(Boolean);
      if (!valid && !(force && v.ok && v.forceable)) {
        await shell(['rm', '-f', path]);
        const failed = Object.entries(tests).filter(([, t]) => !t).map(([k]) => k);
        return { ok: false, stage: 'validate', error: `The router rejected the image${failed.length ? ` (${failed.join(', ')})` : v.error ? ` (${v.error})` : ''} — nothing was flashed.`, tests };
      }
      const start = await transport.call('rpc-sys', 'upgrade_start', { keep: !!keep });
      if (start.ok || start.unreachable) return { ok: true, stage: 'flashing', keep: !!keep, tests };
      // No rpc-sys (a stripped build): the shell command does the same job. It detaches, so the
      // connection dropping afterwards is expected.
      const sh = await shell(['sysupgrade', ...(keep ? [] : ['-n']), path], { timeoutMs: 15000 }).catch(e => ({ ok: false, error: e.message }));
      if (sh.ok || /closed|No response/i.test(sh.error || '')) return { ok: true, stage: 'flashing', keep: !!keep, tests };
      return { ok: false, stage: 'start', error: sh.error || start.error };
    },

    async packageAction(action, name) {
      if (action === 'update') {
        const r = await shell(['opkg', 'update'], { timeoutMs: 120000 });
        return r.ok ? { ok: true, output: r.data.slice(-400) } : { ok: false, error: r.error };
      }
      if (!validPackageName(name)) return { ok: false, error: 'That is not a valid package name' };
      if (action === 'install') {
        const r = await shell(['opkg', 'install', name], { timeoutMs: 180000 });
        return r.ok ? { ok: true, output: r.data.slice(-400) } : { ok: false, error: (r.error || '').slice(0, 300) || 'install failed (try "Update lists" first)' };
      }
      if (action === 'remove') {
        if (PROTECTED_PACKAGES.has(name)) return { ok: false, error: `${name} is part of the router's core or of how we reach it — it will not be removed from here.` };
        const r = await shell(['opkg', 'remove', name], { timeoutMs: 120000 });
        return r.ok ? { ok: true, output: r.data.slice(-400) } : { ok: false, error: (r.error || '').slice(0, 300) };
      }
      return { ok: false, error: 'Unknown package action' };
    },

    async pushWireguard(cfg) {
      // The protocol handler must exist, or netifd accepts the config and silently does nothing.
      const handlers = await transport.call('network', 'get_proto_handlers');
      if (handlers.ok && handlers.data && !('wireguard' in handlers.data)) return { ok: false, error: 'WireGuard is not installed on this router (install kmod-wireguard, wireguard-tools and luci-proto-wireguard)' };
      const network = await driver.uciGetAll('network'), firewall = await driver.uciGetAll('firewall');
      if (!network.ok || !firewall.ok) return { ok: false, error: 'Could not read the network/firewall config' };
      const plan = wireguardPlan({ network: network.values, firewall: firewall.values }, cfg);
      if (plan.error) return { ok: false, error: plan.error };
      return stageApply(plan.ops, { timeoutSeconds: 90 });
    },

    async addFirewallRule(params) {
      const r = firewallRuleFromBatch(params);
      if (r.error) return { ok: false, error: r.error };
      return stageApply([r.op]);
    }
  });
}
