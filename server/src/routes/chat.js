import { requireAuth } from '../auth.js';
import { db, nowSec } from '../db.js';
import { countInputTokens, listModels, streamChat } from '../llama.js';
import { modelSettings } from './models.js';

// ---------- tree helpers ----------

export function pathToRoot(leafId) {
  // returns messages root→leaf along parent links
  const out = [];
  let id = leafId;
  const get = db.prepare('SELECT * FROM messages WHERE id = ?');
  while (id) {
    const m = get.get(id);
    if (!m) break;
    out.push(m);
    id = m.parent_id;
  }
  return out.reverse();
}

// Prompt for the model: the active path, minus messages covered by compaction
// summaries on that path. Compaction nodes become system summaries in place.
export function buildPrompt(conv, leafId) {
  const path = pathToRoot(leafId);
  const covered = new Set();
  for (const m of path) {
    if (m.role === 'compaction' && m.covers_json) {
      for (const cid of JSON.parse(m.covers_json)) covered.add(cid);
    }
  }
  const msgs = [];
  const settings = conv._settings;
  if (settings.system_prompt?.trim()) {
    msgs.push({ role: 'system', content: settings.system_prompt });
  }
  for (const m of path) {
    if (covered.has(m.id)) continue;
    if (m.role === 'compaction') {
      msgs.push({ role: 'system', content: `[Summary of earlier conversation]\n${m.content}` });
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  return msgs;
}

function convForUser(id, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
  if (conv) conv._settings = { ...modelSettings(conv.model_id ?? ''), ...JSON.parse(conv.settings_json) };
  return conv;
}

function insertMessage(convId, parentId, role, content, extra = {}) {
  const r = db.prepare(`
    INSERT INTO messages (conv_id, parent_id, role, content, thinking, model_id, tokens_in, tokens_out, tok_per_sec, covers_json)
    VALUES (@convId, @parentId, @role, @content, @thinking, @modelId, @tokensIn, @tokensOut, @tokPerSec, @coversJson)`)
    .run({
      convId, parentId, role, content,
      thinking: extra.thinking ?? null, modelId: extra.modelId ?? null,
      tokensIn: extra.tokensIn ?? null, tokensOut: extra.tokensOut ?? null,
      tokPerSec: extra.tokPerSec ?? null, coversJson: extra.coversJson ?? null,
    });
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
}

function setLeaf(convId, leafId) {
  db.prepare('UPDATE conversations SET active_leaf_id = ?, updated_at = unixepoch() WHERE id = ?')
    .run(leafId, convId);
}

function recordUsage(modelId, usage, timings) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO usage_stats (model_id, day, tokens_in, tokens_out, gen_ms, requests)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(model_id, day) DO UPDATE SET
      tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out,
      gen_ms = gen_ms + excluded.gen_ms,
      requests = requests + 1`)
    .run(modelId, day,
      usage?.prompt_tokens ?? timings?.prompt_n ?? 0,
      usage?.completion_tokens ?? timings?.predicted_n ?? 0,
      Math.round(timings?.predicted_ms ?? 0));
}

const GEN_PARAM_KEYS = ['temperature', 'top_p', 'top_k', 'repeat_penalty'];

// ---------- routes ----------

export default async function chatRoutes(app) {
  app.addHook('preHandler', requireAuth);

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
    if (active_leaf_id !== undefined) setLeaf(conv.id, active_leaf_id);
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

  // The main event: send a user message (or regenerate) and stream the reply.
  // body: { content?, parentId?, regenerateFrom? } — exactly one of content|regenerateFrom.
  app.post('/api/conversations/:id/chat', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    if (!conv.model_id) return reply.code(400).send({ error: 'no model selected' });

    const { content, parentId, regenerateFrom } = req.body ?? {};

    // take the socket away from Fastify — otherwise it "completes" the reply
    // as soon as the handler yields and our SSE stream gets torn down
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    const abort = new AbortController();
    // NB: req.raw 'close' fires once the request BODY is consumed (not on client
    // disconnect) — the response socket is the real disconnect signal.
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abort.abort(); });

    try {
      let promptLeaf;   // message the assistant will answer under
      if (regenerateFrom) {
        const src = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(regenerateFrom, conv.id);
        if (!src || src.role !== 'assistant') throw new Error('bad regenerateFrom');
        promptLeaf = db.prepare('SELECT * FROM messages WHERE id = ?').get(src.parent_id);
      } else {
        if (typeof content !== 'string' || !content.trim()) throw new Error('empty message');
        const parent = parentId ?? conv.active_leaf_id ?? null;
        promptLeaf = insertMessage(conv.id, parent, 'user', content);
        send({ type: 'user_msg', msg: promptLeaf });
      }

      // warm-up indicator: tell the client if this request will trigger a model (re)load
      try {
        const models = await listModels();
        const m = models.find((x) => x.id === conv.model_id);
        if (m && m.status !== 'loaded') send({ type: 'loading', model: conv.model_id });
      } catch { /* router briefly unavailable; generation attempt will surface it */ }

      const promptMessages = buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id);
      const params = { max_tokens: -1 };
      for (const k of GEN_PARAM_KEYS) params[k] = conv._settings[k];

      let lastTick = 0;
      const t0 = Date.now();
      const { content: text, reasoning, timings, usage } = await streamChat({
        model: conv.model_id,
        messages: promptMessages,
        params,
        abortSignal: abort.signal,
        onDelta: (chunk, meta) => {
          if (meta?.reasoning) send({ type: 'thinking', text: meta.reasoning });
          if (chunk) send({ type: 'delta', text: chunk });
          const now = Date.now();
          if (now - lastTick > 500 && meta?.timings?.predicted_per_second
              && (meta.timings.predicted_n ?? 0) >= 5) {
            lastTick = now;
            send({ type: 'tok_s', value: meta.timings.predicted_per_second, n: meta.timings.predicted_n ?? 0 });
          }
        },
      });

      const tokPerSec = timings?.predicted_per_second
        ?? (usage?.completion_tokens ? usage.completion_tokens / ((Date.now() - t0) / 1000) : null);
      const asst = insertMessage(conv.id, promptLeaf.id, 'assistant', text, {
        thinking: reasoning || null,
        modelId: conv.model_id,
        tokensIn: usage?.prompt_tokens ?? timings?.prompt_n ?? null,
        tokensOut: usage?.completion_tokens ?? timings?.predicted_n ?? null,
        tokPerSec,
      });
      setLeaf(conv.id, asst.id);
      recordUsage(conv.model_id, usage, timings);
      send({ type: 'done', msg: asst });

      // context bar: exact prompt size if the model were asked again right now
      try {
        const used = await countInputTokens(conv.model_id, [...promptMessages, { role: 'assistant', content: text }]);
        if (used != null) send({ type: 'context', used, budget: conv._settings.ctx_size });
      } catch { /* non-fatal */ }

      // auto-title on first exchange
      if (conv.title === 'New chat' && !regenerateFrom) {
        try {
          // generous max_tokens: thinking models burn budget on reasoning first
          const { content: title, reasoning: titleReasoning } = await streamChat({
            model: conv.model_id,
            messages: [{
              role: 'user',
              content: `Reply with ONLY a 3-6 word title (no quotes, no punctuation at the end) for a chat that starts:\nUser: ${promptLeaf.content.slice(0, 400)}\nAssistant: ${text.slice(0, 400)}`,
            }],
            params: { max_tokens: 800, temperature: 0.3 },
          });
          const raw = title.trim() || (titleReasoning ?? '').trim().split('\n').pop() || '';
          const clean = raw.replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 80);
          if (clean) {
            db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(clean, conv.id);
            send({ type: 'title', title: clean });
          }
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      req.log.error({ err }, 'chat generation failed');
      if (!abort.signal.aborted && !reply.raw.writableEnded) {
        send({ type: 'error', message: String(err.message ?? err) });
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
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
}
