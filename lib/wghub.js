// Driving the WireGuard hub from the platform, so nobody has to SSH in to add a router.
//
// The interface itself still has to exist — installing a kernel module and creating wg0 is root
// work that a web app should not be doing, and deploy/wireguard-setup.sh does it once. But from
// then on, everything a person actually does day to day — add a device, take one out, see whether
// it has ever connected — happens here.
//
// Two rules shape this file:
//
//  1. NOTHING is passed through a shell. Every command is an argv array run with execFile, and
//     every value is validated against a strict pattern first. A public key or an address that
//     reaches this code originates in the database, and a device record is something a user can
//     influence — so `wg set wg0 peer "$KEY"` with a crafted key would be command injection as
//     root. There is no shell here for anything to escape into.
//
//  2. The runtime and the saved config are kept in step. `wg set` changes the live interface but
//     not /etc/wireguard/wg0.conf, so a reboot would silently drop every peer added since the last
//     save. Every mutation is followed by a save.
import { execFile } from 'node:child_process';

// WireGuard keys are 32 raw bytes in base64: 43 characters plus '='.
const KEY_RE = /^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]=$/;
const IFACE_RE = /^[a-zA-Z0-9_.-]{1,15}$/;
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export const isWgKey = (k) => typeof k === 'string' && KEY_RE.test(k);
export const isIface = (i) => typeof i === 'string' && IFACE_RE.test(i);
const isCidrList = (s) => typeof s === 'string' && s.split(',').every(p => CIDR_RE.test(p.trim()));

/**
 * Build the argv for adding or updating one peer.
 *
 * Returns null rather than a half-built command when anything fails validation — the caller then
 * reports a bad record instead of running something unexpected as root.
 */
export function addPeerArgs(iface, { publicKey, allowedIps, keepalive = 25 }) {
  if (!isIface(iface) || !isWgKey(publicKey) || !isCidrList(allowedIps)) return null;
  const ka = Number(keepalive);
  if (!Number.isInteger(ka) || ka < 0 || ka > 65535) return null;
  return ['set', iface, 'peer', publicKey, 'allowed-ips', allowedIps, 'persistent-keepalive', String(ka)];
}

export function removePeerArgs(iface, publicKey) {
  if (!isIface(iface) || !isWgKey(publicKey)) return null;
  return ['set', iface, 'peer', publicKey, 'remove'];
}

export const showDumpArgs = (iface) => (isIface(iface) ? ['show', iface, 'dump'] : null);

/**
 * Parse `wg show <iface> dump`.
 *
 * Tab-separated. The first line describes the interface, every line after it is a peer:
 *   pubkey, preshared, endpoint, allowed-ips, latest-handshake, rx, tx, keepalive
 *
 * latest-handshake is a unix timestamp, and 0 means "never" — not 1970. Reporting a peer as last
 * seen in 1970 rather than "never connected" is the kind of detail that sends someone to site.
 */
export function parseWgDump(text) {
  const lines = String(text || '').split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (!lines.length) return { iface: null, peers: [] };

  const [privateKey, publicKey, listenPort, fwmark] = lines[0].split('\t');
  const iface = {
    // The hub's private key appears here. It is deliberately not returned — nothing upstream needs
    // it, and it would otherwise ride along into an API response or a log.
    has_private_key: !!privateKey && privateKey !== '(none)',
    public_key: publicKey && publicKey !== '(none)' ? publicKey : null,
    listen_port: Number(listenPort) || null,
    fwmark: fwmark && fwmark !== 'off' ? fwmark : null
  };

  const peers = lines.slice(1).map(line => {
    const [pub, psk, endpoint, allowed, handshake, rx, tx, keepalive] = line.split('\t');
    const hs = Number(handshake) || 0;
    return {
      public_key: pub,
      has_preshared_key: !!psk && psk !== '(none)',
      endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
      allowed_ips: allowed && allowed !== '(none)' ? allowed.split(',') : [],
      last_handshake: hs ? new Date(hs * 1000).toISOString() : null,
      seconds_since_handshake: hs ? Math.max(0, Math.floor(Date.now() / 1000 - hs)) : null,
      rx_bytes: Number(rx) || 0,
      tx_bytes: Number(tx) || 0,
      keepalive: keepalive && keepalive !== 'off' ? Number(keepalive) : null,
      // WireGuard is silent when idle, so "connected" is a judgement rather than a fact. A peer
      // with keepalive 25 handshakes at least every ~2 minutes; three minutes of nothing means it
      // is genuinely gone rather than merely quiet.
      online: hs ? (Date.now() / 1000 - hs) < 180 : false
    };
  });

  return { iface, peers };
}

/**
 * Work out what has to change to make the hub match the database.
 *
 * Returned as a plan rather than applied directly, so the UI can show "3 to add, 1 to remove"
 * before anything touches a live overlay, and so the whole thing is testable without WireGuard.
 */
