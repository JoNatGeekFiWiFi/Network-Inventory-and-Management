// Session management for the Network Inventory & Management Platform
import { randomBytes } from 'node:crypto';
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
export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}
