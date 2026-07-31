// GitHub account + tool-permission APIs.
//
// The token is per user and write-only over the wire: it goes in, it never
// comes back out (maskAccount). Connecting verifies the token against
// /user first, so a typo fails here instead of halfway through a commit.
import { requireAuth } from '../auth.js';
import {
  deleteGithubAccount, githubAccount, listRepos, maskAccount,
  repoInfo, saveGithubAccount, setDefaultRepo, verifyToken,
} from '../github.js';
import {
  auditSummary, MODES, recentAudit, setUserPolicy, TOOL_RISK, userPolicy,
} from '../permissions.js';

export default async function githubRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // ---------- account ----------

  app.get('/api/github', async (req) => ({
    account: maskAccount(githubAccount(req.user.id)),
  }));

  app.post('/api/github', async (req, reply) => {
    const token = String(req.body?.token ?? '').trim();
    if (!token) return reply.code(400).send({ error: 'a personal access token is required' });
    let who;
    try { who = await verifyToken(token); }
    catch (err) { return reply.code(400).send({ error: String(err.message ?? err) }); }
    const acct = saveGithubAccount(req.user.id, {
      login: who.login,
      token,
      scopes: who.scopes,
      defaultRepo: String(req.body?.default_repo ?? '').trim() || null,
    });
    req.log.info({ login: who.login }, 'github account connected');
    return { ok: true, account: maskAccount(acct) };
  });

  app.patch('/api/github', async (req, reply) => {
    if (!githubAccount(req.user.id)) return reply.code(404).send({ error: 'no GitHub account connected' });
    if (req.body?.default_repo !== undefined) {
      setDefaultRepo(req.user.id, String(req.body.default_repo ?? '').trim());
    }
    return { ok: true, account: maskAccount(githubAccount(req.user.id)) };
  });

  app.delete('/api/github', async (req) => ({ ok: deleteGithubAccount(req.user.id) }));

  app.get('/api/github/repos', async (req, reply) => {
    if (!githubAccount(req.user.id)) return reply.code(404).send({ error: 'no GitHub account connected' });
    try { return { repos: await listRepos(req.user.id, { limit: Number(req.query?.limit) || 50 }) }; }
    catch (err) { return reply.code(502).send({ error: String(err.message ?? err) }); }
  });

  app.get('/api/github/repo', async (req, reply) => {
    try { return await repoInfo(req.user.id, String(req.query?.repo ?? '')); }
    catch (err) { return reply.code(400).send({ error: String(err.message ?? err) }); }
  });

  // ---------- tool permissions ----------

  app.get('/api/permissions', async (req) => ({
    policy: userPolicy(req.user.id),
    modes: Object.keys(MODES),
    tools: Object.entries(TOOL_RISK).map(([tool, risk]) => ({ tool, risk })),
    summary: auditSummary(req.user.id, { days: 7 }),
  }));

  app.put('/api/permissions', async (req, reply) => {
    const mode = req.body?.mode;
    if (mode !== undefined && !MODES[mode]) {
      return reply.code(400).send({ error: `mode must be one of ${Object.keys(MODES).join(', ')}` });
    }
    return { ok: true, policy: setUserPolicy(req.user.id, req.body ?? {}) };
  });

  // The auto-mode review: what ran on its own while you were reading the reply.
  app.get('/api/permissions/audit', async (req) => ({
    events: recentAudit(req.user.id, {
      limit: Number(req.query?.limit) || 100,
      since: Number(req.query?.since) || 0,
    }),
    summary: auditSummary(req.user.id, { days: Number(req.query?.days) || 7 }),
  }));
}
