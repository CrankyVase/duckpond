import { requireAuth } from '../auth.js';
import { db, nowSec } from '../db.js';
import { countInputTokens, listModels, streamChat } from '../llama.js';
import {
  AGENT_TOOLS, FETCH_PAGE_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL,
  agentLoop, bindRunAbort, createRun, createWorkspaceRow,
  emit as emitRunEvent, execTool, finishRun, listTree, releaseRunAbort, subscribeRun,
} from './agent.js';
import { generateViaBridge, getUserImagePrefs, stepsForQuality } from '../imagegen.js';
import { fetchPage, searchWeb } from '../websearch.js';
import { modelSettings } from './models.js';
import { corePrompt } from '../settings.js';
import { diffusionModelFile, generateDiffusion, isDiffusionModel } from '../diffusiongen.js';
import { acquireGpu } from '../gpuqueue.js';

// ---------- tree helpers ----------

export function pathToRoot(leafId) {
  // returns messages root→leaf along parent links
  const out = [];
  let id = leafId;
  const get = db.prepare('SELECT * FROM messages WHERE id = ?');
  const seen = new Set(); // rowid reuse once produced a self-parent cycle → heap OOM
  while (id && !seen.has(id)) {
    seen.add(id);
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
  // all system content (prompt + compaction summaries) must be hoisted into ONE
  // leading system message — qwen-style templates reject system turns mid-chat
  const sysParts = [];
  const settings = conv._settings;
  const core = corePrompt();
  if (core?.trim()) sysParts.push(core);
  if (settings.system_prompt?.trim()) sysParts.push(settings.system_prompt);
  const msgs = [];
  for (const m of path) {
    if (covered.has(m.id)) continue;
    if (m.role === 'compaction') {
      sysParts.push(`[Summary of earlier conversation]\n${m.content}`);
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  return sysParts.length
    ? [{ role: 'system', content: sysParts.join('\n\n') }, ...msgs]
    : msgs;
}

function convForUser(id, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
  if (conv) conv._settings = { ...modelSettings(conv.model_id ?? ''), ...JSON.parse(conv.settings_json) };
  return conv;
}

function insertMessage(convId, parentId, role, content, extra = {}) {
  const r = db.prepare(`
    INSERT INTO messages (conv_id, parent_id, role, content, thinking, model_id, tokens_in, tokens_out, tok_per_sec, covers_json, run_id)
    VALUES (@convId, @parentId, @role, @content, @thinking, @modelId, @tokensIn, @tokensOut, @tokPerSec, @coversJson, @runId)`)
    .run({
      convId, parentId, role, content,
      thinking: extra.thinking ?? null, modelId: extra.modelId ?? null,
      tokensIn: extra.tokensIn ?? null, tokensOut: extra.tokensOut ?? null,
      tokPerSec: extra.tokPerSec ?? null, coversJson: extra.coversJson ?? null,
      runId: extra.runId ?? null,
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

// ---------- chat agent mode ----------
// Project mode is entered through ONE explicit tool call: until a conversation
// has a workspace, the model is only offered `start_project`. Calling it
// creates the sandbox, saves the model's plan as PLAN.md, and unlocks the real
// file/command tools for the rest of the run (and all later turns).

const START_PROJECT_TOOL = { type: 'function', function: {
  name: 'start_project',
  description: 'Enter project mode: creates a persistent sandboxed Linux workspace for this conversation, saves your plan as PLAN.md, and unlocks file and shell tools (list/read/write files, run commands). Call this ONLY when the user wants real, runnable, multi-file work built — never for snippets, examples, or discussion.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'short kebab-case project name, e.g. "snake-game"' },
    plan: { type: 'string', description: 'concise markdown plan: goal, files you will create, implementation steps, how you will verify it' },
  }, required: ['name', 'plan'] },
} };

const GATE_POLICY = `## Project mode
You can build real software in this chat. To do it, call the start_project tool — it creates a sandboxed Linux workspace (Debian, Node 24 + npm, Python 3.13 + pip, git; dev servers may bind ports 3000-3009), saves your plan as PLAN.md, and unlocks file and shell tools.

Call start_project ONLY when:
- the user asks for a real project, app, game, script, or website they want to keep, run, or iterate on
- the work needs multiple files or packages, or must be executed to verify it

Do NOT call it when:
- the user wants a snippet, one-file example, or code just to read — answer in chat with a markdown code block
- the user is asking a question, discussing, or still planning — keep talking; only start the project when they clearly want it built

If you do call it, briefly tell the user what you're about to build first, then call the tool with a short kebab-case name and a concise plan.`;

const ACTIVE_POLICY = `## Project mode (active)
This conversation has a persistent sandboxed workspace at /workspace (Debian, Node 24 + npm, Python 3.13 + pip, git; dev servers may bind ports 3000-3009). You have tools to list/read/write files and run shell commands.

Rules:
- Use tools when the user wants project work done (build, change, fix, run). For pure questions or discussion, just answer in chat — no tools.
- Keep PLAN.md current: check items off as you finish them; update it when the plan changes.
- Look before you leap: list or read files before editing them.
- write_file replaces the whole file — always write complete content, never fragments or placeholders.
- Verify your work by actually running it (tests, node/python invocation, build) before declaring it done.
- Package installs pause for the user's approval and may be denied; if denied, adapt.
- After tool work, finish with a short plain-text summary: what you built, how you verified it, what could come next. No tool calls in that final message.`;

const SEARCH_POLICY = `## Web search
You can search the web with web_search and read pages with fetch_page. Use them for current events, prices, versions, library docs, or any fact you are not confident about — never guess when you can check. Cite what you used as markdown links in your answer. Skip them for things you already know well.`;

const IMAGE_POLICY = `## Image generation
You can create real images with the generate_image tool (local diffusion model). Use it when the user asks for a picture, artwork, photo, logo, or wallpaper. Write the complete visual prompt yourself — subject, setting, style, lighting, composition — don't ask the user to write it. Generation takes a few minutes on the local GPU, so briefly say what you're creating before the call. Never claim you made an image without calling the tool; the finished image is shown to the user automatically.`;

const NAME_STOPWORDS = new Set([
  'make', 'me', 'a', 'an', 'the', 'i', 'want', 'you', 'to', 'please', 'pls', 'build',
  'create', 'write', 'my', 'for', 'of', 'in', 'with', 'that', 'this', 'it', 'can',
  'and', 'then', 'than', 'like', 'us', 'some', 'new', 'app', 'project', 'game',
]);

function wsNameFrom(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w && !NAME_STOPWORDS.has(w));
  return (words.slice(0, 3).join('-') || 'project').slice(0, 40);
}

function slugify(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}

function withToolsPolicy(promptMessages, wsRow, imageAllowed = true) {
  const parts = [wsRow ? ACTIVE_POLICY : GATE_POLICY, ...(imageAllowed ? [IMAGE_POLICY] : []), SEARCH_POLICY];
  if (wsRow) {
    const files = listTree(wsRow).slice(0, 60)
      .map((f) => (f.dir ? `${f.path}/` : f.path)).join('\n');
    parts.push(`Current workspace files:\n${files || '(empty)'}`);
  }
  const policy = parts.join('\n\n');
  if (promptMessages[0]?.role === 'system') {
    return [{ role: 'system', content: promptMessages[0].content + '\n\n' + policy }, ...promptMessages.slice(1)];
  }
  return [{ role: 'system', content: policy }, ...promptMessages];
}

// A diffusion-LLM turn: resolve the gguf, denoise once, stream every visual
// frame as { type:'diffusion_step' }, then save the final text like any reply.
async function runDiffusionTurn({ conv, promptLeaf, send, abort, log }) {
  let modelFile = null;
  try {
    const m = (await listModels()).find((x) => x.id === conv.model_id);
    modelFile = diffusionModelFile(m?.args, conv.model_id);
  } catch {
    modelFile = diffusionModelFile(null, conv.model_id); // router down → try the diffusion dir
  }
  if (!modelFile) { send({ type: 'error', message: 'diffusion model file not found on disk' }); return; }

  send({ type: 'loading', model: conv.model_id });

  // system prompt + latest user turn only; the CLI applies the model's own
  // chat template (its -sys flag), so we don't hand-roll one.
  const sysParts = [];
  const core = corePrompt();
  if (core?.trim()) sysParts.push(core);
  if (conv._settings.system_prompt?.trim()) sysParts.push(conv._settings.system_prompt);

  let finalText = '';
  try {
    const r = await generateDiffusion({
      modelFile,
      prompt: promptLeaf.content,
      systemPrompt: sysParts.join('\n\n'),
      tokens: conv._settings.diffusion_tokens ?? 128,
      steps: conv._settings.diffusion_steps ?? 64,
      signal: abort.signal,
      log,
      onFrame: ({ n, steps, text, phase }) => send({ type: 'diffusion_step', n, steps, text, phase }),
    });
    finalText = (r.text || '').trim() || '_(the diffusion model produced no text)_';
    if (r.stopped) finalText += '\n\n> stopped';
  } catch (err) {
    log?.error({ err }, 'diffusion turn failed');
    if (!abort.signal.aborted) send({ type: 'error', message: String(err.message ?? err) });
    return;
  }

  const asst = insertMessage(conv.id, promptLeaf.id, 'assistant', finalText, { modelId: conv.model_id });
  setLeaf(conv.id, asst.id);
  send({ type: 'done', msg: asst });

  // cheap local auto-title (no router model to ask) from the first user words
  if (conv.title === 'New chat') {
    const t = promptLeaf.content.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60);
    if (t) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, conv.id);
      send({ type: 'title', title: t });
    }
  }
}

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
    const send = (obj) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };
    const abort = new AbortController();
    // NB: req.raw 'close' fires once the request BODY is consumed (not on client
    // disconnect) — the response socket is the real disconnect signal.
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abort.abort(); });

    let releaseGpu = null;
    try {
      let promptLeaf;   // message the assistant will answer under
      if (regenerateFrom) {
        const src = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(regenerateFrom, conv.id);
        if (!src || src.role !== 'assistant') throw new Error('bad regenerateFrom');
        promptLeaf = db.prepare('SELECT * FROM messages WHERE id = ?').get(src.parent_id);
      } else {
        if (typeof content !== 'string' || !content.trim()) throw new Error('empty message');
        // parentId: null means "start a new root branch" — only fall back to the
        // active leaf when the field is absent entirely
        let parent = parentId !== undefined ? parentId : (conv.active_leaf_id ?? null);
        // stale/deleted parent (rowid reuse made this a self-parent cycle once): re-root
        if (parent != null && !db.prepare('SELECT 1 FROM messages WHERE id = ? AND conv_id = ?').get(parent, conv.id)) {
          parent = null;
        }
        promptLeaf = insertMessage(conv.id, parent, 'user', content);
        send({ type: 'user_msg', msg: promptLeaf });
      }

      // One GPU → serialize every generation. A second concurrent user waits
      // here and sees their queue position; if they disconnect while waiting,
      // acquireGpu rejects and we bail without ever taking the slot.
      try {
        releaseGpu = await acquireGpu({
          signal: abort.signal,
          onQueued: (position) => send({ type: 'queue', position }),
        });
      } catch { return; } // aborted while queued
      send({ type: 'queue', position: 0 }); // slot is ours — clear the waiting UI

      // Diffusion LLMs don't run through the router (unknown arch) — intercept
      // here and drive llama-diffusion-cli directly, streaming denoise frames
      // into the thread. Single-shot: no tools, no agent loop, no context bar.
      if (isDiffusionModel(conv.model_id)) {
        await runDiffusionTurn({ conv, promptLeaf, send, abort, log: req.log });
        return; // finally{} closes the SSE stream
      }

      // warm-up indicator: tell the client if this request will trigger a model (re)load
      try {
        const models = await listModels();
        const m = models.find((x) => x.id === conv.model_id);
        if (m && m.status !== 'loaded') send({ type: 'loading', model: conv.model_id });
      } catch { /* router briefly unavailable; generation attempt will surface it */ }

      let wsRow = conv.workspace_id
        ? db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(conv.workspace_id, req.user.id)
        : null;
      const imgPrefs = getUserImagePrefs(req.user.id);
      const promptMessages = withToolsPolicy(
        buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id), wsRow, imgPrefs.allowed);
      const params = { max_tokens: -1 };
      for (const k of GEN_PARAM_KEYS) params[k] = conv._settings[k];
      // thinking control: enable_thinking is honored by qwen-style templates,
      // reasoning_effort by gpt-oss-style ones; unsupported kwargs are ignored
      const think = conv._settings.thinking;
      if (think === 'none') params.chat_template_kwargs = { enable_thinking: false };
      else if (think === 'high' || think === 'low') params.reasoning_effort = think;

      let lastTick = 0;
      const t0 = Date.now();
      const onDelta = (chunk, meta) => {
        if (meta?.reasoning) send({ type: 'thinking', text: meta.reasoning });
        if (meta?.toolFrag) send({ type: 'tool_delta', ...meta.toolFrag });
        if (chunk) send({ type: 'delta', text: chunk });
        const now = Date.now();
        if (now - lastTick > 500 && meta?.timings?.predicted_per_second
            && (meta.timings.predicted_n ?? 0) >= 5) {
          lastTick = now;
          send({ type: 'tok_s', value: meta.timings.predicted_per_second, n: meta.timings.predicted_n ?? 0 });
        }
      };

      // first call offers the tools (just the start_project gate until the
      // conversation has a workspace); if the template rejects them, retry plain
      let res;
      let toolsOn = true;
      try {
        const baseTools = wsRow ? AGENT_TOOLS
          : [START_PROJECT_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL, FETCH_PAGE_TOOL];
        res = await streamChat({
          model: conv.model_id, messages: promptMessages,
          params: {
            ...params,
            tools: imgPrefs.allowed
              ? baseTools
              : baseTools.filter((t) => t.function.name !== 'generate_image'),
            tool_choice: 'auto',
          },
          abortSignal: abort.signal, onDelta,
        });
      } catch (err) {
        if (abort.signal.aborted || !/tool/i.test(String(err.message))) throw err;
        req.log.warn({ model: conv.model_id }, 'template rejected tools — plain chat fallback');
        toolsOn = false;
        res = await streamChat({
          model: conv.model_id, messages: promptMessages, params,
          abortSignal: abort.signal, onDelta,
        });
      }

      let { content: text, reasoning, timings, usage } = res;
      let runId = null;

      if (toolsOn && res.toolCalls?.length
          && res.toolCalls.every((t) => t.function.name === 'generate_image')) {
        // pure image turn — no workspace, no run. Generate on the bridge with
        // the live preview streaming into the chat, then let the model add a
        // short comment. The finished image is embedded as markdown so it
        // survives in the saved message.
        const followup = [...promptMessages,
          { role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls }];
        const mdImgs = [];
        for (const call of res.toolCalls.slice(0, 2)) {
          let args = null;
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* truncated */ }
          let toolResult;
          if (!args?.prompt?.trim()) {
            toolResult = 'ERROR: generate_image needs a prompt argument (complete visual description). Retry with well-formed JSON.';
          } else {
            send({ type: 'image_job', prompt: args.prompt });
            try {
              const r = await generateViaBridge({
                userId: req.user.id, prompt: args.prompt, size: args.size ?? '1024x1024',
                steps: stepsForQuality(imgPrefs.quality),
                onProgress: (ev) => send(ev.type === 'preview'
                  ? { type: 'image_preview', b64: ev.b64 }
                  : { type: 'image_progress', phase: ev.phase, step: ev.step, steps: ev.steps }),
              });
              const caption = r.model_used ? `\n*generated by ${r.model_used}*` : '';
              const md = r.images.map((im) => `![generated image](${im.url})${caption}`).join('\n\n');
              mdImgs.push(md);
              send({ type: 'image_done' });
              // pop the finished image straight into the live streaming view
              send({ type: 'delta', text: `\n\n${md}\n\n` });
              toolResult = 'Image generated and already shown to the user in this chat. Reply with one or two short sentences about it — no links, do not repeat the prompt.';
            } catch (err) {
              req.log.error({ err }, 'in-chat image generation failed');
              send({ type: 'image_done' });
              toolResult = `ERROR: image generation failed: ${err.message}. Tell the user.`;
            }
          }
          followup.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
        }
        // brief commentary pass — no tools, so it can't chain another job
        let fin = { content: '' };
        try {
          fin = await streamChat({
            model: conv.model_id, messages: followup, params,
            abortSignal: abort.signal, onDelta,
          });
        } catch (err) {
          if (!mdImgs.length) throw err;
          req.log.warn({ err }, 'image follow-up commentary failed; keeping the image');
        }
        text = [(res.content ?? '').trim(), mdImgs.join('\n\n'), (fin.content ?? '').trim()]
          .filter(Boolean).join('\n\n');
        reasoning = fin.reasoning ?? reasoning;
        timings = fin.timings ?? timings;
        usage = fin.usage ?? usage;
      } else if (toolsOn && res.toolCalls?.length) {
        // the model reached for tools → this turn becomes an agent run
        let loopMessages = promptMessages;
        let firstResult = res;
        // gate call: start_project(name, plan) creates the workspace; the
        // rest of the gate step is recorded AFTER the subscription below so
        // the chips/diff show up live, not just in the replay
        const gateCall = wsRow ? null
          : (res.toolCalls.find((t) => t.function.name === 'start_project') ?? res.toolCalls[0]);
        let gargs = {};
        if (gateCall) {
          try { gargs = JSON.parse(gateCall.function.arguments || '{}'); } catch { /* bad JSON from model */ }
          wsRow = createWorkspaceRow(req.user.id, slugify(gargs.name) || wsNameFrom(promptLeaf.content));
          db.prepare('UPDATE conversations SET workspace_id = ? WHERE id = ?').run(wsRow.id, conv.id);
        }
        const run = createRun(wsRow.id, req.user.id, conv.model_id, promptLeaf.content);
        runId = run.id;
        bindRunAbort(run.id, abort);
        send({ type: 'agent_start', run, workspace: wsRow });
        const unsub = subscribeRun(run.id, (e) => {
          if (e.type === 'delta') {
            if (e.text) send({ type: 'delta', text: e.text });
            else if (e.reasoning) send({ type: 'thinking', text: e.reasoning });
          } else if (e.type === 'tool_delta') {
            send({ type: 'tool_delta', index: e.index, name: e.name, args: e.args });
          } else {
            send({ type: 'agent', event: e });
          }
        });
        if (gateCall) {
          // record the gate step (now visible live), write PLAN.md, and
          // rebuild the transcript under the active-project policy
          emitRunEvent(run.id, 'assistant', {
            content: res.content, thinking: res.reasoning || null,
            tool_calls: [{ id: gateCall.id, name: 'start_project', arguments: gateCall.function.arguments }],
            step: -1,
          });
          emitRunEvent(run.id, 'tool_call', { call_id: gateCall.id, name: 'start_project', args: { name: wsRow.name }, step: -1 });
          if (gargs.plan?.trim()) {
            await execTool(run, wsRow, 'write_file', { path: 'PLAN.md', content: gargs.plan.trim() + '\n' });
          }
          const gateResult = `Project workspace "${wsRow.name}" created${gargs.plan?.trim() ? ' and your plan saved as PLAN.md' : ''}. You now have list_files, read_file, write_file and run_command — implement the plan, then verify it by running it.`;
          emitRunEvent(run.id, 'tool_result', { call_id: gateCall.id, name: 'start_project', step: -1, result: gateResult });
          loopMessages = withToolsPolicy(buildPrompt(conv, promptLeaf.id), wsRow, imgPrefs.allowed);
          loopMessages.push({ role: 'assistant', content: res.content ?? '', tool_calls: [gateCall] });
          loopMessages.push({ role: 'tool', tool_call_id: gateCall.id, content: gateResult });
          firstResult = null; // the loop streams fresh with the full toolset
        }
        // Never lose the work: whatever happens to the run (stop, crash, step
        // limit), an assistant message with the run attached still gets saved,
        // so the feed replays instead of vanishing from the chat.
        let result;
        try {
          result = await agentLoop({
            run, ws: wsRow, messages: loopMessages, model: conv.model_id,
            genParams: params, abortSignal: abort.signal, firstResult,
            tools: imgPrefs.allowed ? AGENT_TOOLS : AGENT_TOOLS.filter((t) => t.function.name !== 'generate_image'),
          });
        } catch (err) {
          req.log.error({ err, run: run.id }, 'agent loop failed');
          result = { status: 'error', message: String(err.message ?? err) };
        } finally {
          unsub();
          releaseRunAbort(run.id);
        }
        if (result.status === 'final') {
          finishRun(run.id, 'done');
          text = result.content;
          reasoning = result.reasoning ?? reasoning;
          timings = result.timings ?? timings;
          usage = result.usage ?? usage;
        } else if (result.status === 'aborted') {
          finishRun(run.id, 'stopped');
          text = 'Stopped — everything done so far is saved in the workspace.';
        } else if (result.status === 'steplimit') {
          finishRun(run.id, 'error');
          text = 'I hit the step limit for this run — everything done so far is saved in the workspace.';
        } else {
          finishRun(run.id, 'error');
          text = `The run hit an error (${result.message ?? 'unknown'}) — everything done so far is saved in the workspace.`;
        }
      }

      const tokPerSec = timings?.predicted_per_second
        ?? (usage?.completion_tokens ? usage.completion_tokens / ((Date.now() - t0) / 1000) : null);
      const asst = insertMessage(conv.id, promptLeaf.id, 'assistant', text, {
        thinking: reasoning || null,
        modelId: conv.model_id,
        tokensIn: usage?.prompt_tokens ?? timings?.prompt_n ?? null,
        tokensOut: usage?.completion_tokens ?? timings?.predicted_n ?? null,
        tokPerSec,
        runId,
      });
      setLeaf(conv.id, asst.id);
      recordUsage(conv.model_id, usage, timings);
      send({ type: 'done', msg: asst });

      // context bar: exact prompt size if the model were asked again right now
      // (skipped when the client already left — no GPU work for a dead socket)
      if (!abort.signal.aborted) {
        try {
          const used = await countInputTokens(conv.model_id, [...promptMessages, { role: 'assistant', content: text }]);
          if (used != null) send({ type: 'context', used, budget: conv._settings.ctx_size });
        } catch { /* non-fatal */ }
      }

      // auto-title on first exchange
      if (!abort.signal.aborted && conv.title === 'New chat' && !regenerateFrom) {
        try {
          // generous max_tokens: thinking models burn budget on reasoning first
          const { content: title, reasoning: titleReasoning } = await streamChat({
            model: conv.model_id,
            messages: [{
              role: 'user',
              content: `Reply with ONLY a 3-6 word title (no quotes, no punctuation at the end) for a chat that starts:\nUser: ${promptLeaf.content.slice(0, 400)}\nAssistant: ${text.slice(0, 400)}`,
            }],
            params: { max_tokens: 800, temperature: 0.3, chat_template_kwargs: { enable_thinking: false } },
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
      releaseGpu?.();
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  // Compaction: summarize older turns with the resident model and splice a
  // 'compaction' node onto the active path. System prompt, pinned messages and
  // the last `keep` turns stay verbatim; covered originals stay in the DB and
  // are skipped by buildPrompt from now on. (notes/COMPACTION.md)
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

    const transcript = toCompact.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    const { content: summary } = await streamChat({
      model: conv.model_id,
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
}
