// DD-WRT.
//
// There is no API. DD-WRT's web interface is server-rendered HTML with no stable machine endpoint,
// so every fact here is parsed from the output of a command run over SSH. That is fine for reading
// and a bad idea for writing, which is why the registry grants this platform read capabilities only.
//
// Two consequences worth stating plainly, because they will come up:
//
//   * BUILD DRIFT. DD-WRT builds vary enormously and the output formats are not a contract. A
//     parser that works on one build can return nothing on another. Everything here therefore
//     degrades to empty rather than throwing, and the poll reports what it managed to read.
//   * SSH MUST BE ON. It is off by default in DD-WRT (Services → Secure Shell → SSHd: Enable). A
//     device with it off is unreachable from here, and the error says exactly that rather than
//     "timed out", because the fix is a checkbox.

/** `nvram show`-style `key=value` output. */
export function parseNvram(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * `ip -o link` → the ports.
 *
 * Read from the kernel rather than from DD-WRT's own tooling, because iproute2's format is stable
 * across builds in a way that nvram and the web UI are not.
 */
export function parseIpLink(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    // 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ... link/ether aa:bb:.. brd ..
    const m = line.match(/^\d+:\s+([^:@]+)[:@].*?<([^>]*)>/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === 'lo') continue;
    const flags = m[2].split(',');
    const mac = (line.match(/link\/ether\s+([0-9a-f:]{17})/i) || [])[1] || '';
    out.push({
      name,
      type: /^wl|^ath|^ra\d/.test(name) ? 'wifi' : 'ether',
      // LOWER_UP is physical link; UP is administrative. Same distinction as OpenWrt's carrier/up.
      running: flags.includes('LOWER_UP'),
      disabled: !flags.includes('UP'),
      mac: mac.toUpperCase(),
      ips: [], speed: '', comment: ''
    });
  }
  return out;
}

/** `ip -o -4 addr` → addresses, folded onto the ports above. */
export function parseIpAddr(text) {
  const by = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m) (by[m[1]] = by[m[1]] || []).push(m[2]);
  }
  return by;
}

// DD-WRT runs the same dnsmasq, writing the same lease format, so that parser is shared rather than
// written twice — two copies would drift, and the static-lease-as-1970 bug would come back in one
// of them.
import { parseLeaseFile } from './openwrt.js';
export { parseLeaseFile };

export function createDriver(device, deps = {}) {
  const sshExec = deps.sshExec;
  const host = device.mgmt_address;
  const username = device.admin_username || 'root';
  const password = device.admin_password || '';

  async function run(argv, timeoutMs = 12000) {
    if (!sshExec) throw Object.assign(new Error('SSH is not available on this server'), { http: 500 });
    const r = await sshExec({ host, username, password, argv, timeoutMs });
    if (!r.ok) {
      const why = r.authFailed
        ? 'SSH rejected the login — check the admin username and password'
        : r.unreachable
          ? 'No SSH on this device. DD-WRT ships with it disabled: turn it on under Services → Secure Shell → SSHd.'
          : (r.error || 'the command failed');
      throw Object.assign(new Error(why), { http: 502 });
    }
    return r.stdout;
  }

  return {
    platform: 'ddwrt',
    transport: 'ssh',
    endpoint: `ssh://${username}@${host}`,

    async identity() {
      const nv = parseNvram(await run(['nvram', 'show']).catch(() => ''));
      let version = null;
      try { version = String(await run(['cat', '/tmp/loginprompt'])).trim().split('\n')[0] || null; } catch {}
      return {
        model: nv.DD_BOARD || nv.router_name || null,
        hostname: nv.router_name || nv.wan_hostname || null,
        serial: null,
        distribution: 'DD-WRT',
        osVersion: version || nv.os_version || 'DD-WRT',
        version: nv.os_version || null,
        firmware: { current: nv.os_version || null, upgrade: null }
      };
    },

    async interfaces() {
      const links = parseIpLink(await run(['ip', '-o', 'link']));
      let addrs = {};
      try { addrs = parseIpAddr(await run(['ip', '-o', '-4', 'addr'])); } catch {}
      return { interfaces: links.map(l => ({ ...l, ips: addrs[l.name] || [] })), logical: [] };
    },

    async dhcpLeases() {
      try { return parseLeaseFile(await run(['cat', '/tmp/dnsmasq.leases'])); }
      catch { /* older builds use the other name */ }
      try { return parseLeaseFile(await run(['cat', '/tmp/dhcp.leases'])); } catch { return []; }
    },

    async poll() {
      const id = await this.identity();
      const { interfaces } = await this.interfaces();
      return {
        interfaces,
        osVersion: id.osVersion,
        model: id.model,
        hostname: id.hostname,
        serial: null,
        firmware: id.firmware,
        wifi: { system: null, radios: [] }
      };
    }
  };
}
