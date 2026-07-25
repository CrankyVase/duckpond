// Chat + conversation routes: CRUD, live-attach, stop, compaction, context.
// The main POST /chat streaming turn lives in ./chatPost.js (registered at the
// bottom); helpers in ../chatkit.js, policies in ../chatpolicy.js, turn flows
// in ../chatflow.js — the original single chat.js outgrew one file.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { countInputTokens, streamChat } from '../llama.js';
import { stopRunsForWorkspace } from './agent.js';
import {
  attachListener, getLiveJob, stopLiveJob,
} from '../liveJobs.js';
// remote providers + cost saver (feat/remote-providers)
import { auxModelFor, isRemoteId } from '../chatBackend.js';
import {
  auxBaselineCost, costFor, modelRowForRemoteId, recordEvent,
} from '../costs.js';
import {
  buildPrompt, convForUser, insertMessage, pathToRoot, setLeaf,
} from '../chatkit.js';
import { registerChatPost } from './chatPost.js';

// ---------- routes ----------

export default async function chatRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Stop / empty POSTs: browsers and some proxies send odd Content-Types (or
  // application/json with a zero-length body). Fastify then 415s before our
  // handler runs, so the run never aborts and the next chat 409s forever.
  const emptyBody = (req, body, done) => {
    if (body == null || body === '' || (Buffer.isBuffer(body) && body.length === 0)) {
      return done(null, {});
    }
    if (Buffer.isBuffer(body)) {
      try { return done(null, JSON.parse(body.toString('utf8') || '{}')); }
      catch (err) { return done(err); }
    }
    if (typeof body === 'string') {
      try { return done(null, JSON.parse(body || '{}')); }
      catch (err) { return done(err); }
    }
    done(null, body);
  };
  // only register once per app instance
  if (!app.hasContentTypeParser('application/json')) {
    app.addContentTypeParser('application/json', { parseAs: 'string' }, emptyBody);
  }
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    try {
      if (!app.hasContentTypeParser(ct)) {
        app.addContentTypeParser(ct, { parseAs: 'string' }, emptyBody);
      }
    } catch { /* already registered */ }
  }

  app.get('/api/conversations', async (req) =>
    db.prepare(`SELECT id, title, model_id, updated_at FROM conversations
                WHERE user_id = ? ORDER BY updated_at DESC`).all(req.user.id));

  app.post('/api/conversations', async (req) => {
    const { model_id } = req.body ?? {};
    const r = db.prepare('INSERT INTO conversations (user_id, model_id) VALUES (?, ?)')
      .run(req.user.id, model_id ?? null);
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.lastInsertRowid);
  });

  app.get('/api/conversations/:id', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const messages = db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id').all(conv.id);
    return { ...conv, messages, settings: conv._settings };
  });

  app.patch('/api/conversations/:id', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const { title, model_id, active_leaf_id, settings } = req.body ?? {};
    if (title !== undefined)
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(String(title).slice(0, 200), conv.id);
    if (model_id !== undefined)
      db.prepare('UPDATE conversations SET model_id = ? WHERE id = ?').run(model_id, conv.id);
    if (active_leaf_id !== undefined) {
      // never point the leaf at a message outside this conversation (or a deleted one)
      const ok = active_leaf_id == null
        || db.prepare('SELECT 1 FROM messages WHERE id = ? AND conv_id = ?').get(active_leaf_id, conv.id);
      if (ok) setLeaf(conv.id, active_leaf_id ?? null);
    }
    if (settings !== undefined)
      db.prepare('UPDATE conversations SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), conv.id);
    return { ok: true };
  });

  app.delete('/api/conversations/:id', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    return { ok: true };
  });

  app.post('/api/messages/:id/pin', async (req, reply) => {
    const msg = db.prepare(`
      SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE m.id = ? AND c.user_id = ?`).get(req.params.id, req.user.id);
    if (!msg) return reply.code(404).send({ error: 'not found' });
    const pinned = req.body?.pinned ? 1 : 0;
    db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned, msg.id);
    return { ok: true, pinned: !!pinned };
  });

  // Delete a message AND its whole subtree (replies/branches under it).
  // If the active leaf was inside the subtree, the path retracts to the parent.
  app.delete('/api/messages/:id', async (req, reply) => {
    const msg = db.prepare(`
      SELECT m.*, c.active_leaf_id, c.user_id FROM messages m
      JOIN conversations c ON c.id = m.conv_id
      WHERE m.id = ? AND c.user_id = ?`).get(req.params.id, req.user.id);
    if (!msg) return reply.code(404).send({ error: 'not found' });
    const subtree = db.prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM messages WHERE id = ?
        UNION ALL
        SELECT m.id FROM messages m JOIN sub s ON m.parent_id = s.id
      ) SELECT id FROM sub`).all(msg.id).map((r) => r.id);
    db.transaction(() => {
      if (subtree.includes(msg.active_leaf_id)) setLeaf(msg.conv_id, msg.parent_id ?? null);
      const del = db.prepare(`DELETE FROM messages WHERE id IN (${subtree.map(() => '?').join(',')})`);
      del.run(...subtree);
    })();
    return { ok: true, deleted: subtree.length };
  });

  // Re-attach to an in-flight (or just-finished) generation after a refresh.
  // Sends a `resume` snapshot, then tails live events. 204 when nothing is live.
  app.get('/api/conversations/:id/live', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const job = getLiveJob(conv.id);
    if (!job || job.userId !== req.user.id) return reply.code(204).send();

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let ping = null;
    let unsub = () => {};
    const closeLive = () => {
      if (ping) { clearInterval(ping); ping = null; }
      unsub();
      unsub = () => {};
      if (!reply.raw.writableEnded) {
        try { reply.raw.end(); } catch { /* ignore */ }
      }
    };
    const write = (obj) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
      // done / stream_end — hang up so the client promise resolves
      if (obj?.type === 'done' || obj?.type === 'stream_end') closeLive();
    };
    unsub = attachListener(job, write);
    // finished jobs only needed the resume snapshot — close immediately
    if (job.status !== 'running') {
      closeLive();
      return;
    }
    ping = setInterval(() => {
      if (!reply.raw.writableEnded) {
        try { reply.raw.write(': ping\n\n'); } catch { /* ignore */ }
      }
    }, 15_000);
    reply.raw.on('close', () => {
      if (ping) { clearInterval(ping); ping = null; }
      unsub();
      // do NOT abort the job — refresh/tab-close must not kill generation
    });
  });

  // Explicit stop only. Page refresh must never cancel the model.
  // Accept empty / missing body (browsers & CF sometimes omit Content-Type on
  // POST — that used to 415 and leave the run stuck "running" forever).
  app.post('/api/conversations/:id/stop', {
    config: { rawBody: false },
    // skip JSON body requirement
  }, async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const live = stopLiveJob(conv.id, req.user.id);
    // Always free the workspace run slot, even if the live job map already
    // forgot it (e.g. after a partial crash) — otherwise "already active" 409s.
    let runs = 0;
    try {
      if (conv.workspace_id) runs = stopRunsForWorkspace(conv.workspace_id);
    } catch (err) { req.log.warn({ err }, 'stopRunsForWorkspace failed'); }
    return { ok: live || runs > 0, live, runs };
  });

  // Compaction: summarize older turns with the resident model and splice a
  // 'compaction' node onto the active path. System prompt, pinned messages and
  // the last `keep` turns stay verbatim; covered originals stay in the DB and
  // are skipped by buildPrompt from now on. (notes/COMPACTION.md)
  // Remote conversations compact on the cheap aux model and log the savings.
  app.post('/api/conversations/:id/compact', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    if (!conv.model_id || !conv.active_leaf_id) return reply.code(400).send({ error: 'nothing to compact' });

    const KEEP = Math.max(2, Number(req.body?.keep ?? 8));
    const path = pathToRoot(conv.active_leaf_id);
    const covered = new Set();
    for (const m of path) {
      if (m.role === 'compaction' && m.covers_json) {
        for (const cid of JSON.parse(m.covers_json)) covered.add(cid);
      }
    }
    const eligible = path.filter((m) =>
      (m.role === 'user' || m.role === 'assistant') && !m.pinned && !covered.has(m.id));
    const toCompact = eligible.slice(0, Math.max(0, eligible.length - KEEP));
    if (toCompact.length < 4) return reply.code(400).send({ error: 'not enough history to compact yet' });

    const remote = isRemoteId(conv.model_id);
    const auxModel = remote ? await auxModelFor(conv.model_id, req.log) : conv.model_id;
    const transcript = toCompact.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    const { content: summary, usage: compactUsage } = await streamChat({
      model: auxModel,
      messages: [{
        role: 'user',
        content: 'Compress this chat history into a context brief for a language model. '
          + 'Keep: user goals, decisions made, key facts (names, numbers, file paths, code identifiers), '
          + 'and unresolved tasks. Terse bullet points under the headings Goals / Decisions / Facts / Open items. '
          + `No preamble, no commentary.\n\n---\n${transcript}\n---`,
      }],
      params: { max_tokens: 900, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } },
    });
    if (!summary.trim()) return reply.code(502).send({ error: 'model returned an empty summary' });
    if (remote) {
      try {
        const tin = compactUsage?.prompt_tokens ?? Math.ceil(transcript.length / 4);
        const tout = compactUsage?.completion_tokens ?? 300;
        recordEvent({
          userId: req.user.id, convId: conv.id, modelId: auxModel, kind: 'aux_compact',
          tokensIn: tin, tokensOut: tout,
          costUsd: costFor(modelRowForRemoteId(auxModel), tin, tout, 0),
          baselineUsd: auxBaselineCost(modelRowForRemoteId(conv.model_id), tin, tout),
        });
      } catch { /* ledger best-effort */ }
    }

    let before = null;
    let after = null;
    try { before = await countInputTokens(conv.model_id, toCompact.map((m) => ({ role: m.role, content: m.content }))); } catch { /* cosmetic */ }
    try { after = await countInputTokens(conv.model_id, [{ role: 'system', content: summary }]); } catch { /* cosmetic */ }

    const header = `Compacted ${toCompact.length} messages`
      + (before && after ? ` (~${(before / 1000).toFixed(1)}k → ~${after} tokens)` : '');
    const node = insertMessage(conv.id, conv.active_leaf_id, 'compaction',
      `${header}\n\n${summary.trim()}`, {
        modelId: conv.model_id,
        coversJson: JSON.stringify(toCompact.map((m) => m.id)),
      });
    setLeaf(conv.id, node.id);

    let used = null;
    try { used = await countInputTokens(conv.model_id, buildPrompt(conv, node.id)); } catch { /* bar refreshes later */ }
    return { ok: true, node, compacted: toCompact.length, used, budget: conv._settings.ctx_size };
  });

  // exact context usage for the current active path (drives the bar on load)
  app.get('/api/conversations/:id/context', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    if (!conv.model_id || !conv.active_leaf_id) return { used: 0, budget: conv?._settings?.ctx_size ?? 32768 };
    const msgs = buildPrompt(conv, conv.active_leaf_id);
    try {
      const used = await countInputTokens(conv.model_id, msgs);
      return { used: used ?? 0, budget: conv._settings.ctx_size };
    } catch {
      return { used: 0, budget: conv._settings.ctx_size, unavailable: true };
    }
  });

  registerChatPost(app);
}