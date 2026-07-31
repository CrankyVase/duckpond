// POST /api/conversations/:id/chat — the main streaming turn, registered from
// routes/chat.js (same plugin scope, so the requireAuth hook applies). Split
// out when the original chat.js outgrew one file.
import { db } from '../db.js';
import { ipLocation } from '../geoip.js';
import { countInputTokens, listModels, streamChat } from '../llama.js';
import { clientIp } from '../auth.js';
import {
  AGENT_TOOLS, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL, FETCH_PAGE_TOOL,
} from './agent.js';
import { checkUserContent } from '../contentFilter.js';
import { getUserImagePrefs } from '../imagegen.js';
import { convUploads, injectUploadsIntoMessages } from '../uploads.js';
import {
  memoryEnabled, rememberFromExchange, retrieveMemories,
} from '../memory.js';
import { isDiffusionModel } from '../diffusiongen.js';
import { acquireGpu } from '../gpuqueue.js';
import { finishRun, isRunLive } from './agent.js';
import {
  broadcast, createLiveJob, finishLiveJob, getLiveJob,
} from '../liveJobs.js';
import { convDocs, docFullText, retrieveChunks } from '../docs.js';
// remote providers + cost saver (feat/remote-providers)
import { auxModelFor, isRemoteId } from '../chatBackend.js';
import {
  auxBaselineCost, costFor, modelRowForRemoteId, providerMonthSpend, recordEvent,
} from '../costs.js';
import {
  cacheKey, cacheLookup, cacheStore, estimateTokens, resolveRemote,
} from '../providers.js';
import { cacheEligible, orderSystemForPrefixCache, promptPressure } from '../tokenSaver.js';
import { saveContext, saverSummary } from '../contextsaver.js';
import {
  GEN_PARAM_KEYS, MEMORY_TOOLS, MEMORY_TOOL_NAMES, START_PROJECT_TOOL,
  WIDGET_TOOLS, WIDGET_TOOL_NAMES,
  buildPrompt, convForUser, dashboardCapable, filterTools, insertMessage,
  persistInterruptedReply, recordUsage, setLeaf, stripFakeImages,
} from '../chatkit.js';
import {
  RESEARCH_MODES, ULTRA_DIRECTIVE, makeSpeculator, withToolsPolicy,
} from '../chatpolicy.js';
import {
  autoCompactMessages, generateFollowups, makeTurnDelta, replayCacheHit,
  runAgentTurn, runDiffusionTurn, runImageTurn, runInlineSearch,
} from '../chatflow.js';

