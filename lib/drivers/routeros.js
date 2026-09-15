// RouterOS, behind the same interface as every other platform.
//
// This is deliberately an ADAPTER, not a rewrite. The RouterOS code in server.js and
// domains/network.js has been in production against the live fleet for months and is covered by the
// existing test suites; moving it wholesale into a new file to make the driver layer look tidy
// would risk every MikroTik in the field to achieve nothing a user can see. So the working code
// stays where it is, and this presents it under the shared method names.
//
// The consequence to keep in mind: when a RouterOS behaviour needs changing, change it in the
// original location. This file should stay thin enough that there is never a question of which copy
// is authoritative — there is only one, and it is not here.

/**
 * @param device  a row from `devices`
 * @param deps    { restReq, rosHeaders, readWifi, readWifiClients, pollDeviceCore } from ctx
 */
export function createDriver(device, deps = {}) {
  const { restReq, rosHeaders, readWifi, readWifiClients, pollDeviceCore } = deps;

  const missing = (what) => async () => {
    throw Object.assign(new Error(`RouterOS ${what} is not available in this context`), { http: 500 });
  };

  /** One GET against the REST API, returning parsed JSON or an error — the shape the rest expects. */
  async function get(path, timeoutMs = 8000) {
    if (!restReq || !rosHeaders) throw Object.assign(new Error('RouterOS transport not wired up'), { http: 500 });
    const r = await restReq(device.mgmt_address, path, { headers: rosHeaders(device), timeoutMs });
    if (r.status >= 400) {
      throw Object.assign(
        new Error(`Device returned ${r.status}${r.status === 401 ? ' (login rejected — check admin user/pass)' : ''}`),
        { http: 502 }
      );
    }
    try { return JSON.parse(r.body); }
    catch { throw Object.assign(new Error('Unexpected response from device (is REST enabled?)'), { http: 502 }); }
  }

  return {
    platform: 'routeros',
    transport: 'rest',
    endpoint: device.mgmt_address ? `https://${device.mgmt_address}/rest` : null,

    async identity() {
      const rb = await get('/rest/system/routerboard', 7000).catch(() => null);
      const rr = await get('/rest/system/resource', 7000).catch(() => null);
      const b = Array.isArray(rb) ? rb[0] : rb;
      const s = Array.isArray(rr) ? rr[0] : rr;
      return {
        model: (b && (b.model || b['board-name'])) || (s && s['board-name']) || null,
        hostname: null,
        serial: (b && (b['serial-number'] || b.serial)) || null,
        osVersion: (s && s.version) || null,
        version: (b && b['current-firmware']) || null,
        distribution: 'RouterOS',
        uptime: s && s.uptime ? s.uptime : null,
        firmware: { current: (b && b['current-firmware']) || null, upgrade: (b && b['upgrade-firmware']) || null }
      };
    },

    async interfaces() {
      const data = await get('/rest/interface');
      let addresses = [];
      try { const a = await get('/rest/ip/address'); if (Array.isArray(a)) addresses = a; } catch {}
      const ipByIf = {};
      for (const a of addresses) {
        const ifn = a.interface, ip = String(a.address || '').split('/')[0];
        if (ifn && ip) (ipByIf[ifn] = ipByIf[ifn] || []).push(ip);
      }
      const interfaces = (Array.isArray(data) ? data : []).map(i => ({
        name: i.name,
        type: i.type || '',
        running: i.running === 'true' || i.running === true,
        disabled: i.disabled === 'true' || i.disabled === true,
        mac: i['mac-address'] || '',
        comment: i.comment || '',
        ips: ipByIf[i.name] || [],
        speed: ''
      }));
      return { interfaces, logical: [] };
    },

    wifi: readWifi ? (() => readWifi(device)) : missing('WiFi reading'),
    wifiClients: readWifiClients ? ((pref) => readWifiClients(device, pref)) : missing('WiFi client listing'),

    async log() {
      const logs = await get('/rest/log', 7000);
      return Array.isArray(logs) ? logs : [];
    },

    async dhcpLeases() {
      const l = await get('/rest/ip/dhcp-server/lease');
      return Array.isArray(l) ? l : [];
    },

    /**
     * The full poll.
     *
     * Delegated outright: pollDeviceCore also writes to the database, harvests threat IPs and
     * updates the site's current addresses. Reimplementing any of that here would give two versions
     * of the behaviour that must be kept in step, which is exactly the bug this layer exists to
     * avoid elsewhere.
     */
    poll: pollDeviceCore ? (() => pollDeviceCore(device)) : missing('polling')
  };
}
