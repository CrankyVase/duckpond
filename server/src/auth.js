import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db, nowSec } from './db.js';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const LOCK_BASE_SEC = 15 * 60;         // first lockout: 15 min, doubling
const LOCK_CAP_SEC = 24 * 60 * 60;
const FAILS_PER_USER = 5;
const FAILS_PER_IP = 15;               // looser: shared/CGNAT IPs

// OWASP-recommended argon2id defaults
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw) => argon2.hash(pw, ARGON_OPTS);
export const verifyPassword = (hash, pw) => argon2.verify(hash, pw).catch(() => false);

// The app binds 127.0.0.1 behind cloudflared, so CF-Connecting-IP is the only
// trustworthy client identity; direct LAN hits (no header) fall back to socket ip.
export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || 'unknown';
}

function lockRow(key) {
  return db.prepare('SELECT * FROM login_attempts WHERE key = ?').get(key);
}

export function lockedUntil(username, ip) {
  const now = nowSec();
  let until = 0;
  for (const key of [`user:${username.toLowerCase()}`, `ip:${ip}`]) {
    const row = lockRow(key);
    if (row && row.locked_until > now) until = Math.max(until, row.locked_until);
  }
  return until;
}

export function recordFailure(username, ip) {
  const now = nowSec();
  const bump = db.prepare(`
    INSERT INTO login_attempts (key, fails, updated_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET fails = fails + 1, updated_at = excluded.updated_at
    RETURNING fails`);
  for (const [key, limit] of [[`user:${username.toLowerCase()}`, FAILS_PER_USER], [`ip:${ip}`, FAILS_PER_IP]]) {
    const { fails } = bump.get(key, now);
    if (fails >= limit) {
      const over = fails - limit;
      const lockFor = Math.min(LOCK_BASE_SEC * 2 ** over, LOCK_CAP_SEC);
      db.prepare('UPDATE login_attempts SET locked_until = ? WHERE key = ?').run(now + lockFor, key);
    }
  }
}

export function clearFailures(username, ip) {
  db.prepare('DELETE FROM login_attempts WHERE key IN (?, ?)')
    .run(`user:${username.toLowerCase()}`, `ip:${ip}`);
}

export function createSession(userId) {
  const id = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(id, userId, nowSec() + SESSION_TTL);
  return id;
}

export function destroySession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function sessionUser(id) {
  if (!id) return null;
  const row = db.prepare(`
    SELECT s.id AS sid, u.id, u.username, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > unixepoch()`).get(id);
  if (row) db.prepare('UPDATE sessions SET last_seen = unixepoch() WHERE id = ?').run(id);
  return row ?? null;
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export async function createUser(username, password, role = 'friend') {
  const hash = await hashPassword(password);
  return db.prepare('INSERT INTO users (username, pass_hash, role) VALUES (?, ?, ?)')
    .run(username, hash, role).lastInsertRowid;
}

// Fastify preHandler: attaches req.user or replies 401.
export function requireAuth(req, reply, done) {
  const user = sessionUser(req.cookies?.dp_session);
  if (!user) { reply.code(401).send({ error: 'unauthorized' }); return; }
  req.user = user;
  done();
}
