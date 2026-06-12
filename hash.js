// Password hashing with Node's built-in scrypt (no native deps)
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = scryptSync(String(pw), salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return test.length === orig.length && timingSafeEqual(test, orig);
}
