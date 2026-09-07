// Session management for the Network Inventory & Management Platform
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 14;

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return null; }
  const u = db.prepare('SELECT id, name, email, role, active FROM users WHERE id=?').get(s.user_id);
  if (!u || !u.active) return null;
  return u;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}

// Cookie helpers
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Add Secure in production so the session cookie is never sent over plain HTTP — without it, one
// stray http:// link to the site hands the session token to anyone on the path. Left off when
// running locally, where there is no TLS and the flag would stop login working at all.
const SECURE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1' ? ' Secure;' : '';

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly;${SECURE} Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `sid=; HttpOnly;${SECURE} Path=/; SameSite=Lax; Max-Age=0`);
}

/** Delete sessions that have already expired. Called on a slow timer from the server. */
export function pruneSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run().changes;
}


// ---- device API tokens (phone / tablet apps) ----
//
// The flow is: mint once, show once, store only a hash. Nothing in the system can print an
// existing token back — a lost phone is answered by revoking and issuing a new one, never by
// looking the old one up.

const TOKEN_PREFIX = 'nim_';           // so a leaked string is recognisably ours in logs and scans
const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');

/** Mint a token for a device. Returns the plaintext ONCE; only the hash is kept. */
export function createApiToken(userId, { name, platform = null, expiresAt = null } = {}) {
  const secret = randomBytes(32).toString('base64url');
  const token = TOKEN_PREFIX + secret;
  const info = db.prepare(`INSERT INTO api_tokens (user_id, name, token_hash, prefix, platform, expires_at)
    VALUES (?,?,?,?,?,?)`).run(userId, String(name || 'Device').slice(0, 60), tokenHash(token),
      token.slice(0, TOKEN_PREFIX.length + 6), platform, expiresAt);
  return { id: info.lastInsertRowid, token };
}

/**
 * Resolve a bearer token to its user, or null.
 *
 * Also records when and from where it was last used. That write is the only way anyone notices a
 * token still being used by a device that was replaced months ago.
 */
export function userForApiToken(token, ip = null) {
  if (!token || !String(token).startsWith(TOKEN_PREFIX)) return null;
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash=?').get(tokenHash(token));
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  const u = db.prepare('SELECT id, name, email, role, active FROM users WHERE id=?').get(row.user_id);
  if (!u || !u.active) return null;
  // Cheap enough per request, and it is what makes an abandoned device visible.
  db.prepare("UPDATE api_tokens SET last_used_at=datetime('now'), last_ip=? WHERE id=?").run(ip, row.id);
  return { ...u, token_id: row.id, token_name: row.name };
}

/** Tokens a user holds. Never includes anything that could reconstruct the token. */
export function listApiTokens(userId) {
  return db.prepare(`SELECT id, name, prefix, platform, created_at, last_used_at, last_ip, expires_at, revoked_at
    FROM api_tokens WHERE user_id=? ORDER BY revoked_at IS NOT NULL, datetime(created_at) DESC`).all(userId);
}

/** Revoke one token. Scoped by user so nobody can revoke a token that is not theirs to revoke. */
export function revokeApiToken(id, userId = null) {
  const sql = userId == null
    ? "UPDATE api_tokens SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL"
    : "UPDATE api_tokens SET revoked_at=datetime('now') WHERE id=? AND user_id=? AND revoked_at IS NULL";
  return (userId == null ? db.prepare(sql).run(id) : db.prepare(sql).run(id, userId)).changes;
}

/** Every token in the system, with its owner. Admin view. */
export function allApiTokens() {
  return db.prepare(`SELECT t.id, t.name, t.prefix, t.platform, t.created_at, t.last_used_at, t.last_ip,
      t.expires_at, t.revoked_at, u.email AS user_email, u.name AS user_name, u.role AS user_role
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    ORDER BY t.revoked_at IS NOT NULL, datetime(t.created_at) DESC`).all();
}
