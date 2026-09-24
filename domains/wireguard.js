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
import { wgKeypair, deviceConfig, serverPeerStanza } from '../wg.js';
import { toSvg } from '../lib/qr.js';
import { driverFor, platformOf } from '../lib/drivers/index.js';
import { sshExec } from '../lib/sshexec.js';

/**
 * One shape for both config reads — a router's and a laptop's — so the UI that shows them can be
 * one piece of code. Previously the device endpoint returned neither a name nor a filename, and the
 * peer endpoint did, which is why only peers had a usable download.
 *
 * The QR is best-effort ON PURPOSE. It exists so a technician can point a phone at the screen
 * instead of emailing a private key around, but the config download is the thing people actually
 * need, and it must not fail because a config grew past what the encoder can hold. So a QR failure
 * downgrades to a null and an explanation, and the .conf still comes back.
 */
function configPayload(name, address, config) {
  const filename = `${String(name || 'wireguard').replace(/[^\w.-]+/g, '-').toLowerCase()}.conf`;
  let qr = null, qrError = null;
  try { qr = toSvg(config, { moduleSize: 4 }); }
  catch (e) { qrError = `This config is ${config.length} bytes, too long to fit in a QR code (${e.message}). Download the file instead.`; }
  return { config, address, name, filename, qr, qr_error: qrError };
}

