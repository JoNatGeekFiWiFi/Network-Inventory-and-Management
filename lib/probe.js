// What is this router, and what will it let us do?
//
// Written because of a specific problem: the Katalyst Spark is OpenWrt underneath a vendor skin,
// and no datasheet says whether that skin leaves rpcd, the ubus HTTP endpoint or dropbear reachable.
// Guessing produces a driver that works on the bench and fails on the third unit. So instead of
// designing against assumptions, this asks ONE real device and reports exactly what answered.
//
// The rule it follows: every finding is something that was observed, and the suggestion at the end
// is derived only from findings. Where nothing answered, it says nothing answered — it does not
// fall back to a plausible-sounding default, because a wrong platform assignment is worse than an
// unassigned one (the poller then fails every cycle for a reason nobody can see).
//
// Read-only throughout. Nothing here writes to a device.

import { parseRpc, sessionFromLogin, loginEnvelope, rpcEnvelope, parseBoard } from './drivers/openwrt.js';

/** The ports worth knocking on, and what each would mean. */
export const PROBE_PORTS = [
  { port: 22,   name: 'SSH',        hint: 'dropbear or OpenSSH — the universal fallback' },
  { port: 80,   name: 'HTTP',       hint: 'LuCI, a vendor UI, or the RouterOS www service' },
  { port: 443,  name: 'HTTPS',      hint: 'RouterOS www-ssl, or a vendor UI over TLS' },
  { port: 8080, name: 'HTTP alt',   hint: 'some vendor skins move their UI here' },
  { port: 8443, name: 'HTTPS alt',  hint: 'as above, over TLS' },
  { port: 8291, name: 'Winbox',     hint: 'conclusive evidence of MikroTik' }
];

/**
 * Probe one device.
 *
 * @param target { host, username, password, sshUsername }
 * @param deps   { tcpProbe, httpRequest, sshExec } — all injected, so the whole decision tree is
 *               testable against recorded responses with no hardware and no network.
 */
