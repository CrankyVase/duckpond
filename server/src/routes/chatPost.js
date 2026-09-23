// POST /api/conversations/:id/chat — starts a server-owned turn, registered from
// routes/chat.js (same plugin scope, so the requireAuth hook applies). Split
// out when the original chat.js outgrew one file.
import { db } from '../db.js';
import { submissionHash, submissionKey } from '../idempotency.js';
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
  broadcast, createLiveJob, finishLiveJob, getLiveJob, saveInterruptedSnapshot, waitForStoppingJob,
} from '../liveJobs.js';
import { convDocs, docFullText, retrieveChunks } from '../docs.js';
// remote providers + cost saver (feat/remote-providers)
import { auxModelFor, isRemoteId } from '../chatBackend.js';
import {
  auxBaselineCost, costFor, modelRowForRemoteId, providerMonthSpend, recordEvent,
} from '../costs.js';
import {
  cacheKey, cacheLookup, cacheStore, estimateTokens, parseCaps, resolveRemote,
} from '../providers.js';
import { cacheEligible, orderSystemForPrefixCache, promptPressure } from '../tokenSaver.js';
import { saveContext, saverSummary } from '../contextsaver.js';
import { reasoningDialect, reasoningParams } from '../reasoning.js';
import { capabilityManifest } from '../permissions.js';
import { GITHUB_READ_TOOLS, hasGithub } from '../github.js';
import {
  GEN_PARAM_KEYS, MEMORY_TOOLS, MEMORY_TOOL_NAMES, START_PROJECT_TOOL,
  WIDGET_TOOLS, WIDGET_TOOL_NAMES,
  buildPrompt, convForUser, filterTools, insertMessage,
  persistInterruptedReply, recordUsage, setLeaf, stripFakeImages,
} from '../chatkit.js';
import {
  RESEARCH_MODES, ULTRA_DIRECTIVE, makeSpeculator, selectTurnWidgets, withToolsPolicy,
} from '../chatpolicy.js';
import {
  autoCompactMessages, makeTurnDelta, replayCacheHit,
  runAgentTurn, runDiffusionTurn, runImageTurn, runInlineSearch,
} from '../chatflow.js';

// ---------- agentic guard: keep project code OUT of the chat bubble ----------
// Local models love to narrate a multi-file build as markdown ("file 1 of 4…")
// or draft the entire thing inside their thinking and answer with an empty
// bubble — the turn never becomes an agent run and nothing lands in the
// workspace. When the first attempt looks like that, one pointed retry asks
// for the start_project call; if the model still declines, chat wins.