export default function registerWireguard(app, ctx) {
  const { db, audit, requireNoc, getSetting, setSetting, restReq, rosHeaders, rosErr } = ctx;

  const hub = () => createHub({ iface: getSetting('wg_iface') || 'wg0' });

  /**
   * Everything that should exist as a peer on the hub.
   *
   * TWO SOURCES, one overlay. Inventory devices (customer routers) and wg_peers (staff laptops and
   * phones) are different records with different lifecycles, but they share one address space and
   * one hub. Anything that forgets the second source silently removes every staff laptop from the
   * hub on the next sync — the peers are gone, nobody is told, and the symptom is a technician who
   * "just can't get on the VPN today".
   */
  const desiredPeers = () => {
    const devices = db.prepare(`SELECT id, name, wg_public_key, mgmt_address FROM devices
        WHERE mgmt_overlay='WireGuard' AND wg_public_key IS NOT NULL AND wg_public_key <> ''
          AND mgmt_address IS NOT NULL AND mgmt_address <> ''`).all()
      .map(d => ({ name: d.name, publicKey: d.wg_public_key, allowedIps: `${d.mgmt_address}/32`, keepalive: 25 }));

    const people = db.prepare(`SELECT name, owner, public_key, address FROM wg_peers
        WHERE enabled=1 AND public_key IS NOT NULL AND public_key <> ''
          AND address IS NOT NULL AND address <> ''`).all()
      .map(p => ({ name: `${p.name}${p.owner ? ' (' + p.owner + ')' : ''}`, publicKey: p.public_key,
                   allowedIps: `${p.address}/32`, keepalive: 25 }));

    return [...devices, ...people];
  };

  /**
   * Every address already handed out, from BOTH sources.
   *
   * The exclusions are separate on purpose: re-provisioning a device must ignore that device's own
   * address (so it keeps it) without also ignoring a staff peer that happens to share the id.
   */
  const takenAddresses = ({ exceptDeviceId = null, exceptPeerId = null } = {}) => {
    // NOT filtered on having keys: a device that has been deprovisioned still HOLDS its address.
    // Releasing it is a separate, deliberate act, because handing a live IP to a second device is
    // the kind of mistake that shows up weeks later as traffic going to the wrong place.
    const devices = db.prepare(`SELECT mgmt_address AS a FROM devices
        WHERE mgmt_overlay='WireGuard' AND mgmt_address IS NOT NULL AND mgmt_address <> ''
          ${exceptDeviceId ? 'AND id <> ?' : ''}`).all(...(exceptDeviceId ? [exceptDeviceId] : []));
    const peers = db.prepare(`SELECT address AS a FROM wg_peers
        WHERE address IS NOT NULL AND address <> ''
          ${exceptPeerId ? 'AND id <> ?' : ''}`).all(...(exceptPeerId ? [exceptPeerId] : []));
    return [...devices, ...peers].map(r => r.a);
  };

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
    if (!keep) addr = nextFreeAddress(subnet, takenAddresses({ exceptDeviceId: d.id }), { reserve: [hubAddress(subnet)] });
    if (!addr) return res.status(409).json({ error: `No free address left in ${subnet}` });

    db.prepare('UPDATE devices SET wg_public_key=?, wg_private_key=?, mgmt_overlay=?, mgmt_address=? WHERE id=?')
      .run(pub, priv, 'WireGuard', addr, d.id);
    audit(req, 'edit', 'device#' + d.id, `WireGuard ${addr}`);

    const sync = await hub().sync(desiredPeers());
    res.json({ address: addr, public_key: pub, reused_address: !!keep, hub: sync });
  });

  /** Take a device off WireGuard and off the hub, in that order. */
  /**
   * Take a device off the hub — but KEEP ITS ADDRESS RESERVED.
   *
   * An overlay address is not just an allocation, it is a fact recorded elsewhere: in firewall
   * rules, in monitoring, in somebody's notes, in a bookmark. A router pulled off the overlay for
   * an RMA or a hardware swap and then put back must come back on the SAME address, or every one
   * of those references silently points at whatever device was handed the number in between.
   *
   * So deprovisioning clears the KEYS and removes the peer from the hub — access is genuinely
   * revoked — while the address stays held against the device. The pool only gives it up when the
   * device is deleted, or when somebody explicitly releases it.
   */
  app.post('/api/wireguard/devices/:id/deprovision', requireNoc, async (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const release = req.body && (req.body.release_address === true || req.body.release_address === 'true');

    if (release) {
      db.prepare('UPDATE devices SET wg_public_key=NULL, wg_private_key=NULL, mgmt_address=NULL WHERE id=?').run(d.id);
      audit(req, 'edit', 'device#' + d.id, `WireGuard removed, address ${d.mgmt_address} RELEASED back to the pool`);
    } else {
      db.prepare('UPDATE devices SET wg_public_key=NULL, wg_private_key=NULL WHERE id=?').run(d.id);
      audit(req, 'edit', 'device#' + d.id, `WireGuard removed, address ${d.mgmt_address} still reserved`);
    }

    const sync = await hub().sync(desiredPeers());
    res.json({
      ok: true, hub: sync,
      address: release ? null : d.mgmt_address,
      reserved: !release,
      note: release
        ? `${d.mgmt_address} is back in the pool and may be handed to another device.`
        : `${d.mgmt_address} stays reserved for this device — re-provisioning gives it the same address back. Delete the device, or deprovision with "release address", to free it.`
    });
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

    // OpenWrt: the same tunnel as UCI (interface + hub peer + a management zone), applied with
    // rollback, then the hub end.
    if (platformOf(d) === 'openwrt') {
      try {
        const driver = await driverFor({ ...d, mgmt_address: reachAt }, { sshExec });
        const r = await driver.pushWireguard({ privateKey: d.wg_private_key, address: d.mgmt_address, prefix,
          serverPub, endpointHost: host, endpointPort: port || '51820', allowed });
        const sync = r.ok ? await hub().sync(desiredPeers()) : null;
        audit(req, 'edit', 'device#' + d.id, `WireGuard pushed to OpenWrt router (${r.ok ? 'ok' : 'failed'})`);
        return res.status(r.ok ? 200 : 502).json({ ok: !!r.ok, iface: 'wg_mgmt', address: `${d.mgmt_address}/${prefix}`, reached_at: reachAt,
          steps: [{ step: 'UCI network + firewall (confirmed apply)', ok: !!r.ok, detail: r.error || (r.unchanged ? 'already configured' : null) }], hub: sync, error: r.ok ? null : r.error });
      } catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
    }
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
    res.json({
      ...configPayload(d.name, d.mgmt_address, config),
      // The matching [Peer] block for the hub, for the rare case of pasting it in by hand. It moved
      // here when /api/devices/:id/wireguard/config was removed — that route built the SAME config
      // with `allowed` set to wg_subnet instead of wg_supernet, so the file you got depended on
      // which page you opened, and only one of the two could reach ZeroTier members.
      server_peer: serverPeerStanza({ name: d.name, publicKey: d.wg_public_key, address: d.mgmt_address })
    });
  });

  // ---- peers that are not inventory hardware ---------------------------------------------------
  //
  // A technician's laptop, a phone, an office machine. Same overlay, same hub, same address pool —
  // but not a router, not at a site, not owned by a customer, and not something any inventory
  // report should count.

  const PEER_KINDS = ['laptop', 'phone', 'desktop', 'server', 'other'];

  app.get('/api/wireguard/peers', requireNoc, (req, res) => {
    // Private keys are never listed. They are released only by the config endpoint, which audits.
    res.json(db.prepare(`SELECT id, name, owner, kind, address, public_key, enabled, notes, created_by, created_at
      FROM wg_peers ORDER BY name COLLATE NOCASE`).all());
  });

  app.post('/api/wireguard/peers', requireNoc, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A peer needs a name' });

    const subnet = getSetting('wg_subnet');
    if (!subnet) return res.status(400).json({ error: 'Plan the WireGuard subnet first (Settings → WireGuard)' });

    // Allocated against BOTH tables. A laptop given a router's address would not fail loudly — the
    // two would intermittently steal each other's traffic, which is a genuinely horrible thing to
    // diagnose weeks later.
    const addr = nextFreeAddress(subnet, takenAddresses(), { reserve: [hubAddress(subnet)] });
    if (!addr) return res.status(409).json({ error: `No free address left in ${subnet}` });

    const kp = wgKeypair();
    const info = db.prepare(`INSERT INTO wg_peers (name, owner, kind, address, public_key, private_key, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      name, String(b.owner || '').trim() || null,
      PEER_KINDS.includes(b.kind) ? b.kind : 'laptop',
      addr, kp.publicKey, kp.privateKey,
      String(b.notes || '').trim() || null,
      (req.user && req.user.email) || null);

    audit(req, 'create', 'wg-peer#' + info.lastInsertRowid, `${name} → ${addr}`);
    const sync = await hub().sync(desiredPeers());
    res.json({ id: info.lastInsertRowid, address: addr, public_key: kp.publicKey, hub: sync });
  });

  app.put('/api/wireguard/peers/:id', requireNoc, async (req, res) => {
    const p = db.prepare('SELECT * FROM wg_peers WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const enabled = b.enabled === undefined ? p.enabled : (b.enabled ? 1 : 0);
    db.prepare('UPDATE wg_peers SET name=?, owner=?, kind=?, notes=?, enabled=? WHERE id=?').run(
      String(b.name || p.name).trim(), String(b.owner ?? p.owner ?? '').trim() || null,
      PEER_KINDS.includes(b.kind) ? b.kind : p.kind,
      String(b.notes ?? p.notes ?? '').trim() || null, enabled, p.id);
    audit(req, 'edit', 'wg-peer#' + p.id, enabled ? 'enabled' : 'DISABLED');
    // Disabling must reach the hub immediately — a peer that is off in the database and still on
    // the hub is access somebody believes they have revoked.
    const sync = await hub().sync(desiredPeers());
    res.json({ ok: true, hub: sync });
  });

  app.delete('/api/wireguard/peers/:id', requireNoc, async (req, res) => {
    const p = db.prepare('SELECT * FROM wg_peers WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM wg_peers WHERE id=?').run(p.id);
    audit(req, 'delete', 'wg-peer#' + p.id, `${p.name} (${p.address})`);
    // Removed from the database first, then the hub is made to match — the same order the device
    // deprovision uses, so a failure leaves access revoked rather than granted.
    const sync = await hub().sync(desiredPeers());
    res.json({ ok: true, hub: sync });
  });

  /** The peer's own config. Audited on every read, because it contains a private key. */
  app.get('/api/wireguard/peers/:id/config', requireNoc, (req, res) => {
    const p = db.prepare('SELECT * FROM wg_peers WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!p.private_key || !p.address) return res.status(400).json({ error: 'This peer has no key yet' });
    const subnet = getSetting('wg_subnet');
    const config = deviceConfig({
      privateKey: p.private_key,
      address: p.address,
      dns: getSetting('wg_dns'),
      serverPub: getSetting('wg_server_pub') || 'SET_THE_HUB_KEY',
      endpoint: getSetting('wg_endpoint') || 'YOUR_HUB:51820',
      allowed: getSetting('wg_supernet') || subnet || '10.0.0.0/8'
    });
    audit(req, 'credential_read', 'wg-peer#' + p.id, `WireGuard config for ${p.name}`);
    res.json(configPayload(p.name, p.address, config));
  });
}
