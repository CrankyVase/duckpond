import { randomBytes } from 'node:crypto';
import {
  clientIp, clearFailures, createSession, createUser, destroySession, hashPassword,
  lockedUntil, recordFailure, requireAuth, sessionUser, userCount, verifyPassword,
} from '../auth.js';
import { db, nowSec } from '../db.js';
import { DEFAULT_CORE_PROMPT, getSetting, setSetting } from '../settings.js';

const INVITE_TTL_SEC = 7 * 24 * 60 * 60; // unused links die after a week

const COOKIE_OPTS = {
  path: '/', httpOnly: true, sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * 30,
};

export default async function authRoutes(app) {
  // First-run: if no users exist, the first signup becomes the owner.
  app.get('/api/auth/setup-needed', async () => ({ setupNeeded: userCount() === 0 }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (userCount() > 0) return reply.code(403).send({ error: 'already set up' });
    const { username, password } = req.body ?? {};
    if (!username?.match(/^[a-zA-Z0-9_-]{2,32}$/) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'username 2-32 chars [a-zA-Z0-9_-], password ≥ 8 chars' });
    }
    const id = await createUser(username, password, 'owner');
    reply.setCookie('dp_session', createSession(id), COOKIE_OPTS);
    return { ok: true, username, role: 'owner' };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) return reply.code(400).send({ error: 'missing credentials' });
    const ip = clientIp(req);

    const until = lockedUntil(username, ip);
    if (until) {
      return reply.code(429).send({ error: 'locked', retryAfterSec: until - Math.floor(Date.now() / 1000) });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = user && await verifyPassword(user.pass_hash, password);
    if (!ok) {
      recordFailure(username, ip);
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    clearFailures(username, ip);
    reply.setCookie('dp_session', createSession(user.id), COOKIE_OPTS);
    return { ok: true, username: user.username, role: user.role };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.cookies?.dp_session) destroySession(req.cookies.dp_session);
    reply.clearCookie('dp_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = sessionUser(req.cookies?.dp_session);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const row = db.prepare(
      'SELECT default_model_id, allow_image_gen, image_quality, memory_enabled, ui_theme FROM users WHERE id = ?',
    ).get(user.id);
    return {
      id: user.id, username: user.username, role: user.role,
      default_model_id: row.default_model_id,
      allow_image_gen: !!row.allow_image_gen,
      image_quality: row.image_quality,
      memory_enabled: !!row.memory_enabled,
      ui_theme: row.ui_theme ? JSON.parse(row.ui_theme) : null,
    };
  });

  // per-user preferences that must survive across browsers (e.g. default model)
  app.patch('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const { default_model_id, allow_image_gen, image_quality } = req.body ?? {};
    if (default_model_id !== undefined) {
      db.prepare('UPDATE users SET default_model_id = ? WHERE id = ?')
        .run(default_model_id || null, req.user.id);
    }
    if (allow_image_gen !== undefined) {
      db.prepare('UPDATE users SET allow_image_gen = ? WHERE id = ?')
        .run(allow_image_gen ? 1 : 0, req.user.id);
    }
    if (image_quality !== undefined && ['fast', 'medium', 'high'].includes(image_quality)) {
      db.prepare('UPDATE users SET image_quality = ? WHERE id = ?')
        .run(image_quality, req.user.id);
    }
    if (req.body?.memory_enabled !== undefined) {
      db.prepare('UPDATE users SET memory_enabled = ? WHERE id = ?')
        .run(req.body.memory_enabled ? 1 : 0, req.user.id);
    }
    if (req.body?.ui_theme !== undefined) {
      // whole-theme JSON blob from the Theme Studio; size-capped, shape-checked
      const json = req.body.ui_theme === null ? null : JSON.stringify(req.body.ui_theme);
      if (json && (json.length > 64_000 || typeof req.body.ui_theme !== 'object')) {
        return { ok: false, error: 'theme too large' };
      }
      db.prepare('UPDATE users SET ui_theme = ? WHERE id = ?').run(json, req.user.id);
    }
    return { ok: true };
  });

  // Owner-only user management (invite friends).
  app.post('/api/auth/users', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { username, password } = req.body ?? {};
    if (!username?.match(/^[a-zA-Z0-9_-]{2,32}$/) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'username 2-32 chars [a-zA-Z0-9_-], password ≥ 8 chars' });
    }
    try {
      const id = await createUser(username, password, 'friend');
      return { ok: true, id, username };
    } catch (e) {
      if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'username taken' });
      throw e;
    }
  });

  app.get('/api/auth/users', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    return db.prepare(`
      SELECT u.id, u.username, u.role, u.created_at,
             (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
             (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversations
      FROM users u ORDER BY u.id`).all();
  });

  app.delete('/api/auth/users/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });
    if (target.role === 'owner') return reply.code(403).send({ error: 'cannot delete the owner' });
    db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions + convs cascade
    return { ok: true };
  });

  // Change own password: requires the current one, invalidates every other session.
  app.post('/api/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const { current, next } = req.body ?? {};
    if (!next || next.length < 8) return reply.code(400).send({ error: 'new password must be ≥ 8 chars' });
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(row.pass_hash, current ?? ''))) {
      return reply.code(401).send({ error: 'current password is wrong' });
    }
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.user.sid);
    return { ok: true };
  });

  // ----- invite links: owner mints a one-time URL; the recipient picks their
  // own username + password; the token dies on use / expiry / revoke -----

  app.post('/api/auth/invites', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const token = randomBytes(24).toString('base64url');
    const r = db.prepare('INSERT INTO invites (token, created_by, expires_at) VALUES (?, ?, ?)')
      .run(token, req.user.id, nowSec() + INVITE_TTL_SEC);
    return { id: r.lastInsertRowid, token, path: `/invite/${token}`, expires_at: nowSec() + INVITE_TTL_SEC };
  });

  app.get('/api/auth/invites', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    return db.prepare(`
      SELECT i.id, i.token, i.created_at, i.expires_at, i.used_at,
             u.username AS used_by_name
      FROM invites i LEFT JOIN users u ON u.id = i.used_by
      ORDER BY i.id DESC LIMIT 50`).all()
      .map((i) => ({
        ...i,
        path: `/invite/${i.token}`,
        status: i.used_at ? 'used' : (i.expires_at < nowSec() ? 'expired' : 'pending'),
      }));
  });

  app.delete('/api/auth/invites/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    db.prepare('DELETE FROM invites WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // public: the invite page checks its token before showing the form
  app.get('/api/auth/invite/:token', async (req) => {
    const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
    if (!inv || inv.used_at) return { valid: false, reason: 'This invite link has already been used or revoked.' };
    if (inv.expires_at < nowSec()) return { valid: false, reason: 'This invite link has expired.' };
    return { valid: true, expires_at: inv.expires_at };
  });

  // public: redeem the token — creates the account and signs the new user in
  app.post('/api/auth/invite/:token', async (req, reply) => {
    const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
    if (!inv || inv.used_at || inv.expires_at < nowSec()) {
      return reply.code(410).send({ error: 'invite link is no longer valid' });
    }
    const { username, password } = req.body ?? {};
    if (!username?.match(/^[a-zA-Z0-9_-]{2,32}$/) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'username 2-32 chars [a-zA-Z0-9_-], password ≥ 8 chars' });
    }
    let id;
    try {
      id = await createUser(username, password, 'friend');
    } catch (e) {
      if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'username taken' });
      throw e;
    }
    // burn the token only after the account exists; losing the race to a
    // second concurrent redeem is prevented by re-checking used_at here
    const burned = db.prepare('UPDATE invites SET used_by = ?, used_at = unixepoch() WHERE id = ? AND used_at IS NULL')
      .run(id, inv.id);
    if (!burned.changes) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return reply.code(410).send({ error: 'invite link is no longer valid' });
    }
    reply.setCookie('dp_session', createSession(id), COOKIE_OPTS);
    return { ok: true, username, role: 'friend' };
  });

  // ----- core prompt: owner-editable conduct rules fronting every chat -----

  app.get('/api/admin/settings', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const stored = getSetting('core_prompt');
    return {
      core_prompt: stored ?? DEFAULT_CORE_PROMPT,
      customized: stored !== null,
      default_core_prompt: DEFAULT_CORE_PROMPT,
    };
  });

  app.put('/api/admin/settings', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { core_prompt } = req.body ?? {};
    if (core_prompt !== undefined) {
      const v = String(core_prompt ?? '').slice(0, 20_000);
      // saving the default text (or blank) = back to stock
      setSetting('core_prompt', v.trim() && v !== DEFAULT_CORE_PROMPT ? v : null);
    }
    const stored = getSetting('core_prompt');
    return { ok: true, core_prompt: stored ?? DEFAULT_CORE_PROMPT, customized: stored !== null };
  });

  // Owner-only lockout management (same data the admin.mjs CLI touches).
  app.get('/api/admin/bans', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    return db.prepare('SELECT key, fails, locked_until, updated_at FROM login_attempts ORDER BY updated_at DESC')
      .all().map((r) => ({ ...r, active: r.locked_until > nowSec() }));
  });

  app.post('/api/admin/unban', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { key } = req.body ?? {};
    if (!key) return reply.code(400).send({ error: 'missing key' });
    db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
    return { ok: true };
  });
}
