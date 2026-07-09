import {
  clientIp, clearFailures, createSession, createUser, destroySession,
  lockedUntil, recordFailure, requireAuth, sessionUser, userCount, verifyPassword,
} from '../auth.js';
import { db } from '../db.js';

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
    return { id: user.id, username: user.username, role: user.role };
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
    return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
  });
}