export function diffPeers(desired, actual) {
  const want = new Map();
  for (const d of desired || []) if (isWgKey(d.publicKey)) want.set(d.publicKey, d);
  const have = new Map();
  for (const p of actual || []) have.set(p.public_key, p);

  const add = [], update = [], remove = [];
  for (const [key, d] of want) {
    const cur = have.get(key);
    if (!cur) { add.push(d); continue; }
    // Comparing as sets: wg reports allowed-ips in its own order, which is not ours.
    const a = new Set((cur.allowed_ips || []).map(s => s.trim()));
    const b = new Set(String(d.allowedIps).split(',').map(s => s.trim()));
    if (a.size !== b.size || [...b].some(x => !a.has(x))) update.push(d);
  }
  for (const key of have.keys()) if (!want.has(key)) remove.push(key);
  return { add, update, remove };
}

/**
 * Run a wg command.
 *
 * `sudo` is prepended when configured, because the service runs unprivileged and the setup script
 * grants it exactly two commands. execFile with an argv array means no shell is involved at any
 * point — the arguments cannot be re-interpreted however odd they look.
 */
function run(bin, args, { sudo = true, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const cmd = sudo ? 'sudo' : bin;
    const argv = sudo ? ['-n', bin, ...args] : args;      // -n: never prompt, fail instead
    execFile(cmd, argv, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, stdout: String(stdout || ''), error: String(stderr || err.message).trim() });
      resolve({ ok: true, stdout: String(stdout || ''), error: null });
    });
  });
}

/**
 * A hub bound to one interface.
 *
 * `exec` is injectable so the whole thing can be tested without WireGuard installed — which also
 * means the tests exercise the real command construction rather than a mock of it.
 */
export function createHub({ iface = 'wg0', wgBin = '/usr/bin/wg', quickBin = '/usr/bin/wg-quick', sudo = true, exec = run } = {}) {
  const wg = (args, opts) => exec(wgBin, args, { sudo, ...opts });

  return {
    iface,

    /** Is the hub actually usable from here? Reports WHY not, since that is the useful part. */
    async status() {
      const args = showDumpArgs(iface);
      if (!args) return { available: false, reason: `"${iface}" is not a valid interface name`, iface };
      const r = await wg(args);
      if (r.ok) return { available: true, iface, ...parseWgDump(r.stdout) };

      // Turn whatever went wrong into something a person can act on. The specific cases get
      // specific wording; everything else still gets the one instruction that fixes almost all of
      // them, rather than a raw multi-line dump of sudo's opinions.
      const err = (r.error || '').trim();
      const SETUP = 'Run this once on the server:  sudo bash /opt/netinv/deploy/wireguard-setup.sh';
      let reason;
      if (/not found|ENOENT|No such file or directory|command not found/i.test(err))
        reason = `WireGuard is not installed on this server. ${SETUP}`;
      else if (/Unable to access interface|No such device|Cannot find device/i.test(err))
        reason = `The ${iface} interface does not exist yet. ${SETUP}`;
      else if (/^sudo:|sudo:/m.test(err))
        reason = `This service is not permitted to run wg. ${SETUP}`;
      else if (/Operation not permitted|Permission denied/i.test(err))
        reason = `Permission denied running wg. ${SETUP}`;
      else
        reason = `Could not read the WireGuard interface: ${err.split('\n')[0].slice(0, 160)}. ${SETUP}`;
      return { available: false, reason, raw: err, iface };
    },

    async listPeers() {
      const r = await wg(showDumpArgs(iface));
      return r.ok ? parseWgDump(r.stdout).peers : [];
    },

    async addPeer(peer) {
      const args = addPeerArgs(iface, peer);
      if (!args) return { ok: false, error: 'That peer has an invalid key or allowed-ips' };
      return wg(args);
    },

    async removePeer(publicKey) {
      const args = removePeerArgs(iface, publicKey);
      if (!args) return { ok: false, error: 'That is not a valid WireGuard public key' };
      return wg(args);
    },

    /**
     * Write the running configuration to disk.
     *
     * Without this, everything added since boot is lost on the next restart — the interface comes
     * back up from a file that never learned about it. Peers would vanish with no error anywhere.
     */
    async save() {
      if (!isIface(iface)) return { ok: false, error: 'invalid interface' };
      return exec(quickBin, ['save', iface], { sudo });
    },

    /**
     * Make the hub match `desired`, then persist.
     * @param desired [{ publicKey, allowedIps, keepalive, name }]
     */
    async sync(desired) {
      const st = await this.status();
      if (!st.available) return { ok: false, applied: null, reason: st.reason };

      const plan = diffPeers(desired, st.peers);
      const failures = [];
      for (const p of [...plan.add, ...plan.update]) {
        const r = await this.addPeer(p);
        if (!r.ok) failures.push({ peer: p.name || p.publicKey, error: r.error });
      }
      for (const key of plan.remove) {
        const r = await this.removePeer(key);
        if (!r.ok) failures.push({ peer: key, error: r.error });
      }

      let saved = { ok: true };
      if (plan.add.length || plan.update.length || plan.remove.length) saved = await this.save();

      return {
        ok: failures.length === 0 && saved.ok,
        applied: { added: plan.add.length, updated: plan.update.length, removed: plan.remove.length },
        saved: saved.ok,
        save_error: saved.ok ? null : saved.error,
        failures
      };
    }
  };
}
