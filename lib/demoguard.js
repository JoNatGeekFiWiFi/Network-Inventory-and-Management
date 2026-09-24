// Demo mode's one hard rule: the demo can never reach a real device, mailbox or service.
//
// The demo runs the same code as production, and that code knows how to SSH into routers, push
// firewall rules, send email and texts, and call ZeroTier and Google. Guarding each of those call
// sites separately would be a list that the next feature quietly falls off. So the guard sits
// underneath all of them: every outbound TCP connection in the process goes through
// net.Socket.prototype.connect — ssh2, FTP, nodemailer, imapflow, fetch/undici and https all do —
// and in demo mode that refuses anything that is not loopback or on a short allow-list.
//
// Loopback stays open because the demo talks to itself (and asks production, on 127.0.0.1, for
// anonymised traffic shapes). Nothing else is allowed — not even the map's address search: on the
// server the systemd unit also firewalls the process to localhost (IPAddressAllow=localhost), and
// the two layers should agree. Everything else fails immediately with an error that says why, which
// the existing error handling already shows the visitor ("could not reach the router").
//
// Installed by the first import in server.js, and only when DEMO_MODE=1. Production never loads the
// patch at all.
import net from 'node:net';

export const DEMO = process.env.DEMO_MODE === '1';
export const DEMO_ALLOWED_HOSTS = new Set();
export const DEMO_REFUSAL = 'Demo mode: connections to real equipment and outside services are switched off.';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Where a connect() call is going, from any of its call shapes. null for a unix socket path. */
export function connectTarget(args) {
  const a = args[0];
  if (Array.isArray(a)) return connectTarget(a);                 // internal normalized-args form
  if (a && typeof a === 'object') {
    if (a.path) return null;
    return { host: String(a.host || a.hostname || 'localhost'), port: a.port };
  }
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) };
  }
  if (typeof a === 'string') return null;                         // a path
  return { host: 'localhost', port: undefined };
}

export function allowedInDemo(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(h) || h.startsWith('127.') || DEMO_ALLOWED_HOSTS.has(h);
}

let installed = false;
export function installDemoNetworkGuard() {
  if (installed) return;
  installed = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = connectTarget(args);
    if (t && !allowedInDemo(t.host)) {
      const err = Object.assign(new Error(`${DEMO_REFUSAL} (${t.host}${t.port ? ':' + t.port : ''})`), { code: 'EDEMO' });
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return original.apply(this, args);
  };
  console.log('Demo mode: outbound connections limited to loopback');
}

if (DEMO) installDemoNetworkGuard();
