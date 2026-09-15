// One device, many operating systems.
//
// Until now every management feature in this platform assumed RouterOS: the poll reads
// /rest/interface, the blocklist writes an address-list, the backup pulls an .rsc. Adding a second
// OS by putting `if (openwrt)` inside each of those would double the branching in eight places and
// oblige every future feature to remember both. So instead each platform gets a driver exposing the
// SAME small set of operations, and the rest of the app asks the driver rather than the router.
//
// Two rules make this worth having rather than just indirection:
//
//  1. CAPABILITIES ARE DECLARED, not discovered by failing. A DD-WRT box cannot have its WiFi
//     password changed from here; the honest response is for the button not to exist, not for it to
//     exist and return 502. `capsFor()` is what the UI reads to decide.
//
//  2. EVERY DRIVER RETURNS THE SAME SHAPES. An interface is {name, type, running, disabled, mac,
//     ips, speed, comment} whether it came from a RouterOS REST array or an OpenWrt ubus object.
//     Anything that varies per platform is normalised inside the driver, because the alternative is
//     that every consumer learns all three formats.
//
// Adding a platform later means writing one file and one row in PLATFORMS — not touching callers.

/** Every operation a driver may implement. The UI and the API both gate on these names. */
export const CAPABILITIES = [
  'identity',        // model, serial, OS version
  'interfaces',      // ports, link state, addresses
  'traffic',         // per-interface byte counters, for the telemetry sampler
  'dhcpRead',        // list DHCP leases
  'dhcpWrite',       // make static, block, delete a lease
  'wifiRead',        // SSIDs and radio state
  'wifiWrite',       // change SSID / passphrase
  'wifiClients',     // associated stations
  'logRead',         // system log, which is where failed logins are harvested from
  'blocklistPush',   // push the central threat blocklist into the firewall
  'configBackup',    // pull a restorable configuration
  'firmware',        // report and apply upgrades
  'reboot',
  'wireguardPush'    // install a WireGuard peer config over the API
];

/**
 * What each platform can actually do.
 *
 * Deliberately conservative: a capability is listed only once there is a driver method behind it
 * that has been exercised against real hardware. Claiming a capability that half-works is worse
 * than not claiming it, because the failure surfaces to a technician standing at a customer site.
 */
export const PLATFORMS = {
  routeros: {
    label: 'MikroTik RouterOS',
    short: 'RouterOS',
    transport: 'REST API (www-ssl / www)',
    caps: ['identity', 'interfaces', 'traffic', 'dhcpRead', 'dhcpWrite', 'wifiRead', 'wifiWrite',
           'wifiClients', 'logRead', 'blocklistPush', 'configBackup', 'firmware', 'reboot',
           'wireguardPush']
  },
  openwrt: {
    label: 'OpenWrt (and vendor builds of it)',
    short: 'OpenWrt',
    transport: 'ubus over HTTP, or SSH',
    // Monitoring first, by decision. The write paths are real work on OpenWrt — UCI commit and
    // service reload rather than a single REST call — and each needs testing against hardware
    // before it is offered.
    caps: ['identity', 'interfaces', 'traffic', 'dhcpRead', 'wifiRead', 'wifiClients', 'logRead']
  },
  ddwrt: {
    label: 'DD-WRT',
    short: 'DD-WRT',
    transport: 'SSH (no API)',
    // DD-WRT has no management API at all. Everything here is parsed from command output over SSH,
    // which is fine for reading and a bad idea for writing.
    caps: ['identity', 'interfaces', 'traffic', 'dhcpRead']
  },
  unknown: {
    label: 'Not managed from here',
    short: 'Unmanaged',
    transport: 'none',
    // Inventory only: serial, model, site, credentials. Nothing is polled, nothing is pushed.
    caps: []
  }
};

export const PLATFORM_KEYS = Object.keys(PLATFORMS);

/** The platform a device record names, falling back to RouterOS — which is every existing device. */
export function platformOf(device) {
  const p = String((device && device.platform) || '').trim().toLowerCase();
  return PLATFORMS[p] ? p : 'routeros';
}