export function registerChatPost(app) {
  // The main event: send a user message (or regenerate) and stream the reply.
  // body: { content?, parentId?, regenerateFrom? } — exactly one of content|regenerateFrom.
  app.post('/api/conversations/:id/chat', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    if (!conv.model_id) return reply.code(400).send({ error: 'no model selected' });

    // one live generation per conversation — the client queues extras itself
    if (getLiveJob(conv.id)?.status === 'running') {
      return reply.code(409).send({ error: 'a reply is already generating for this chat' });
    }

    const { content, parentId, regenerateFrom } = req.body ?? {};
    // remote (paid API) models take a different path for GPU queueing, warm-up
    // probes and agent tooling — and get the cost-saver pipeline on top
    const remote = isRemoteId(conv.model_id);
    // coarse location, resolved from the request's own IP (no browser prompt,
    // no client involvement) → lets show_weather/show_map default to where the
    // user is when they name no place
    const userLoc = await ipLocation(clientIp(req));
    // search depth: quick | normal | ultra (deep research)
    const researchMode = RESEARCH_MODES[req.body?.researchMode] ? req.body.researchMode : 'normal';
    const modeCfg = RESEARCH_MODES[researchMode];

    let job;
    try { job = createLiveJob(conv.id, req.user.id); }
    catch (err) {
      return reply.code(err.code === 409 ? 409 : 500).send({ error: err.message });
    }
    const abort = job.abort;

    // take the socket away from Fastify — otherwise it "completes" the reply
    // as soon as the handler yields and our SSE stream gets torn down
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Fan out every event to all attached clients (this tab + any reattach after
    // refresh). The primary connection is just another listener — closing it
    // must NOT abort the job.
    const writePrimary = (obj) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };
    job.listeners.add(writePrimary);
    const send = (obj) => broadcast(job, obj);
    // Cloudflare / proxies kill "idle" SSE after ~100s. Keepalive comments
    // (ignored by the client parser) prevent the reply vanishing mid-generation.
    const pingPrimary = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(': ping\n\n'); } catch { /* client gone */ }
    }, 15_000);
    reply.raw.on('close', () => {
      clearInterval(pingPrimary);
      job.listeners.delete(writePrimary);
      // intentionally no abort.abort() — generation keeps going server-side
    });

    let releaseGpu = null;
    let turnDelta = null;       // per-turn stream wiring (timer cleared in finally)
    let promptLeaf = null;      // message the assistant will answer under (needed in finally)
    const t0 = Date.now();      // turn wall-clock start (tok/s fallback below)
    try {
      if (regenerateFrom) {
        const src = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(regenerateFrom, conv.id);
        if (!src || src.role !== 'assistant') throw new Error('bad regenerateFrom');
        promptLeaf = db.prepare('SELECT * FROM messages WHERE id = ?').get(src.parent_id);
      } else {
        if (typeof content !== 'string' || !content.trim()) throw new Error('empty message');
        // Content filter (user Settings → Safety). Blocks before the turn is saved.
        const filtered = checkUserContent(req.user.id, content, 'chat');
        if (!filtered.ok) {
          send({ type: 'error', message: filtered.reason, code: filtered.code });
          return;
        }
        // parentId: null means "start a new root branch" — only fall back to the
        // active leaf when the field is absent entirely
        let parent = parentId !== undefined ? parentId : (conv.active_leaf_id ?? null);
        // Client sometimes holds a tmp-* leaf after a dropped stream (not in DB).
        // Fall back to the conversation's real active leaf — NEVER null-root here,
        // or "continue" after a blip orphans the whole thread and looks like a wipe.
        if (parent != null && !db.prepare('SELECT 1 FROM messages WHERE id = ? AND conv_id = ?').get(parent, conv.id)) {
          const fresh = db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conv.id);
          parent = fresh?.active_leaf_id ?? null;
          if (parent != null && !db.prepare('SELECT 1 FROM messages WHERE id = ? AND conv_id = ?').get(parent, conv.id)) {
            parent = null;
          }
        }
        // Soft continue: if the user is picking up after an interrupt, keep them
        // on the interrupted assistant leaf so the model sees the partial work.
        const trimmed = content.trim();
        const continueLike = /^(continue|keep going|resume|go on|try again|pick up)\b/i.test(trimmed)
          || /^(continue|keep going|resume)\s*[.!]?\s*$/i.test(trimmed);
        if (continueLike && parent != null) {
          const leaf = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(parent, conv.id);
          if (leaf?.role === 'assistant' && />\s*(Interrupted|Stopped|connection)/i.test(leaf.content || '')) {
            // parent is already the interrupted assistant — perfect
          } else if (leaf?.role === 'user') {
            // leaf is the original user prompt; find interrupted sibling asst if any
            const asst = db.prepare(`
              SELECT * FROM messages WHERE conv_id = ? AND parent_id = ? AND role = 'assistant'
              ORDER BY id DESC LIMIT 1`).get(conv.id, leaf.id);
            if (asst && />\s*(Interrupted|Stopped|connection)/i.test(asst.content || '')) {
              parent = asst.id;
            }
          }
        }
        promptLeaf = insertMessage(conv.id, parent, 'user', content);
        send({ type: 'user_msg', msg: promptLeaf });
      }

      // One GPU → serialize every LOCAL generation. A second concurrent user
      // waits here and sees their queue position; if they disconnect while
      // waiting, acquireGpu rejects and we bail without ever taking the slot.
      // Remote models don't touch the GPU — no queue for them.
      if (!remote) {
        try {
          releaseGpu = await acquireGpu({
            signal: abort.signal,
            onQueued: (position) => send({ type: 'queue', position }),
          });
        } catch { return; } // aborted while queued
      }
      send({ type: 'queue', position: 0 }); // slot is ours — clear the waiting UI

      // Diffusion LLMs don't run through the router (unknown arch) — intercept
      // here and drive llama-diffusion-cli directly, streaming denoise frames
      // into the thread. Single-shot: no tools, no agent loop, no context bar.
      if (isDiffusionModel(conv.model_id)) {
        await runDiffusionTurn({ conv, promptLeaf, send, abort, log: req.log });
        return; // finally{} closes the SSE stream
      }

      // warm-up indicator: tell the client if this request will trigger a model (re)load
      if (!remote) {
        try {
          const models = await listModels();
          const m = models.find((x) => x.id === conv.model_id);
          if (m && m.status !== 'loaded') send({ type: 'loading', model: conv.model_id });
        } catch { /* router briefly unavailable; generation attempt will surface it */ }
      }

      let wsRow = conv.workspace_id
        ? db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(conv.workspace_id, req.user.id)
        : null;
      const imgPrefs = getUserImagePrefs(req.user.id);
      const disabledTools = new Set(conv._settings.disabledTools ?? []);
      // remote models: sandbox/agent tooling stays local-only (a paid API
      // model driving shell loops would be a bill and a half). Inline tools —
      // web search, widgets, memory, image gen — work fine remotely.
      if (remote) {
        wsRow = null;
        disabledTools.add('start_project');
      }
      // capability gate (generative UI): small models fumble the nested
      // tool-call JSON a dashboard needs — don't offer or describe it to them
      if (!dashboardCapable(conv.model_id)) disabledTools.add('show_dashboard');
      // constrained output (Settings → Structured output): a GBNF grammar or
      // JSON schema forces the shape of the WHOLE reply, which is incompatible
      // with tool-call JSON — the turn runs plain, and the system prompt skips
      // the tool policies it couldn't honor anyway
      const schemaStr = String(conv._settings.json_schema ?? '').trim();
      const grammarStr = String(conv._settings.grammar ?? '').trim();
      const constrained = !!(schemaStr || grammarStr);
      let promptMessages = constrained
        ? buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id)
        : withToolsPolicy(
          buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id), wsRow, imgPrefs.allowed, userLoc, disabledTools);
      // deep-research mode: prepend the directive to the leading system message
      if (modeCfg.ultra && promptMessages[0]?.role === 'system') {
        promptMessages[0] = { role: 'system', content: `${promptMessages[0].content}\n\n${ULTRA_DIRECTIVE}` };
      }
      // long-term memory: what Dumpling remembers about this user, retrieved
      // by meaning against this turn (retrieval also reinforces — see
      // memory.js). The explainer is ALWAYS injected while memory is on, even
      // with zero recalls — models that don't know they have a memory system
      // tell the user "I'm stateless and will forget you", which is worse
      // than any missing fact (seen live, 2026-07-14).
      if (promptLeaf?.content && promptMessages[0]?.role === 'system' && memoryEnabled(req.user.id)) {
        let mems = [];
        try { mems = await retrieveMemories(req.user.id, promptLeaf.content); }
        catch { /* embed service down — explainer still goes in */ }
        if (mems.length) req.log.info({ count: mems.length }, 'memories injected');
        const lines = mems.map((m) => {
          const conf = m.confidence >= 0.65 ? '' : ' — stated offhand once, could be a joke; treat as uncertain';
          return `- [id ${m.id} · ${m.tier} · noted ${new Date(m.created_at * 1000).toISOString().slice(0, 10)}] ${m.text}${conf}`;
        });
        // leads the system prompt: small models pay the most attention to
        // the top, and a memory that gets ignored is worse than none.
        // (For remote models the saver moves this block to the END instead —
        // keeping the stable prefix byte-identical is worth more there.)
        const memBlock = '## Your long-term memory\n'
          + 'You HAVE a persistent long-term memory about this user. It survives across conversations '
          + 'and sessions: facts are extracted automatically as you chat, and you can manage it yourself '
          + 'with your memory tools — save_memory (keep a new fact: core = permanent identity, durable = '
          + 'preferences/interests, context = current projects), update_memory (fix a wrong or outdated '
          + 'memory by its id), forget_memory (delete one by id). Never tell the user you are stateless, '
          + 'that you cannot remember them, or that everything resets between chats — none of that is true. '
          + "If they ask you to remember something, call save_memory; if they correct a remembered fact, "
          + 'call update_memory.\n'
          + (lines.length
            ? 'Recalled as relevant to this message (use them directly and confidently; don\'t recite the '
              + 'list unprompted):\n' + lines.join('\n')
            : 'Nothing in memory matched this particular message — but your memory may still hold other '
              + 'facts about them; absence here is not evidence you know nothing.');
        promptMessages[0] = remote
          ? { role: 'system', content: promptMessages[0].content + '\n\n' + memBlock }
          : { role: 'system', content: memBlock + '\n\n' + promptMessages[0].content };
      }
      // attached documents: small docs go in full so any model can read them;
      // larger ones use RAG (+ keyword / leading-chunk fallback) so nothing is silent
      if (promptLeaf?.content && promptMessages[0]?.role === 'system') {
        try {
          const attached = convDocs(conv.id);
          if (attached.length) {
            const names = attached.map((d) => d.name).join(', ');
            const fulls = attached.map((d) => ({
              name: d.name, text: docFullText(d.id), chunks: d.chunks,
            }));
            const totalChars = fulls.reduce((s, d) => s + (d.text?.length ?? 0), 0);
            let block = `## Attached documents\nThe user attached these documents to this conversation: ${names}.\n`
              + 'You CAN read them — the content below is the document text (or the relevant excerpts). '
              + 'Answer from it, cite by document name, and if it is not there say so honestly.\n';
            if (totalChars > 0 && totalChars <= 24_000) {
              req.log.info({ docs: attached.length, chars: totalChars }, 'full docs injected');
              block += '\n' + fulls.map((d) => `### ${d.name}\n${d.text.slice(0, 20_000)}`).join('\n\n');
            } else {
              const hits = await retrieveChunks(req.user.id, attached.map((d) => d.id), promptLeaf.content, { k: 10 });
              if (hits.length) {
                req.log.info({ hits: hits.length }, 'doc excerpts injected');
                block += '\nRelevant excerpts for this message:\n\n'
                  + hits.map((h) => `[${h.name} · part ${h.idx + 1}]\n${h.text.slice(0, 1200)}`).join('\n\n');
              } else {
                // still give the model the opening of each file rather than nothing
                block += '\nOpening of each document:\n\n'
                  + fulls.map((d) => `### ${d.name}\n${(d.text || '').slice(0, 2500)}`).join('\n\n');
              }
            }
            promptMessages[0] = { role: 'system', content: promptMessages[0].content + '\n\n' + block };
          }
        } catch (err) {
          req.log.warn({ err }, 'doc inject failed');
        }
      }
      // attached images: vision models get real pixels; everyone else gets a
      // text description so any chat model can still talk about the picture
      try {
        const ups = convUploads(conv.id);
        if (ups.length) {
          promptMessages = injectUploadsIntoMessages(promptMessages, ups, conv.model_id);
          req.log.info({ n: ups.length, vision: /vision|vl|llava|omni/i.test(conv.model_id || '') },
            'image uploads injected');
        }
      } catch (err) {
        req.log.warn({ err }, 'upload inject failed');
      }
      const params = { max_tokens: -1 };
      for (const k of GEN_PARAM_KEYS) params[k] = conv._settings[k];
      // Mirostat (llama.cpp native): when on, the entropy controller replaces
      // top-k/top-p sampling. Passed straight through to llama-server.
      if (Number(conv._settings.mirostat) > 0) {
        params.mirostat = Number(conv._settings.mirostat) === 2 ? 2 : 1;
        params.mirostat_tau = Number(conv._settings.mirostat_tau) || 5;
        params.mirostat_eta = Number(conv._settings.mirostat_eta) || 0.1;
      }
      // GBNF grammar / JSON-schema passthrough to llama-server (schema wins
      // when both are set — it's the more specific ask)
      if (schemaStr) {
        try { params.json_schema = JSON.parse(schemaStr); }
        catch { send({ type: 'error', message: 'The saved JSON schema for this model is not valid JSON — fix or clear it in Settings.' }); return; }
      } else if (grammarStr) {
        params.grammar = grammarStr;
      }
      // thinking control: enable_thinking is honored by qwen-style templates,
      // reasoning_effort by gpt-oss-style ones; unsupported kwargs are ignored
      const think = conv._settings.thinking;
      // A grammar/schema constrains the WHOLE output — with thinking on,
      // llama-server's reasoning parser swallows the constrained tokens as
      // reasoning_content and the visible reply comes back empty.
      if (think === 'none' || constrained) params.chat_template_kwargs = { enable_thinking: false };
      else if (modeCfg.ultra) params.reasoning_effort = 'high';
      else if (think === 'high' || think === 'low') params.reasoning_effort = think;

      // ---------- cost saver (remote turns only) ----------
      // 1) stable-prefix ordering so provider prompt caches keep hitting
      // 2) auto-compaction when the prompt would blow the context budget
      // 3) exact response cache for identical plain turns
      // 4) cheap-aux model for titles/followups/memory below
      const remoteInfo = remote ? resolveRemote(conv.model_id) : null;
      // monthly spend cap: refuse the turn before anything bills (cache replays
      // are free, but a capped provider means "stop using this key" — the owner
      // raises or clears the cap in Providers to resume)
      if (remoteInfo?.provider?.spend_cap_usd > 0) {
        const cap = remoteInfo.provider.spend_cap_usd;
        const spent = providerMonthSpend(remoteInfo.providerId);
        if (spent >= cap) {
          send({ type: 'error', message: `${remoteInfo.provider.name} hit its monthly spend cap ($${spent.toFixed(2)} of $${cap}) — raise or clear it in Providers.` });
          return; // finally{} closes the stream
        }
      }
      // Context saver — runs before anything else looks at the prompt, and for
      // LOCAL turns too: on a 32k local budget the win is headroom (more room
      // for the actual conversation), on a paid remote turn it is money. The
      // lossless engines (tool-output compression, session dedup) always run;
      // the lossy ones only once the prompt crosses HEADROOM_AT. Doing this
      // BEFORE auto-compaction often means the expensive LLM compaction pass
      // never has to fire at all.
      const saverLevel = conv._settings.context_saver ?? 'auto';
      if (saverLevel !== 'off') {
        try {
          const saved = saveContext(promptMessages, {
            ctxSize: conv._settings.ctx_size,
            level: saverLevel,
          });
          if (saved.report.savedTokens > 0) {
            promptMessages = saved.messages;
            const line = saverSummary(saved.report);
            if (line) send({ type: 'notice', message: line });
            req.log.info(saved.report, 'context saver');
            if (remote) {
              // The saved tokens would have been billed at input rate; log them
              // as savings so the Costs panel shows the engine paying for itself.
              try {
                recordEvent({
                  userId: req.user.id, convId: conv.id, modelId: conv.model_id,
                  kind: 'context_saved', tokensIn: saved.report.savedTokens, costUsd: 0,
                  baselineUsd: costFor(modelRowForRemoteId(conv.model_id), saved.report.savedTokens, 0, 0),
                });
              } catch { /* ledger best-effort */ }
            }
          }
        } catch (err) {
          // A compression bug must never cost the user their turn.
          req.log.warn({ err: String(err?.message ?? err) }, 'context saver skipped');
        }
      }
      if (remote) promptMessages = orderSystemForPrefixCache(promptMessages);
      const auxModel = remote ? await auxModelFor(conv.model_id, req.log) : conv.model_id;
      // ledger helper for background jobs: actual cost on the aux model vs
      // what the conversation's (paid) model would have charged
      const logAux = (kind, model, usage, fallbackIn = 100, fallbackOut = 30) => {
        if (!remote) return;
        try {
          const tin = usage?.prompt_tokens ?? fallbackIn;
          const tout = usage?.completion_tokens ?? fallbackOut;
          recordEvent({
            userId: req.user.id, convId: conv.id, modelId: model, kind,
            tokensIn: tin, tokensOut: tout,
            costUsd: costFor(modelRowForRemoteId(model), tin, tout, 0),
            baselineUsd: auxBaselineCost(modelRowForRemoteId(conv.model_id), tin, tout),
          });
        } catch { /* ledger best-effort */ }
      };
      // fallback-chain hops: toast the user + ledger entry (the retried turn
      // bills under the new model via recordUsage, so no cost rows needed here)
      const fbNotice = (info) => {
        if (info?.type !== 'fallback') return;
        send({ type: 'notice', message: `${info.from} failed (${info.reason}) — falling back to ${info.to}` });
        if (!remote) return;
        try {
          recordEvent({
            userId: req.user.id, convId: conv.id, modelId: conv.model_id,
            kind: 'fallback', tokensIn: 0, tokensOut: 0, costUsd: 0, baselineUsd: 0,
          });
        } catch { /* ledger best-effort */ }
      };
      let turnCacheKey = null;
      if (remote) {
        const pressure = promptPressure(promptMessages, conv._settings.ctx_size);
        if (pressure.over) {
          send({ type: 'notice', message: `Auto-compacting older history to fit the context window (~${Math.round(pressure.used / 1000)}k → ${Math.round(pressure.budget / 1000)}k tokens)…` });
          req.log.info({ used: pressure.used, budget: pressure.budget }, 'auto-compaction fired');
          const r = await autoCompactMessages(promptMessages, auxModel, abort.signal, req.log);
          if (r) {
            promptMessages = r.messages;
            logAux('aux_compact', auxModel, r.usage, 2000, 400);
            const savedTokens = Math.max(0, pressure.used - estimateTokens(promptMessages));
            recordEvent({
              userId: req.user.id, convId: conv.id, modelId: conv.model_id, kind: 'compact_savings',
              tokensIn: savedTokens, costUsd: 0,
              baselineUsd: costFor(modelRowForRemoteId(conv.model_id), savedTokens, 0, 0),
            });
          }
        }
        const cacheOn = cacheEligible({
          remote, wsRow, constrained, regenerateFrom,
          cacheEnabled: remoteInfo?.provider?.cache_enabled !== 0,
        });
        if (cacheOn) {
          turnCacheKey = cacheKey({
            providerId: remoteInfo.providerId, model: remoteInfo.modelId,
            messages: promptMessages, params,
          });
          const hit = cacheLookup(turnCacheKey);
          if (hit) {
            // free replay: stream the saved reply, log the full price as saved
            turnCacheKey = null; // nothing new to store
            replayCacheHit({
              hit, conv, promptLeaf, req, send,
              insertTitle: () => {
                if (conv.title === 'New chat' && promptLeaf?.content) {
                  const t = promptLeaf.content.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60);
                  if (t) {
                    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, conv.id);
                    send({ type: 'title', title: t });
                  }
                }
              },
            });
            return; // finally{} closes the stream
          }
        }
      }

      const spec = makeSpeculator(req.log);
      turnDelta = makeTurnDelta({
        send, abort, log: req.log, spec,
        thinkTimeoutMs: Number(process.env.THINK_TIMEOUT_MS ?? modeCfg.thinkMs),
      });
      const onDelta = turnDelta.onDelta;

      // first call offers the tools (just the start_project gate until the
      // conversation has a workspace); if the template rejects them, retry
      // plain. Constrained turns (grammar/schema) never get tools at all.
      let res;
      let toolsOn = !constrained;
      try {
        if (constrained) {
          res = await streamChat({
            model: conv.model_id, messages: promptMessages, params,
            abortSignal: abort.signal, onDelta, onEvent: fbNotice,
          });
        } else {
          const memTools = memoryEnabled(req.user.id) ? MEMORY_TOOLS : [];
          const baseTools = filterTools(wsRow ? [...AGENT_TOOLS, ...WIDGET_TOOLS, ...memTools]
            : [START_PROJECT_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL, FETCH_PAGE_TOOL, ...WIDGET_TOOLS, ...memTools], disabledTools);
          res = await streamChat({
            model: conv.model_id, messages: promptMessages,
            params: {
              ...params,
              tools: imgPrefs.allowed
                ? baseTools
                : baseTools.filter((t) => t.function.name !== 'generate_image'),
              tool_choice: 'auto',
            },
            abortSignal: abort.signal, onDelta, onEvent: fbNotice,
          });
        }
      } catch (err) {
        if (abort.signal.aborted || constrained || !/tool/i.test(String(err.message))) throw err;
        req.log.warn({ model: conv.model_id }, 'template rejected tools — plain chat fallback');
        toolsOn = false;
        res = await streamChat({
          model: conv.model_id, messages: promptMessages, params,
          abortSignal: abort.signal, onDelta, onEvent: fbNotice,
        });
      }

      let { content: text, reasoning, timings, usage } = res;
      text = stripFakeImages(text);
      let runId = null;
      let searchData = null;

      const callNames = new Set((res.toolCalls ?? []).map((t) => t.function.name));
      const wantsInlineTools = callNames.has('web_search') || callNames.has('fetch_page')
        || [...WIDGET_TOOL_NAMES].some((n) => callNames.has(n))
        || [...MEMORY_TOOL_NAMES].some((n) => callNames.has(n));
      if (toolsOn && res.toolCalls?.length && wantsInlineTools && !callNames.has('start_project')) {
        // inline-tools turn: web search (with live trace + citations),
        // interactive widgets, and/or memory ops, in one batched loop;
        // the model answers at the end.
        const searchTools = filterTools([
          ...(imgPrefs.allowed ? [GENERATE_IMAGE_TOOL] : []),
          WEB_SEARCH_TOOL, FETCH_PAGE_TOOL, ...WIDGET_TOOLS,
          ...(memoryEnabled(req.user.id) ? MEMORY_TOOLS : []),
        ], disabledTools);
        const r = await runInlineSearch({
          conv, userId: req.user.id, userLoc, promptMessages, firstResult: res, params,
          searchTools, imgPrefs, caps: modeCfg, send, abort, onDelta, log: req.log, spec,
        });
        text = r.text;
        reasoning = r.reasoning ?? reasoning;
        timings = r.timings ?? timings;
        usage = r.usage ?? usage;
        searchData = r.search;
      } else if (toolsOn && res.toolCalls?.length
          && res.toolCalls.every((t) => t.function.name === 'generate_image')) {
        // pure image turn — no workspace, no run
        const r = await runImageTurn({
          conv, req, res, promptMessages, imgPrefs, params, send, abort, onDelta, log: req.log,
        });
        text = r.text;
        reasoning = r.reasoning ?? reasoning;
        timings = r.timings ?? timings;
        usage = r.usage ?? usage;
      } else if (toolsOn && !remote && res.toolCalls?.length) {
        // the model reached for file/shell tools → this turn becomes an agent
        // run (local models only — remote/paid models never drive the sandbox)
        const r = await runAgentTurn({
          conv, req, res, promptMessages, promptLeaf, wsRow, imgPrefs, disabledTools,
          params, userLoc, send, abort, log: req.log,
        });
        text = r.text;
        reasoning = r.reasoning ?? reasoning;
        timings = r.timings ?? timings;
        usage = r.usage ?? usage;
        runId = r.runId ?? runId;
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
        searchJson: searchData && searchData.steps.length ? JSON.stringify(searchData) : null,
      });
      setLeaf(conv.id, asst.id);
      recordUsage(conv.model_id, usage, timings, { userId: req.user.id, convId: conv.id });
      // cap early-warning: one toast as this turn's spend crosses 80% of the cap
      if (remoteInfo?.provider?.spend_cap_usd > 0) {
        try {
          const cap = remoteInfo.provider.spend_cap_usd;
          const spent = providerMonthSpend(remoteInfo.providerId);
          const turnCost = costFor(modelRowForRemoteId(conv.model_id),
            usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, usage?.cached_tokens ?? 0);
          if (spent >= 0.8 * cap && spent - turnCost < 0.8 * cap && spent < cap) {
            send({ type: 'notice', message: `${remoteInfo.provider.name} is at ${Math.round((spent / cap) * 100)}% of its $${cap} monthly cap` });
          }
        } catch { /* alert best-effort */ }
      }
      send({ type: 'done', msg: asst });

      // saver: stash plain remote replies so an identical later turn replays free
      if (turnCacheKey && !runId && !searchData && text) {
        try {
          cacheStore({
            hash: turnCacheKey,
            providerId: remoteInfo.providerId, model: remoteInfo.modelId,
            response: text, thinking: reasoning || null,
            tokensIn: usage?.prompt_tokens ?? 0,
            tokensOut: usage?.completion_tokens ?? 0,
          });
        } catch { /* cache is best-effort */ }
      }

      // context bar: exact prompt size if the model were asked again right now
      // (skipped when the client already left — no GPU work for a dead socket;
      // remote models get a chars/4 estimate from the dispatcher instead)
      if (!abort.signal.aborted) {
        try {
          const used = await countInputTokens(conv.model_id, [...promptMessages, { role: 'assistant', content: text }]);
          if (used != null) send({ type: 'context', used, budget: conv._settings.ctx_size });
        } catch { /* non-fatal */ }
      }

      // auto-title on first exchange (on the cheap aux model for remote chats)
      if (!abort.signal.aborted && conv.title === 'New chat' && !regenerateFrom) {
        try {
          // generous max_tokens: thinking models burn budget on reasoning first
          const { content: title, reasoning: titleReasoning, usage: titleUsage } = await streamChat({
            model: auxModel,
            messages: [{
              role: 'user',
              content: `Reply with ONLY a 3-6 word title (no quotes, no punctuation at the end) for a chat that starts:\nUser: ${promptLeaf.content.slice(0, 400)}\nAssistant: ${text.slice(0, 400)}`,
            }],
            params: { max_tokens: 800, temperature: 0.3, chat_template_kwargs: { enable_thinking: false } },
          });
          logAux('aux_title', auxModel, titleUsage, 260, 20);
          const raw = title.trim() || (titleReasoning ?? '').trim().split('\n').pop() || '';
          const clean = raw.replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 80);
          if (clean) {
            db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(clean, conv.id);
            send({ type: 'title', title: clean });
          }
        } catch { /* non-fatal */ }
      }

      // clickable follow-up prompts under the reply (cheap aux model when remote)
      if (!abort.signal.aborted && text && text.trim().length >= 40 && promptLeaf?.content) {
        try {
          const items = await generateFollowups({
            model: auxModel,
            userText: promptLeaf.content,
            replyText: text,
            abortSignal: abort.signal,
          });
          logAux('aux_followup', auxModel, null, 700, 60);
          // always emit so the client can drop its "Suggesting…" skeleton
          send({ type: 'followups', messageId: asst.id, items });
        } catch (err) {
          req.log.warn({ err }, 'followup generation failed (non-fatal)');
          try { send({ type: 'followups', messageId: asst.id, items: [] }); } catch { /* socket gone */ }
        }
      }

      // learn: distill durable facts from this exchange into long-term memory
      // (runs on the cheap aux model for remote chats, after delivery)
      if (!abort.signal.aborted && text && promptLeaf?.content && memoryEnabled(req.user.id)) {
        try {
          await rememberFromExchange({
            model: auxModel, userText: promptLeaf.content, replyText: text,
            userId: req.user.id, convId: conv.id, log: req.log,
          });
          logAux('aux_memory', auxModel, null, 900, 120);
        } catch (err) { req.log.warn({ err }, 'memory extraction failed (non-fatal)'); }
      }
    } catch (err) {
      req.log.error({ err }, 'chat generation failed');
      if (!abort.signal.aborted) {
        // Park the error on the live snapshot so persistInterruptedReply includes it
        // and reattached clients see why it stopped.
        send({ type: 'error', message: String(err.message ?? err) });
      }
    } finally {
      turnDelta?.clearTimer();
      clearInterval(pingPrimary);
      releaseGpu?.();
      // Always save a partial assistant row when we never reached a clean `done`.
      // This is what lets "continue" see the error + work instead of wiping the turn.
      const aborted = abort.signal.aborted;
      // If we crashed out of an agent turn without finishRun, free the slot so
      // the next message is not 409 "a run is already active".
      try {
        if (conv.workspace_id) {
          const stuck = db.prepare(`SELECT id FROM agent_runs WHERE workspace_id = ?
            AND status IN ('running','waiting_approval')`).all(conv.workspace_id);
          for (const row of stuck) {
            if (!isRunLive(row.id) || aborted) {
              try { finishRun(row.id, aborted ? 'stopped' : 'error'); } catch { /* */ }
            }
          }
        }
      } catch (err) { req.log.warn({ err }, 'workspace run cleanup failed'); }
      if (!job.finalMsg && promptLeaf) {
        try {
          persistInterruptedReply(job, conv, promptLeaf, { aborted, log: req.log });
        } catch (err) {
          req.log.error({ err }, 'partial reply persist failed');
        }
      }
      job.listeners.delete(writePrimary);
      const st = aborted ? 'stopped'
        : (job.finalMsg ? (job.state.error ? 'error' : 'done')
          : (job.state.error ? 'error' : 'done'));
      finishLiveJob(job, st);
      // Tell every reattached live tail to close, then drop them
      for (const fn of [...job.listeners]) {
        try { fn({ type: 'stream_end' }); } catch { /* ignore */ }
      }
      job.listeners.clear();
      if (!reply.raw.writableEnded) {
        try { reply.raw.end(); } catch { /* already gone */ }
      }
    }
  });

}
