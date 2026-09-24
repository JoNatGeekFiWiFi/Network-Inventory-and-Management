// Run one command on a device over SSH and collect its output.
//
// This exists because OpenWrt's HTTP bus is optional and DD-WRT has no API at all, so SSH is the
// only universal way in. It is deliberately narrow:
//
//   * ARGV ONLY. The command is an array and is quoted here; nothing is built by string
//     concatenation. The far end is a shell running as root and the arguments include values that
//     came out of the database, so `logread -l ${n}` with an unexpected `n` would be a remote root
//     command injection. Every argument is single-quoted with embedded quotes escaped, and the
//     command word itself must match a strict pattern.
//   * ONE command, then disconnect. No interactive session, no shell to leave open.
//   * ssh2 is imported lazily, so the server still boots if the dependency is missing — the same
//     approach domains/network.js already takes for SFTP config retrieval.

/** The command word. Arguments may be anything (they get quoted); the binary may not. */
const COMMAND_RE = /^[a-zA-Z0-9_./-]{1,64}$/;

/**
 * POSIX single-quote one argument.
 *
 * Inside single quotes a shell treats every character literally, including $, `, \ and ;. The only
 * character that cannot appear is a single quote itself, which is closed, escaped and reopened:
 * it's  →  'it'\''s'
 */
export function shellQuote(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/** Turn an argv array into a safe command line, or null if the command word is not acceptable. */
export function buildCommand(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const [cmd, ...rest] = argv;
  if (!COMMAND_RE.test(String(cmd))) return null;
  return [String(cmd), ...rest.map(shellQuote)].join(' ');
}

/**
 * Execute one command.
 *
 * Always resolves — never rejects — because every caller wants to report the failure rather than
 * have it propagate as an unhandled error out of a poll loop running over hundreds of devices.
 *
 * @returns {Promise<{ok, stdout, stderr, code, error, unreachable}>}
 */
export async function sshExec({ host, username, password, port = 22, timeoutMs = 12000, argv, privateKey = null, stdin = null }) {
  const command = buildCommand(argv);
  if (!command) return { ok: false, error: 'Refusing to run that command', stdout: '', stderr: '' };

  let SshClient;
  try {
    const mod = await import('ssh2');
    SshClient = mod.Client || (mod.default && mod.default.Client);
  } catch { return { ok: false, error: 'SSH support is not installed on the server (ssh2)', stdout: '', stderr: '' }; }
  if (!SshClient) return { ok: false, error: 'SSH support is not installed on the server (ssh2)', stdout: '', stderr: '' };

  return new Promise((resolve) => {
    const conn = new SshClient();
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { conn.end(); } catch {} resolve(r); };
    const timer = setTimeout(
      () => finish({ ok: false, error: `No response from ${host} within ${Math.round(timeoutMs / 1000)}s`, unreachable: true, stdout: '', stderr: '' }),
      timeoutMs
    );

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return finish({ ok: false, error: err.message, stdout: '', stderr: '' }); }
        let out = '', errOut = '', code = null;
        stream.on('close', (c) => {
          clearTimeout(timer);
          code = c;
          // A non-zero exit is reported rather than thrown: `uci get` returning 1 for a missing key
          // is information, not a fault.
          finish({ ok: c === 0, code: c, stdout: out, stderr: errOut, error: c === 0 ? null : (errOut.trim() || `exited ${c}`) });
        });
        stream.on('data', (d) => { if (out.length < 256 * 1024) out += d.toString('utf8'); });
        // Bytes to feed the command — a firmware image to `dd`, say.
        if (stdin) stream.end(stdin);
        stream.stderr.on('data', (d) => { if (errOut.length < 32 * 1024) errOut += d.toString('utf8'); });
      });
    });

    conn.on('error', (e) => {
      clearTimeout(timer);
      // The distinction matters to the prober: refused means nothing is listening, while an
      // authentication failure means SSH is there and the credentials are wrong.
      const auth = /authentication|All configured authentication methods failed/i.test(e.message);
      finish({
        ok: false,
        // Name the account. "SSH rejected the username or password" sent someone looking at the
        // password when the actual problem was that an OpenWrt device was being addressed as
        // `admin` — the username was never on screen, so it was never the suspect.
        error: auth ? `SSH rejected the login for "${username}" (wrong username or password)` : e.message,
        authFailed: auth,
        unreachable: !auth && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(e.code || e.message),
        stdout: '', stderr: ''
      });
    });

    try {
      conn.connect({
        host, port, username,
        ...(privateKey ? { privateKey } : { password }),
        readyTimeout: timeoutMs,
        // Vendor builds ship old dropbear. Without widening the algorithm lists, the handshake with
        // a Katalyst-class device fails before authentication is even attempted, which reads as
        // "unreachable" and sends someone to site for nothing.
        algorithms: {
          kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256',
                'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'],
          serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-256', 'ssh-rsa'],
          cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr', 'aes128-cbc']
        }
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: e.message, stdout: '', stderr: '' });
    }
  });
}