const NAMED_FILE_RE = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?[\w./@-]+\.(?:html?|css|m?js|jsx|ts|tsx|svelte|vue|py|json|ya?ml|toml|md|sh|c(?:pp|c)?|h|java|go|rs|cs|php|rb|kt|swift|sql)\b/i;
const FILE_MARCH_RE = /file\s+\d+\s*(?:\/|of|—|-)\s*\d+|(?:the\s+)?(?:first|second|third|fourth|next)\s+file|next,?\s+(?:let'?s |I'?ll |we'?ll )?(?:create|write|make)\b[^.\n]{0,60}\.(?:html?|css|m?js|py|ts|tsx|json|md|sh)/i;

function looksLikeProjectNarration(text, reasoning = '') {
  const check = (s) => {
    if (!s) return false;
    const fences = (s.match(/```/g) ?? []).length;
    const numbered = FILE_MARCH_RE.test(s);
    const named = NAMED_FILE_RE.test(s);
    return numbered || (named && fences >= 4) || fences >= 6;
  };
  return check(text) || (!String(text ?? '').trim() && check(reasoning));
}

const PROJECT_NUDGE = 'Stop. You are writing a multi-file project as chat text instead of using your tools — '
  + 'that is not what the user wants and it does not go anywhere. This is project work: call the start_project '
  + 'tool NOW with a short kebab-case name and a concise plan (the code you drafted becomes the plan). '
  + 'After the workspace opens, create the files with write_file, change them with edit_file, and verify with '
  + 'one-shot commands that exit. Do not paste project code into the chat.';

function messageExists(convId, id) {
  return id != null && !!db.prepare('SELECT 1 FROM messages WHERE id = ? AND conv_id = ?').get(id, convId);
}

// A missing parent must not become a new root: that drops every earlier
// message off the active path. Use the live leaf, then the newest real row.
function resolveDanglingParent(convId) {
  const leaf = db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(convId)?.active_leaf_id ?? null;
  if (messageExists(convId, leaf)) return leaf;
  return db.prepare('SELECT id FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(convId)?.id ?? null;
}

export function registerChatPost(app) {
  // Start a turn and return immediately. Progress is read from GET /live so a
  // browser refresh or proxy request limit cannot cancel the model invocation.
  // body: { content?, parentId?, regenerateFrom? } — exactly one of content|regenerateFrom.
  app.post('/api/conversations/:id/chat', async (req, reply) => {
    const conv = convForUser(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const { content, parentId, regenerateFrom } = req.body ?? {};
    let idempotencyKey;
    try { idempotencyKey = submissionKey(req.body?.idempotencyKey); }
    catch (err) { return reply.code(400).send({ error: err.message }); }
    const requestHash = submissionHash({ content, parentId, regenerateFrom,
      researchMode: req.body?.researchMode ?? null });
    if (idempotencyKey) {
      const previous = db.prepare('SELECT id, status, request_hash FROM chat_jobs WHERE user_id = ? AND conv_id = ? AND idempotency_key = ?')
        .get(req.user.id, conv.id, idempotencyKey);
      if (previous) {
        if (previous.request_hash !== requestHash) return reply.code(409).send({ error: 'idempotency key was used for a different request' });
        return reply.code(202).send({ convId: conv.id, jobId: previous.id, status: previous.status, duplicate: true });
      }
    }
    if (!conv.model_id) return reply.code(400).send({ error: 'no model selected' });

    // Stop followed by Send waits for prior cleanup; other concurrent sends still 409.
    await waitForStoppingJob(conv.id);
    if (idempotencyKey) {
      const previous = db.prepare('SELECT id, status, request_hash FROM chat_jobs WHERE user_id = ? AND conv_id = ? AND idempotency_key = ?')
        .get(req.user.id, conv.id, idempotencyKey);
      if (previous) {
        if (previous.request_hash !== requestHash) return reply.code(409).send({ error: 'idempotency key was used for a different request' });
        return reply.code(202).send({ convId: conv.id, jobId: previous.id, status: previous.status, duplicate: true });
      }
    }
    if (getLiveJob(conv.id)?.status === 'running') {
      return reply.code(409).send({ error: 'a reply is already generating for this chat' });
    }

    if (regenerateFrom) {
      const src = db.prepare('SELECT role FROM messages WHERE id = ? AND conv_id = ?').get(regenerateFrom, conv.id);
      if (src?.role !== 'assistant') return reply.code(400).send({ error: 'bad regenerateFrom' });
    } else if (typeof content !== 'string' || !content.trim()) {
      return reply.code(400).send({ error: 'empty message' });
    }
    // remote (paid API) models take a different path for GPU queueing, warm-up
    // probes and agent tooling — and get the cost-saver pipeline on top
    const remote = isRemoteId(conv.model_id);
    const sourceIp = clientIp(req);
    // search depth: quick | normal | ultra (deep research)
    const researchMode = RESEARCH_MODES[req.body?.researchMode] ? req.body.researchMode : 'normal';
    const modeCfg = RESEARCH_MODES[researchMode];

    let job;
    let promptLeaf;
    try {
      // Commit the accepted prompt and its job together before returning 202.
      // A restart can reconcile the job without re-inserting the user message.
      db.transaction(() => {
        if (regenerateFrom) {
          const src = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(regenerateFrom, conv.id);
          promptLeaf = src?.role === 'assistant'
            ? db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(src.parent_id, conv.id)
            : null;
          if (!promptLeaf) throw Object.assign(new Error('bad regenerateFrom'), { code: 400 });
        } else {
          const filtered = checkUserContent(req.user.id, content, 'chat');
          if (!filtered.ok) throw Object.assign(new Error(filtered.reason), { code: 400, filterCode: filtered.code });
          // Explicit null starts a new root; an absent parent uses the current leaf.
          // A dangling id is repaired onto the saved branch instead of null.
          let parent = parentId !== undefined ? parentId : (conv.active_leaf_id ?? null);
          if (parent != null && !messageExists(conv.id, parent)) parent = resolveDanglingParent(conv.id);
          // Continue under an interrupted assistant when that row is durable.
          if (/^(continue|keep going|resume|go on|try again|pick up)\b/i.test(content.trim()) && parent != null) {
            const leaf = db.prepare('SELECT * FROM messages WHERE id = ? AND conv_id = ?').get(parent, conv.id);
            if (leaf?.role === 'user') {
              const asst = db.prepare(`SELECT * FROM messages WHERE conv_id = ? AND parent_id = ? AND role = 'assistant'
                ORDER BY id DESC LIMIT 1`).get(conv.id, leaf.id);
              if (asst && />\s*(Interrupted|Stopped|connection)/i.test(asst.content || '')) parent = asst.id;
            }
          }
          promptLeaf = insertMessage(conv.id, parent, 'user', content);
          setLeaf(conv.id, promptLeaf.id);
        }
        job = createLiveJob(conv.id, req.user.id, promptLeaf, idempotencyKey, requestHash);
      })();
    }
    catch (err) {
      return reply.code(err.code === 409 ? 409 : err.code === 400 ? 400 : 500)
        .send({ error: err.message, ...(err.filterCode ? { code: err.filterCode } : {}) });
    }
    const abort = job.abort;
    const send = (obj) => broadcast(job, obj);
    // The request ends here; all state and the abort signal belong to the job.
    // setImmediate makes the 202 observable before slow setup (such as GeoIP).
    setImmediate(() => { void processTurn().catch((err) => {
      req.log.error({ err }, 'detached chat turn failed');
      send({ type: 'error', message: String(err.message ?? err) });
      if (!job.finalMsg && promptLeaf) {
        try {
          const saved = saveInterruptedSnapshot({
            convId: conv.id,
            promptId: promptLeaf.id,
            modelId: conv.model_id,
            state: job.state,
            aborted: job.abort.signal.aborted,
          });
          if (saved) job.finalMsg = saved;
        } catch (parkErr) {
          req.log.error({ err: parkErr }, 'failed to keep partial reply');
        }
      }
      finishLiveJob(job, 'error');
      for (const fn of [...job.listeners]) {
        try { fn({ type: 'stream_end' }); } catch { /* ignore */ }
      }
      job.listeners.clear();
    }); });
    return reply.code(202).send({ convId: conv.id, jobId: job.id, status: 'running' });

    async function processTurn() {
    let releaseGpu = null;
    let turnDelta = null;       // per-turn stream wiring (timer cleared in finally)
    const t0 = Date.now();      // turn wall-clock start (tok/s fallback below)
    try {
      // Resolve location inside the job; a slow lookup must not hold the POST.
      const userLoc = await ipLocation(sourceIp);

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
      if (conv.mode !== 'agent') {
        wsRow = null;
        disabledTools.add('start_project');
      }
      // capability gate (generative UI): small models fumble the nested
      // tool-call JSON a dashboard needs — don't offer or describe it to them
      // constrained output (Settings → Structured output): a GBNF grammar or
      // JSON schema forces the shape of the WHOLE reply, which is incompatible
      // with tool-call JSON — the turn runs plain, and the system prompt skips
      // the tool policies it couldn't honor anyway
      const schemaStr = String(conv._settings.json_schema ?? '').trim();
      const grammarStr = String(conv._settings.grammar ?? '').trim();
      const constrained = !!(schemaStr || grammarStr);
      const requestedWidgets = wsRow ? new Set() : selectTurnWidgets(promptLeaf?.content);
      for (const name of disabledTools) requestedWidgets.delete(name);
      // Construct the tools before their prompt policy. A disabled or unavailable
      // tool must not be described to the model as something it can call.
      // Automatic extraction handles ordinary facts after the reply. Only
      // advertise direct memory tools when the user explicitly asks to manage
      // memory; small models otherwise see three irrelevant tool schemas.
      const memoryRequest = String(promptLeaf?.content ?? '').toLowerCase();
      const memoryNames = new Set();
      if (/\b(remember|save (?:this|that|it|to (?:your )?memory)|keep (?:this|that|it) in mind)\b/.test(memoryRequest)) memoryNames.add('save_memory');
      if (/\b(update|correct|change|fix)\b.{0,50}\b(memory|remembered|what you know|fact)\b|\bwhat you remember\b.{0,50}\b(wrong|outdated)\b/.test(memoryRequest)) memoryNames.add('update_memory');
      if (/\b(forget|delete|remove)\b.{0,50}\b(memory|remember|about me|that|this|it)\b/.test(memoryRequest)) memoryNames.add('forget_memory');
      const memTools = memoryEnabled(req.user.id)
        ? MEMORY_TOOLS.filter((tool) => memoryNames.has(tool.function.name)) : [];
      const ghOn = hasGithub(req.user.id);
      const turnTools = constrained ? [] : filterTools(
        wsRow
          ? AGENT_TOOLS
          : [START_PROJECT_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL, FETCH_PAGE_TOOL,
            ...(ghOn ? GITHUB_READ_TOOLS : []),
            ...WIDGET_TOOLS.filter((t) => requestedWidgets.has(t.function.name)), ...memTools],
        disabledTools,
      ).filter((t) => imgPrefs.allowed || t.function.name !== 'generate_image');
      const availableTools = new Set(turnTools.map((t) => t.function.name));
      let promptMessages = constrained
        ? buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id)
        : withToolsPolicy(
          buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id), wsRow,
          imgPrefs.allowed, userLoc, disabledTools, requestedWidgets, availableTools);

      // Tell the model its own permissions. A model that doesn't know a tool
      // needs approval either avoids useful tools or promises things it can't
      // deliver — and it pre-asks in prose, which is exactly the double-prompt
      // the approval card is supposed to replace.
      if (!constrained && conv.mode === 'agent' && promptMessages[0]?.role === 'system') {
        const manifest = capabilityManifest(req.user.id, {
          tools: turnTools, hasWorkspace: !!wsRow, hasGithub: ghOn,
        });
        if (manifest) {
          promptMessages[0] = { role: 'system', content: `${promptMessages[0].content}\n\n${manifest}` };
        }
      }
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
        const memBlock = '## Memory\n'
          + 'Your memory persists across chats. Do not claim you are stateless. '
          + (availableTools.has('save_memory')
            ? 'Use save_memory for explicit requests to remember, update_memory for corrections, and forget_memory for deletion.\n'
            : '\n')
          + (lines.length ? 'Relevant memories (use naturally; do not recite):\n' + lines.join('\n') : '');
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
              block += '\n' + fulls.map((d) => `### ${d.name}\n${d.text}`).join('\n\n');
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
      const outputLimit = Number(conv._settings.max_tokens);
      const params = { max_tokens: Number.isInteger(outputLimit) && outputLimit > 0 ? outputLimit : -1 };
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
      // Thinking control, translated to the dialect this model actually speaks
      // (reasoning.js). `reasoning_effort` is an OpenAI-ism — Anthropic wants a
      // token budget, OpenRouter its own `reasoning` object, qwen templates
      // `enable_thinking`. Sending the wrong one is why the toggle used to look
      // like it did nothing on most providers.
      //
      // A grammar/schema constrains the WHOLE output — with thinking on, the
      // reasoning parser swallows the constrained tokens and the visible reply
      // comes back empty, so `constrained` forces thinking off in every dialect.
      {
        const thinkPref = modeCfg.ultra ? 'high' : conv._settings.thinking;
        const rr = remote ? resolveRemote(conv.model_id) : null;
        const dialect = reasoningDialect(rr?.provider ?? null, rr?.modelId ?? conv.model_id);
        // Local models: llama-server decides from the template, so assume yes.
        // Remote: only send a reasoning param when the catalog says it can.
        const supported = rr?.model ? parseCaps(rr.model).reasoning === true : true;
        const rp = reasoningParams({
          dialect,
          effort: thinkPref,
          supported,
          budget: Number(conv._settings.thinking_budget) || 0,
          constrained,
          remote,
        });
        // `_soft` is prompt text, not a request param (Qwen3's /think and
        // /no_think switches) — it goes on the last user message instead.
        const { _soft: soft, ...rest } = rp;
        Object.assign(params, rest);
        if (soft) {
          for (let i = promptMessages.length - 1; i >= 0; i -= 1) {
            const m = promptMessages[i];
            if (m.role !== 'user' || typeof m.content !== 'string') continue;
            promptMessages[i] = { ...m, content: `${m.content} ${soft}` };
            break;
          }
        }
      }

      // ---------- cost saver (remote turns only) ----------
      // 1) stable-prefix ordering so provider prompt caches keep hitting
      // 2) auto-compaction when the prompt would blow the context budget
      // 3) exact response cache for identical plain turns
      // 4) cheap-aux model for memory and compaction
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
            // Logged for LOCAL turns too, with a zero baseline: there is no bill
            // to save, but the tokens are still real and the Settings panel
            // shows them. Only remote turns get a dollar baseline.
            try {
              recordEvent({
                userId: req.user.id, convId: conv.id, modelId: conv.model_id,
                kind: 'context_saved', tokensIn: saved.report.savedTokens, costUsd: 0,
                baselineUsd: remote
                  ? costFor(modelRowForRemoteId(conv.model_id), saved.report.savedTokens, 0, 0)
                  : 0,
              });
            } catch { /* ledger best-effort */ }
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
        if (info?.type === 'retry') {
          // Local-only (llama.js never emits this for remote calls): a dropped
          // connection to the router before anything streamed — sleeping model
          // waking up, a swap between models, a TCP hiccup. Surfaced so a retry
          // reads as "reconnecting" instead of the turn silently taking longer.
          send({ type: 'notice', message: `Connection to the model dropped (${info.reason}) — reconnecting…` });
          return;
        }
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
      } else {
        // LOCAL turns compact too now — a long coding chat used to walk straight
        // into the context wall and die there. Cheap guard: chars/4 estimate
        // first, exact router count only when the estimate says we're close.
        const est = estimateTokens(promptMessages);
        const budget = Number(conv._settings.ctx_size) > 0 ? Number(conv._settings.ctx_size) : 32_768;
        if (est > budget * 0.75) {
          let used = est;
          try { used = await countInputTokens(conv.model_id, promptMessages) ?? est; } catch { /* estimate stands */ }
          if (used > budget * 0.8) {
            send({ type: 'notice', message: `Auto-compacting older history to fit the context window (~${Math.round(used / 1000)}k → ${Math.round(budget / 1000)}k tokens)…` });
            req.log.info({ used, budget }, 'local auto-compaction fired');
            const r = await autoCompactMessages(promptMessages, conv.model_id, abort.signal, req.log);
            if (r) {
              promptMessages = r.messages;
              try {
                const now = await countInputTokens(conv.model_id, promptMessages);
                if (now != null) send({ type: 'context', used: now, budget });
              } catch { /* bar refreshes later */ }
            }
          }
        }
      }
      if (remote) {
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

      send({ type: 'context', used: estimateTokens(promptMessages), budget: conv._settings.ctx_size, estimated: true });
      const spec = makeSpeculator(req.log, abort.signal);
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
          res = await streamChat({
            model: conv.model_id, messages: promptMessages,
            params: {
              ...params,
              tools: turnTools,          // hoisted above, same list the manifest described
              tool_choice: 'auto',
            },
            abortSignal: abort.signal, onDelta, onEvent: fbNotice,
          });
        }
      } catch (err) {
        if (abort.signal.aborted || constrained || !/tool/i.test(String(err.message))) throw err;
        if (conv.mode === 'agent') throw new Error(`The selected model endpoint rejected tool calls: ${err.message}. Check its chat template or provider configuration; your model selection has not changed.`);
        req.log.warn({ model: conv.model_id }, 'template rejected tools — plain chat fallback');
        toolsOn = false;
        res = await streamChat({
          model: conv.model_id, messages: promptMessages, params,
          abortSignal: abort.signal, onDelta, onEvent: fbNotice,
        });
      }

      let { content: text, reasoning, timings, usage } = res;
      // live context accounting: the first attempt's real prompt size, so the
      // bar moves before the reply even finishes (agent runs update per step)
      {
        const usedNow = res.usage?.prompt_tokens ?? res.timings?.prompt_n ?? null;
        if (usedNow != null) send({ type: 'context', used: usedNow, budget: conv._settings.ctx_size });
      }
      text = stripFakeImages(text);
      // the guard itself — one retry, only when project mode is available
      if (toolsOn && conv.mode === 'agent' && !constrained && !wsRow && !res.toolCalls?.length
          && !disabledTools.has('start_project')
          && looksLikeProjectNarration(text, reasoning)) {
        send({ type: 'notice', message: 'That belongs in a workspace — starting project mode…' });
        req.log.info({ conv: conv.id }, 'project narration in chat — nudging to start_project');
        res = await streamChat({
          model: conv.model_id,
          messages: [
            ...promptMessages,
            { role: 'assistant', content: text },
            { role: 'user', content: PROJECT_NUDGE },
          ],
          params: { ...params, tools: turnTools, tool_choice: 'auto' },
          abortSignal: abort.signal, onDelta, onEvent: fbNotice,
        });
        text = stripFakeImages(res.content ?? '');
        reasoning = res.reasoning ?? reasoning;
        timings = res.timings ?? timings;
        usage = res.usage ?? usage;
        const usedNudge = res.usage?.prompt_tokens ?? res.timings?.prompt_n ?? null;
        if (usedNudge != null) send({ type: 'context', used: usedNudge, budget: conv._settings.ctx_size });
      }
      let runId = null;
      let searchData = null;

      let finalLoopMessages = null;
      const callNames = new Set((res.toolCalls ?? []).map((t) => t.function.name));
      const wantsInlineTools = callNames.has('web_search') || callNames.has('fetch_page')
        || [...WIDGET_TOOL_NAMES].some((n) => callNames.has(n))
        || [...MEMORY_TOOL_NAMES].some((n) => callNames.has(n));
      if (toolsOn && !wsRow && res.toolCalls?.length && wantsInlineTools && !callNames.has('start_project')) {
        // inline-tools turn: web search (with live trace + citations),
        // interactive widgets, and/or memory ops, in one batched loop;
        // the model answers at the end.
        const inlineNames = new Set(['generate_image', 'web_search', 'fetch_page',
          ...WIDGET_TOOL_NAMES, ...MEMORY_TOOL_NAMES]);
        const searchTools = turnTools.filter((t) => inlineNames.has(t.function.name));
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
      } else if (toolsOn && conv.mode === 'agent' && res.toolCalls?.length) {
        // the model reached for file/shell tools → this turn becomes an agent
        // run (local models only — remote/paid models never drive the sandbox)
        const r = await runAgentTurn({
          conv, req, res, promptMessages, promptLeaf, wsRow, imgPrefs, disabledTools,
          params, userLoc, send, abort, log: req.log, chatJobId: job.id,
        });
        text = r.text;
        reasoning = r.reasoning ?? reasoning;
        timings = r.timings ?? timings;
        usage = r.usage ?? usage;
        runId = r.runId ?? runId;
        finalLoopMessages = r.messages ?? null;
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
          // agent runs rewrite the transcript in place (gate path replaces the
          // array) — count the REAL final prompt, or a long run's usage is lost
          const finalPrompt = finalLoopMessages ?? promptMessages;
          const used = await countInputTokens(conv.model_id, [...finalPrompt, { role: 'assistant', content: text }]);
          if (used != null) send({ type: 'context', used, budget: conv._settings.ctx_size });
        } catch { /* non-fatal */ }
      }

      // A local title is immediate and avoids a second model pass after the
      // answer. The user can still rename the conversation themselves.
      if (!abort.signal.aborted && conv.title === 'New chat' && !regenerateFrom) {
        const clean = promptLeaf?.content?.trim().replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ').slice(0, 72);
        if (clean) {
          db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(clean, conv.id);
          send({ type: 'title', title: clean });
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
        let parked = null;
        try {
          parked = persistInterruptedReply(job, conv, promptLeaf, { aborted, log: req.log });
        } catch (err) {
          req.log.error({ err }, 'partial reply persist failed');
        }
        // Nothing worth parking (no output, no error — e.g. dropped while
        // queued in the GPU lane): still advance the leaf to the user's prompt,
        // or the conversation silently forgets it was ever asked.
        if (!parked && conv.id) {
          try { setLeaf(conv.id, promptLeaf.id); } catch { /* non-fatal */ }
        }
      }
      const st = aborted ? 'stopped'
        : (job.finalMsg ? (job.state.error ? 'error' : 'done')
          : (job.state.error ? 'error' : 'done'));
      finishLiveJob(job, st);
      // Tell every reattached live tail to close, then drop them
      for (const fn of [...job.listeners]) {
        try { fn({ type: 'stream_end' }); } catch { /* ignore */ }
      }
      job.listeners.clear();
    }
    }
  });

}