export async function probeDevice(target, deps) {
  const { host } = target;
  const username = target.username || 'admin';
  const password = target.password || '';
  const { tcpProbe, httpRequest, sshExec } = deps;

  const findings = [];
  const add = (check, ok, detail, extra = {}) => { findings.push({ check, ok, detail, ...extra }); return ok; };

  if (!host) return { ok: false, error: 'No management address to probe', findings: [], suggested: null };

  // ---- 1. what is even listening ---------------------------------------------------------------
  const openPorts = [];
  await Promise.all(PROBE_PORTS.map(async (p) => {
    const r = await tcpProbe(host, p.port);
    if (r.open) openPorts.push(p.port);
    add(`port ${p.port} (${p.name})`, r.open, r.open ? `open — ${p.hint}` : (r.reason || 'closed'));
  }));

  if (!openPorts.length) {
    return {
      ok: false, host, findings, openPorts, suggested: null,
      summary: `Nothing on ${host} answered on any management port. Either the server is not on the overlay this device is in, the address is wrong, or the device is down.`
    };
  }

  // ---- 2. MikroTik? ----------------------------------------------------------------------------
  // Checked first and cheaply, because Winbox on 8291 settles it without any credentials.
  let routeros = openPorts.includes(8291);
  if (routeros) add('MikroTik Winbox', true, 'port 8291 is open, which only RouterOS serves');

  // A 401 is NOT proof. Plenty of web servers answer 401 to an unknown path, so concluding
  // "RouterOS" from one would assign the wrong driver to any password-protected vendor UI and the
  // poller would then fail forever against an API that was never there. It is recorded as a hint,
  // and only a parsed response (or Winbox) actually decides.
  let routerosHint = false;
  for (const scheme of ['https', 'http']) {
    const p = scheme === 'https' ? 443 : 80;
    if (!openPorts.includes(p)) continue;
    const r = await httpRequest({
      url: `${scheme}://${host}/rest/system/resource`,
      headers: { Authorization: basic(username, password), Accept: 'application/json' }
    });
    if (r.status === 200) {
      const j = safeJson(r.body);
      const o = Array.isArray(j) ? j[0] : j;
      if (o && (o.version || o['board-name'])) {
        routeros = true;
        add('RouterOS REST', true, `answered on ${scheme} — ${o['board-name'] || 'board'} running ${o.version || 'unknown version'}`,
          { version: o.version, board: o['board-name'] });
        break;
      }
    } else if (r.status === 401) {
      routerosHint = true;
      add('RouterOS REST', false,
        `something on ${scheme} asked for credentials and rejected them (401). That MIGHT be the RouterOS REST API with the wrong password, or any other protected web UI.`,
        { authFailed: true });
    }
  }

  // ---- 3. OpenWrt over HTTP --------------------------------------------------------------------
  //
  // The decisive test for the vendor skins. A skin can replace LuCI entirely and still leave this
  // endpoint working, so it is tried regardless of what the web UI looks like.
  let ubusHttp = null, grantedObjects = null;
  if (!routeros) {
    for (const scheme of ['http', 'https']) {
      const p = scheme === 'https' ? 443 : 80;
      if (!openPorts.includes(p)) continue;
      const url = `${scheme}://${host}/ubus`;
      const r = await httpRequest({
        url, method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(loginEnvelope(username || 'root', password))
      });
      if (r.status === 404 || r.status === 0) {
        add(`ubus endpoint (${scheme})`, false, r.status === 404
          ? 'not found — uhttpd-mod-ubus is not installed or the vendor removed it'
          : (r.error || 'no response'));
        continue;
      }
      const parsed = parseRpc(r.body);
      const sid = sessionFromLogin(parsed);
      if (sid) {
        ubusHttp = { scheme, url, session: sid };
        add(`ubus over ${scheme}`, true, 'logged in — this device is fully manageable over HTTP', { url });
        break;
      }

      // Distinguishing "the endpoint is there and said no" from "something else answered" matters,
      // and the original code got it wrong: it inferred the endpoint was present from the response
      // merely not being a 404. A vendor web UI that serves its index page for every unknown path
      // returns 200 with HTML, which was then reported as "the endpoint exists but login failed" —
      // sending someone to check a password when the endpoint was never installed at all.
      const looksLikeUbus = parsed.ok || typeof parsed.code === 'number' || parsed.expired;
      add(`ubus over ${scheme}`, false,
        looksLikeUbus
          ? `the ubus endpoint is there but the login was refused: ${parsed.error}`
          : `something answered at ${url}, but not ubus — it returned ${describeBody(r.body)}. uhttpd-mod-ubus is probably not installed.`,
        { endpointPresent: looksLikeUbus, authFailed: looksLikeUbus, url });
    }
  }

  // If ubus answered, ask it what the device is. This is the line that will tell us what a
  // Katalyst calls itself.
  let board = null;
  if (ubusHttp) {
    const r = await httpRequest({
      url: ubusHttp.url, method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpcEnvelope(ubusHttp.session, 'system', 'board'))
    });
    const parsed = parseRpc(r.body);
    if (parsed.ok) {
      board = parseBoard(parsed.data);
      add('system board', true, `${board.model || 'unknown model'} — ${board.osVersion || 'unknown build'}`, { board });
    } else {
      add('system board', false, parsed.error);
    }

    // Which ubus objects the login's ACL actually grants. This is the difference between "OpenWrt"
    // and "OpenWrt we can do anything useful with", and it is invisible from the web UI.
    const objs = ['network.device', 'network.interface', 'iwinfo', 'system', 'file', 'luci-rpc', 'uci'];
    const granted = [];
    for (const o of objs) {
      const probe = o === 'iwinfo' ? ['devices', {}]
        : o === 'network.device' ? ['status', {}]
        : o === 'network.interface' ? ['dump', {}]
        : o === 'system' ? ['info', {}]
        : o === 'file' ? ['read', { path: '/etc/openwrt_release' }]
        : o === 'luci-rpc' ? ['getDHCPLeases', {}]
        : ['get', { config: 'system' }];
      const rr = await httpRequest({
        url: ubusHttp.url, method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rpcEnvelope(ubusHttp.session, o, probe[0], probe[1]))
      });
      const pp = parseRpc(rr.body);
      if (pp.ok) granted.push(o);
      add(`ubus ${o}`, pp.ok, pp.ok ? 'available' : pp.error);
    }
    grantedObjects = granted;
  }

  // ---- 4. SSH ----------------------------------------------------------------------------------
  //
  // Tried even when HTTP worked, because knowing both paths exist is what makes the driver
  // resilient — and because on a locked-down skin SSH is often the only one.
  let ssh = null;
  if (openPorts.includes(22) && sshExec) {
    const user = target.sshUsername || (routeros ? username : 'root');
    const r = await sshExec({ host, username: user, password, argv: ['ubus', '-S', 'call', 'system', 'board'], timeoutMs: 12000 });
    if (r.ok) {
      const j = safeJson(r.stdout);
      if (j) {
        ssh = { user, ubus: true };
        board = board || parseBoard(j);
        // The username is stated, and flagged when it differs from the one on the device record —
        // otherwise a probe that succeeds as `root` looks like proof that a device stored as
        // `admin` will poll, and it will not.
        const differs = user !== username;
        add('ubus over SSH', true,
          `works as ${user} — ${board.model || 'unknown model'}, ${board.osVersion || 'unknown build'}` +
          (differs ? `. NOTE: this device is saved with the username "${username}", which will not work — accepting this result corrects it.` : ''),
          { board, user, usernameDiffers: differs });

        // Which objects this build actually has. Originally only done on the HTTP path, which meant
        // an SSH-only device — the exact case this exists to handle — reported nothing at all about
        // its capabilities. Over SSH as root there is no ACL in the way, so this is a straight
        // inventory of what is installed: the thing that decides which monitoring is real.
        if (!grantedObjects) {
          const ls = await sshExec({ host, username: user, password, argv: ['ubus', 'list'], timeoutMs: 10000 });
          if (ls.ok) {
            const objects = String(ls.stdout).split('\n').map(s => s.trim()).filter(Boolean);
            grantedObjects = objects;
            for (const want of ['network.device', 'network.interface', 'iwinfo', 'system', 'file', 'luci-rpc', 'uci']) {
              const have = objects.includes(want);
              add(`ubus ${want}`, have, have ? 'installed' : 'NOT installed on this build');
            }
          } else {
            add('ubus list', false, ls.error || 'could not enumerate ubus objects');
          }
        }
      } else {
        add('ubus over SSH', false, 'connected, but ubus returned nothing parseable');
      }
    } else if (r.authFailed) {
      add('SSH login', false, `SSH is running but rejected ${user} with this password`, { authFailed: true });
    } else {
      add('ubus over SSH', false, r.error || 'failed');
      // No ubus — so is it DD-WRT? nvram is its equivalent, and its presence is conclusive.
      const n = await sshExec({ host, username: user, password, argv: ['nvram', 'get', 'router_name'], timeoutMs: 10000 });
      if (n.ok) { ssh = { user, nvram: true }; add('DD-WRT nvram', true, `nvram answered ("${String(n.stdout).trim() || 'unnamed'}") — this is DD-WRT or a relative`); }
    }
  }

  // ---- 5. what all that adds up to -------------------------------------------------------------
  let suggested = null, transport = null, confidence = 'low', summary;
  if (routeros) {
    suggested = 'routeros'; transport = 'REST'; confidence = 'high';
    summary = 'MikroTik RouterOS — manage it exactly as the existing fleet.';
  } else if (ubusHttp) {
    suggested = 'openwrt'; transport = 'ubus over HTTP'; confidence = 'high';
    summary = `OpenWrt, reachable over HTTP${board && board.distribution ? ` (build identifies as "${board.distribution}")` : ''}. Monitoring will work without SSH.`;
  } else if (ssh && ssh.ubus) {
    suggested = 'openwrt'; transport = 'ubus over SSH'; confidence = 'high';
    summary = 'OpenWrt, but only over SSH — the vendor has removed or disabled the ubus HTTP endpoint. Monitoring works; it just needs the SSH path.';
  } else if (ssh && ssh.nvram) {
    suggested = 'ddwrt'; transport = 'SSH'; confidence = 'medium';
    summary = 'DD-WRT. Read-only monitoring over SSH is realistic; remote configuration is not.';
  } else {
    // Nothing identified itself. The two explanations are very different to act on, so say which
    // one the evidence points at rather than offering both every time.
    const rejected = findings.some(f => f.authFailed);
    const endpointSeen = findings.some(f => f.endpointPresent);
    const parts = [`Something is listening on ${host} (ports ${openPorts.join(', ')}) but nothing identified itself.`];
    if (rejected) {
      parts.push('The credentials are the most likely problem: every service that answered rejected this username and password.');
      if (endpointSeen) parts.push('The ubus endpoint IS present, so this is very probably OpenWrt — re-run with the right password and it should identify itself.');
      else if (routerosHint) parts.push('One service asked for credentials in a way RouterOS does, so check the MikroTik login too.');
    } else {
      parts.push('This looks like a vendor build with both the ubus endpoint and SSH closed, in which case it can only be tracked as inventory — serial, model, site and credentials, with no live monitoring.');
    }
    summary = parts.join(' ');
  }

  return {
    ok: true, host, openPorts, findings, board, grantedObjects,
    suggested, transport, confidence, summary,
    // Named so the UI can offer "set this device up like this" as one click. The transport is
    // included because it has to be REMEMBERED: a device reachable only over SSH would otherwise
    // wait out an HTTP timeout on every single poll before falling back, every minute, forever.
    // Everything needed to make the device work, not just to label it.
    //
    // The username matters as much as the platform and is easy to miss: the probe logs into a
    // non-MikroTik device as `root`, while the device form pre-fills `admin` because that is right
    // for RouterOS. So Identify would succeed, report the device correctly, and the very next poll
    // would fail with "SSH rejected the username or password" — the two were authenticating as
    // different people. Whatever actually worked is carried here so accepting the result fixes it.
    apply: suggested
      ? {
          platform: suggested,
          mgmt_transport: ubusHttp ? 'http' : (ssh ? 'ssh' : 'auto'),
          admin_username: ssh ? ssh.user : (ubusHttp ? (username || 'root') : null)
        }
      : null
  };
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

/** Name what came back, so "not ubus" is actionable rather than just a denial. */
function describeBody(body) {
  const s = String(body || '').trim();
  if (!s) return 'an empty response';
  if (/^\s*</.test(s)) return /<html/i.test(s.slice(0, 200)) ? 'an HTML page (probably the vendor web interface)' : 'XML or HTML';
  return `${JSON.stringify(s.slice(0, 60))}…`;
}
