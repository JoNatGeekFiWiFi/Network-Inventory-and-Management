// WireGuard, managed entirely from the web UI.
//
// The goal this was built to: never SSH into the server to add a router. One setup script runs
// once (deploy/wireguard-setup.sh) to install WireGuard and grant this service permission to run
// `wg`; after that, provisioning a device, pushing it, retiring it and seeing whether it has ever
// connected all happen here.
//
// The other half is coexisting with ZeroTier. Devices on both overlays need to reach each other,
// and the instinct — put WireGuard in the same subnet as ZeroTier — does not work: two independent
// L3 overlays sharing a prefix do not interconnect, they collide. What works is a shared supernet
// split into two non-overlapping ranges with this server routing between them, which is what
// planFromZeroTier proposes and the setup script wires up.
import { createHub } from '../lib/wghub.js';
import {
  planOverlay, nextFreeAddress, hubAddress, capacity, overlaps, contains, parseCidr, supernetOf
} from '../lib/ipam.js';
import { wgKeypair, deviceConfig } from '../wg.js';

export default function registerWireguard(app, ctx) {
  const { db, audit, requireNoc, getSetting, setSetting, restReq, rosHeaders, rosErr } = ctx;

  const hub = () => createHub({ iface: getSetting('wg_iface') || 'wg0' });

  /** Every device that should exist as a peer on the hub. */
  const desiredPeers = () => db.prepare(`SELECT id, name, wg_public_key, mgmt_address FROM devices
      WHERE mgmt_overlay='WireGuard' AND wg_public_key IS NOT NULL AND wg_public_key <> ''
        AND mgmt_address IS NOT NULL AND mgmt_address <> ''`).all()
    .map(d => ({ name: d.name, publicKey: d.wg_public_key, allowedIps: `${d.mgmt_address}/32`, keepalive: 25 }));

  /** Addresses already handed out, so a new device cannot be given one twice. */
  const takenAddresses = (exceptId = null) => db.prepare(`SELECT mgmt_address FROM devices
      WHERE mgmt_overlay='WireGuard' AND mgmt_address IS NOT NULL AND mgmt_address <> ''
        ${exceptId ? 'AND id <> ?' : ''}`).all(...(exceptId ? [exceptId] : [])).map(r => r.mgmt_address);

  // ---- hub status -----------------------------------------------------------------------
  //
  // Deliberately reports both what the hub HAS and what it SHOULD have. "Configured" and "actually
  // applied" drifting apart is the failure mode people cannot see, so it is stated outright rather
  // than left to be inferred from two screens.
  app.get('/api/wireguard/status', requireNoc, async (req, res) => {
    const subnet = getSetting('wg_subnet') || null;
    const desired = desiredPeers();
    const st = await hub().status();

    const out = {
      hub: {
        available: st.available,
        reason: st.reason || null,
        iface: st.iface,
        listen_port: st.available && st.iface ? st.iface.listen_port : null,
        public_key: getSetting('wg_server_pub') || null,
        endpoint: getSetting('wg_endpoint') || null,
        address: subnet ? hubAddress(subnet) : null
      },
      subnet,
      supernet: getSetting('wg_supernet') || null,
      capacity: subnet ? capacity(subnet, takenAddresses()) : null,
      devices: desired.length,
      peers: st.available ? st.peers : [],
      setup_command: 'sudo bash /opt/netinv/deploy/wireguard-setup.sh'
    };

    if (st.available) {
      const have = new Set(st.peers.map(p => p.public_key));
      const want = new Set(desired.map(p => p.publicKey));
      out.sync = {
        missing_on_hub: desired.filter(d => !have.has(d.publicKey)).map(d => d.name),
        stale_on_hub: st.peers.filter(p => !want.has(p.public_key)).map(p => p.public_key),
        in_sync: desired.every(d => have.has(d.publicKey)) && st.peers.every(p => want.has(p.public_key))
      };
    }
    res.json(out);
  });

  // ---- apply the database to the hub ------------------------------------------------------
  app.post('/api/wireguard/sync', requireNoc, async (req, res) => {
    const r = await hub().sync(desiredPeers());
    audit(req, 'edit', 'wireguard', r.ok
      ? `synced hub (+${r.applied?.added || 0} ~${r.applied?.updated || 0} -${r.applied?.removed || 0})`
      : 'hub sync failed: ' + (r.reason || 'see failures'));
    res.status(r.ok ? 200 : 502).json(r);
  });

  // ---- plan the subnets against ZeroTier ---------------------------------------------------
  /**
   * Read what ZeroTier manages and propose where WireGuard should live.
   *
   * Only ever a proposal: it is returned for a person to approve, never applied on its own.
   * Renumbering an overlay that devices are already using is not something to do by surprise.
   */
  app.get('/api/wireguard/plan', requireNoc, async (req, res) => {
    const nwid = getSetting('zt_network_id'), token = getSetting('zt_api_token');
    let ztRanges = [], source = 'none';

    if (nwid && token) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000);
        let r;
        try {
          r = await fetch(`https://api.zerotier.com/api/v1/network/${nwid}`,
            { headers: { Authorization: 'token ' + token }, signal: ac.signal });
        } finally { clearTimeout(t); }

        if (r.ok) {
          const net = await r.json();
          const cfg = net.config || {};
          // Both are relevant: routes are what members are told to reach, pools are what members
          // are actually given. Missing either would let the plan "avoid" ZeroTier and still clash.
          for (const rt of cfg.routes || []) if (rt && rt.target) ztRanges.push(rt.target);
          for (const p of cfg.ipAssignmentPools || []) {
            if (!p || !p.ipRangeStart || !p.ipRangeEnd) continue;
            const s = supernetOf([`${p.ipRangeStart}/32`, `${p.ipRangeEnd}/32`]);
            if (s) ztRanges.push(s);
          }
          ztRanges = [...new Set(ztRanges.filter(x => parseCidr(x)))];
          source = 'zerotier';
        } else {
          source = `zerotier-error-${r.status}`;
        }
      } catch (e) {
        source = 'zerotier-unreachable';
      }
    }

    const plan = planOverlay(ztRanges, { existingWg: getSetting('wg_subnet') || null });
    res.json({
      ...plan,
      source,
      current: {
        wg_subnet: getSetting('wg_subnet') || null,
        wg_supernet: getSetting('wg_supernet') || null
      },
      // Enough to explain the consequence before anyone presses apply.
      would_renumber: !!(getSetting('wg_subnet') && plan.wg_range && getSetting('wg_subnet') !== plan.wg_range),
      devices_affected: getSetting('wg_subnet') && plan.wg_range && getSetting('wg_subnet') !== plan.wg_range
        ? takenAddresses().length : 0
    });
  });

  /** Accept a plan. Generates the hub keypair on first use. */
  app.post('/api/wireguard/plan/apply', requireNoc, (req, res) => {
    const b = req.body || {};
    const subnet = String(b.wg_range || '').trim();
    const supernet = String(b.supernet || '').trim();
    if (!parseCidr(subnet)) return res.status(400).json({ error: 'That is not a valid subnet' });
    if (supernet && !contains(supernet, subnet))
      return res.status(400).json({ error: 'The supernet does not contain the WireGuard range' });

    // Refuse to move onto something ZeroTier already owns, even if asked directly. A collision
    // here does not fail loudly — it produces two devices with the same address.
    const ztRanges = Array.isArray(b.zt_ranges) ? b.zt_ranges.filter(r => parseCidr(r)) : [];
    const clash = ztRanges.find(r => overlaps(r, subnet));
    if (clash) return res.status(400).json({ error: `That range overlaps ZeroTier's ${clash}` });

    setSetting('wg_subnet', subnet);
    if (supernet) setSetting('wg_supernet', supernet);
    if (!getSetting('wg_server_priv')) {
      const kp = wgKeypair();
      setSetting('wg_server_priv', kp.privateKey);
      setSetting('wg_server_pub', kp.publicKey);
    }
    audit(req, 'edit', 'wireguard', `subnet ${subnet}${supernet ? ' in ' + supernet : ''}`);
    res.json({ ok: true, wg_subnet: subnet, wg_supernet: supernet || null, hub_address: hubAddress(subnet) });
  });

  // ---- tell ZeroTier how to reach the WireGuard side ---------------------------------------
  /**
   * Add a managed route for the WireGuard range via this server's ZeroTier address.
   *
   * Without it traffic flows one way only: WireGuard devices can reach ZeroTier (their AllowedIPs
   * covers the supernet) but ZeroTier members have never been told the WireGuard range exists, so
   * replies go to their default gateway and vanish. That asymmetry looks like a firewall problem
   * and wastes an afternoon, so it is a button rather than a paragraph in a runbook.
   */
  app.post('/api/wireguard/advertise', requireNoc, async (req, res) => {
    const nwid = getSetting('zt_network_id'), token = getSetting('zt_api_token');
    const subnet = getSetting('wg_subnet');
    if (!nwid || !token) return res.status(400).json({ error: 'Set the ZeroTier network ID and API token in Settings first' });
    if (!subnet) return res.status(400).json({ error: 'Plan the WireGuard subnet first' });

    const via = String((req.body || {}).via || '').trim();
    if (!via) return res.status(400).json({ error: "Give this server's ZeroTier address, which members will route through" });

    try {
      const get = await fetch(`https://api.zerotier.com/api/v1/network/${nwid}`, { headers: { Authorization: 'token ' + token } });
      if (!get.ok) return res.status(502).json({ error: `ZeroTier API ${get.status}` });
      const net = await get.json();
      const routes = (net.config && net.config.routes) || [];

      if (routes.some(r => r.target === subnet && r.via === via))
        return res.json({ ok: true, already: true, routes });

      // Replace any existing route for this target rather than adding a second one.
      const next = routes.filter(r => r.target !== subnet).concat([{ target: subnet, via }]);
      const put = await fetch(`https://api.zerotier.com/api/v1/network/${nwid}`, {
        method: 'POST',
        headers: { Authorization: 'token ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { routes: next } })
      });
      if (!put.ok) { const t = await put.text().catch(() => ''); return res.status(502).json({ error: `ZeroTier API ${put.status}${t ? ': ' + t.slice(0, 160) : ''}` }); }
      audit(req, 'edit', 'wireguard', `advertised ${subnet} via ${via} on ZeroTier`);
      res.json({ ok: true, routes: next });
    } catch (e) {
      res.status(502).json({ error: 'Could not reach ZeroTier: ' + e.message });
    }
  });

  // ---- provision a device -------------------------------------------------------------------
  /**
   * Give a device a keypair and an address, then make the hub aware of it.
   *
   * The hub sync happens here rather than being left to a separate button: a device that has been
   * "provisioned" but never applied looks finished and does not work, and nobody would think to
   * press sync afterwards.
   */
  app.post('/api/wireguard/devices/:id/provision', requireNoc, async (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const subnet = getSetting('wg_subnet');
    if (!subnet) return res.status(400).json({ error: 'Plan the WireGuard subnet first (Settings → WireGuard)' });

    let pub = d.wg_public_key, priv = d.wg_private_key;
    if (!pub || !priv) { const kp = wgKeypair(); pub = kp.publicKey; priv = kp.privateKey; }

    // Keep the address if it is still valid for the current subnet; otherwise allocate. Re-using a
    // still-valid address means re-provisioning does not silently renumber a working device.
    let addr = d.mgmt_address;
    const keep = addr && d.mgmt_overlay === 'WireGuard' && contains(subnet, `${addr}/32`);
    if (!keep) addr = nextFreeAddress(subnet, takenAddresses(d.id), { reserve: [hubAddress(subnet)] });
    if (!addr) return res.status(409).json({ error: `No free address left in ${subnet}` });

    db.prepare('UPDATE devices SET wg_public_key=?, wg_private_key=?, mgmt_overlay=?, mgmt_address=? WHERE id=?')
      .run(pub, priv, 'WireGuard', addr, d.id);
    audit(req, 'edit', 'device#' + d.id, `WireGuard ${addr}`);

    const sync = await hub().sync(desiredPeers());
    res.json({ address: addr, public_key: pub, reused_address: !!keep, hub: sync });
  });

  /** Take a device off WireGuard and off the hub, in that order. */
  app.post('/api/wireguard/devices/:id/deprovision', requireNoc, async (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE devices SET wg_public_key=NULL, wg_private_key=NULL, mgmt_address=NULL WHERE id=?').run(d.id);
    audit(req, 'edit', 'device#' + d.id, 'WireGuard removed');
    const sync = await hub().sync(desiredPeers());
    res.json({ ok: true, hub: sync });
  });

  // ---- push the config onto a RouterOS device -----------------------------------------------
  /**
   * Configure WireGuard on the router itself, over the REST API already used for polling.
   *
   * This is what makes it zero-touch: no file to copy, nothing to paste into a terminal. RouterOS
   * 7 only — v6 has no WireGuard, and the download stays for anything this cannot reach.
   */
  app.post('/api/wireguard/devices/:id/push', requireNoc, async (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (!d.wg_private_key || !d.mgmt_address) return res.status(400).json({ error: 'Provision the device on WireGuard first' });
    if (!d.mgmt_address && !d.current_mgmt_ip) return res.status(400).json({ error: 'No management address to reach the router on' });

    const subnet = getSetting('wg_subnet');
    const allowed = getSetting('wg_supernet') || subnet;
    const endpoint = getSetting('wg_endpoint') || '';
    const serverPub = getSetting('wg_server_pub');
    if (!endpoint || !serverPub) return res.status(400).json({ error: 'Set the WireGuard endpoint in Settings and save first' });
    const [host, port] = endpoint.split(':');
    const iface = (getSetting('wg_router_iface') || 'wg-mgmt').trim();
    const prefix = parseCidr(subnet).bits;

    // Reached over whatever address currently works — usually the existing ZeroTier address, since
    // this is normally run while migrating a device that is already on ZeroTier.
    const reachAt = req.body && req.body.via ? String(req.body.via) : (d.current_mgmt_ip || d.mgmt_address);
    const H = rosHeaders(d);
    const steps = [];
    const ros = async (method, path, body) => {
      const r = await restReq(reachAt, '/rest' + path, { headers: H, method, body, timeoutMs: 15000 });
      let data = null;
      try { data = r.body ? JSON.parse(r.body) : null; } catch {}
      const ok = r.status >= 200 && r.status < 300;
      steps.push({ step: `${method} ${path}`, status: r.status, ok, detail: ok ? null : String(r.body || '').slice(0, 200) });
      return { ok, status: r.status, data };
    };

    try {
      // Idempotent throughout: pushing twice must not leave a router with two half-built tunnels.
      const found = await ros('GET', `/interface/wireguard?name=${encodeURIComponent(iface)}`);
      const existing = found.ok && Array.isArray(found.data) && found.data.length ? found.data[0] : null;
      if (existing) await ros('PATCH', `/interface/wireguard/${encodeURIComponent(existing['.id'])}`, { 'private-key': d.wg_private_key });
      else await ros('PUT', '/interface/wireguard', { name: iface, 'private-key': d.wg_private_key, 'listen-port': '13231' });

      const addrWanted = `${d.mgmt_address}/${prefix}`;
      const addrs = await ros('GET', `/ip/address?interface=${encodeURIComponent(iface)}`);
      const hasAddr = addrs.ok && Array.isArray(addrs.data) && addrs.data.some(a => a.address === addrWanted);
      if (!hasAddr) await ros('PUT', '/ip/address', { address: addrWanted, interface: iface });

      const peers = await ros('GET', `/interface/wireguard/peers?interface=${encodeURIComponent(iface)}`);
      const peer = peers.ok && Array.isArray(peers.data) ? peers.data.find(p => p['public-key'] === serverPub) : null;
      const peerBody = {
        interface: iface, 'public-key': serverPub,
        'endpoint-address': host, 'endpoint-port': String(port || '51820'),
        'allowed-address': allowed, 'persistent-keepalive': '25s'
      };
      if (peer) await ros('PATCH', `/interface/wireguard/peers/${encodeURIComponent(peer['.id'])}`, peerBody);
      else await ros('PUT', '/interface/wireguard/peers', peerBody);

      const failed = steps.filter(s => !s.ok);
      // Configure the hub end too, or the tunnel exists at one end only and nothing says why.
      const sync = await hub().sync(desiredPeers());
      audit(req, 'edit', 'device#' + d.id, `WireGuard pushed to router (${failed.length ? 'partial' : 'ok'})`);

      res.status(failed.length ? 502 : 200).json({
        ok: failed.length === 0, iface, address: addrWanted, reached_at: reachAt, steps, hub: sync,
        error: failed.length
          ? 'Some steps failed on the router. RouterOS 6 has no WireGuard — check the version, and that the REST service is enabled.'
          : null
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: rosErr(e), steps });
    }
  });

  /** The .conf, for anything the platform cannot configure directly. */
  app.get('/api/wireguard/devices/:id/config', requireNoc, (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (!d.wg_private_key || !d.mgmt_address) return res.status(400).json({ error: 'Provision the device on WireGuard first' });
    const subnet = getSetting('wg_subnet');
    const config = deviceConfig({
      privateKey: d.wg_private_key,
      address: d.mgmt_address,
      dns: getSetting('wg_dns'),
      serverPub: getSetting('wg_server_pub') || 'SET_THE_HUB_KEY',
      endpoint: getSetting('wg_endpoint') || 'YOUR_HUB:51820',
      // The supernet, so this device can reach ZeroTier members as well as other WireGuard peers.
      allowed: getSetting('wg_supernet') || subnet || '10.0.0.0/8'
    });
    audit(req, 'credential_read', 'device#' + d.id, 'WireGuard config');
    res.json({ config, address: d.mgmt_address });
  });
}