/** Capability list for a device (or a bare platform key). */
export function capsFor(deviceOrKey) {
  const key = typeof deviceOrKey === 'string'
    ? (PLATFORMS[deviceOrKey.toLowerCase()] ? deviceOrKey.toLowerCase() : 'routeros')
    : platformOf(deviceOrKey);
  return PLATFORMS[key].caps.slice();
}

/** Can this device do this? The single question the UI and the API both ask. */
export function can(deviceOrKey, capability) {
  return capsFor(deviceOrKey).includes(capability);
}

/**
 * A capability map, for handing to the browser.
 *
 * An object rather than an array so the front end can write `d.caps.wifiWrite` without a lookup
 * helper, and so a capability the front end has never heard of is simply absent rather than an
 * error.
 */
export function capMap(deviceOrKey) {
  const have = new Set(capsFor(deviceOrKey));
  const out = {};
  for (const c of CAPABILITIES) out[c] = have.has(c);
  return out;
}

/**
 * A guess at the platform from what inventory already knows.
 *
 * Only ever a default for the form — the field stays editable, because a Linksys running stock
 * firmware and the same Linksys flashed with OpenWrt are the same manufacturer and model.
 */
export function guessPlatform({ manufacturer = '', model = '' } = {}) {
  const s = `${manufacturer} ${model}`.toLowerCase();
  if (/mikrotik|routerboard|\bccr\b|\bcrs\b|\bhap\b|\bhex\b/.test(s)) return 'routeros';
  if (/openwrt|katalyst|spark|gl\.?inet|glinet|turris|banana ?pi/.test(s)) return 'openwrt';
  if (/dd-?wrt/.test(s)) return 'ddwrt';
  return 'unknown';
}

/**
 * Build the driver for a device.
 *
 * `deps` carries what the drivers need from the server (restReq for RouterOS, an SSH runner for the
 * others) rather than importing it, so a driver can be constructed in a test with a fake transport
 * and the real request-building code still runs.
 */
export async function driverFor(device, deps = {}) {
  const key = platformOf(device);
  switch (key) {
    case 'openwrt': {
      const m = await import('./openwrt.js');
      return m.createDriver(device, deps);
    }
    case 'ddwrt': {
      const m = await import('./ddwrt.js');
      return m.createDriver(device, deps);
    }
    case 'unknown':
      return nullDriver(device);
    default: {
      const m = await import('./routeros.js');
      return m.createDriver(device, deps);
    }
  }
}

/** A device nobody manages from here. Every call refuses in the same, explainable way. */
export function nullDriver(device) {
  const refuse = async () => {
    throw Object.assign(
      new Error(`${device && device.name ? device.name : 'This device'} is set to "Not managed from here", so the platform does not talk to it. Change its Platform to poll it.`),
      { http: 400 }
    );
  };
  return {
    platform: 'unknown', caps: [], can: () => false,
    identity: refuse, interfaces: refuse, dhcpLeases: refuse,
    wifi: refuse, wifiClients: refuse, log: refuse, poll: refuse
  };
}

/**
 * Wrap a driver so an unsupported call fails as a clear 400 rather than a confusing 502.
 *
 * Without this, asking a DD-WRT router for its WiFi passphrase produces a timeout or a parse error
 * somewhere deep in a transport, and the person reading the message concludes the router is broken.
 */
export function guard(driver, platformKey) {
  const caps = new Set(capsFor(platformKey));
  return new Proxy(driver, {
    get(t, prop) {
      const needed = METHOD_CAPS[prop];
      if (needed && !caps.has(needed)) {
        return async () => {
          throw Object.assign(
            new Error(`${PLATFORMS[platformKey].label} does not support ${needed} from this platform.`),
            { http: 400, unsupported: needed }
          );
        };
      }
      return t[prop];
    }
  });
}

/** Which capability each driver method needs. Used only by guard(). */
const METHOD_CAPS = {
  identity: 'identity',
  interfaces: 'interfaces',
  traffic: 'traffic',
  dhcpLeases: 'dhcpRead',
  wifi: 'wifiRead',
  wifiClients: 'wifiClients',
  log: 'logRead'
};
