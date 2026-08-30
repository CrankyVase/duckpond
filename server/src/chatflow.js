// Turn-level flows shared by the chat routes: diffusion turns, the
// Perplexity-style inline web-search loop, follow-up chips, the cost saver's
// auto-compaction, per-turn stream wiring, cached-turn replay, and the agent
// branch. Split out of routes/chat.js (it outgrew one file).
import { db } from './db.js';
import { listModels, streamChat } from './llama.js';
import {
  AGENT_TOOLS, agentLoop, bindRunAbort, createRun, createWorkspaceRow,
  emit as emitRunEvent, execTool, finishRun, releaseRunAbort, subscribeRun,
} from './routes/agent.js';
import { checkUserContent } from './contentFilter.js';
import { generateViaBridge, stepsForQuality } from './imagegen.js';
import { fetchPageStructured, searchWebStructured, sourceLabel } from './websearch.js';
import { corePrompt } from './settings.js';
import { diffusionModelFile, generateDiffusion } from './diffusiongen.js';
import { costFor, modelRowForRemoteId, recordEvent } from './costs.js';
import {
  MEMORY_TOOL_NAMES, WIDGET_BUILDERS, buildPrompt, execMemoryTool, filterTools,
  insertMessage, setLeaf, stripFakeImages,
} from './chatkit.js';
import { slugify, withToolsPolicy, wsNameFrom } from './chatpolicy.js';

// ---------- per-turn stream wiring (watchdog, loop detector, speculator) ----------
// Returns the onDelta for streamChat plus the arm/disarm controls. The thinking
// watchdog is an idle timer (every reasoning token resets it), not a thinking
// cap; the loop detector catches models repeating the same chunk forever.
export function makeTurnDelta({ send, abort, log, thinkTimeoutMs, spec }) {
  let thinkTimer = null;
  let lastTick = 0;
  const disarmThink = () => { if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; } };
  const armThink = () => {
    clearTimeout(thinkTimer);
    thinkTimer = setTimeout(() => {
      thinkTimer = null;
      send({ type: 'error', message: `Stopped — the model went silent mid-thought for over ${Math.round(thinkTimeoutMs / 60_000)} min without answering or using a tool.` });
      abort.abort();
    }, thinkTimeoutMs);
  };
  let reasoningTail = '';
  const REPEAT_WINDOW = 200;
  const REPEAT_SCAN = 4000; // only scan the recent tail — stay cheap on very long thinks
  const REPEAT_COUNT = 3;
  const checkRepeat = () => {
    if (reasoningTail.length < REPEAT_WINDOW * REPEAT_COUNT) return false;
    const scan = reasoningTail.slice(-REPEAT_SCAN);
    const probe = scan.slice(-REPEAT_WINDOW);
    let count = 0, from = 0;
    for (;;) {
      const i = scan.indexOf(probe, from);
      if (i === -1) break;
      count++;
      from = i + 1;
    }
    return count >= REPEAT_COUNT;
  };
  const onDelta = (chunk, meta) => {
    if (meta?.reasoning) {
      armThink();
      reasoningTail = (reasoningTail + meta.reasoning).slice(-REPEAT_SCAN * 2);
      if (checkRepeat()) {
        send({ type: 'error', message: 'Stopped — the model got stuck repeating the same text.' });
        abort.abort();
        return;
      }
      send({ type: 'thinking', text: meta.reasoning });
    }
    if (meta?.toolFrag) { disarmThink(); spec.onFrag(meta.toolFrag); send({ type: 'tool_delta', ...meta.toolFrag }); }
    if (chunk) { disarmThink(); reasoningTail = ''; send({ type: 'delta', text: chunk }); }
    const now = Date.now();
    if (now - lastTick > 500 && meta?.timings?.predicted_per_second
        && (meta.timings.predicted_n ?? 0) >= 5) {
      lastTick = now;
      send({ type: 'tok_s', value: meta.timings.predicted_per_second, n: meta.timings.predicted_n ?? 0 });
    }
  };
  return { onDelta, disarmThink, clearTimer: disarmThink };
}

// Surface fallback-chain hops as a chat notice. chatPost wires the ledger for
// the first attempt via its own onEvent; these cover the later streamChat
// rounds inside search/image turns.
export function fallbackNotice(send) {
  return (info) => {
    if (info?.type === 'fallback') {
      send({ type: 'notice', message: `${info.from} failed (${info.reason}) — falling back to ${info.to}` });
    }
  };
}

// ---------- cost saver: cached-turn replay ----------
// Stream a saved reply back for free and log the full price as saved.
export function replayCacheHit({ hit, conv, promptLeaf, req, send, insertTitle }) {
  send({ type: 'cache_hit' });
  const savedText = hit.response;
  for (let i = 0; i < savedText.length; i += 240) {
    send({ type: 'delta', text: savedText.slice(i, i + 240) });
  }
  if (hit.thinking) send({ type: 'thinking', text: hit.thinking });
  const asst = insertMessage(conv.id, promptLeaf.id, 'assistant', savedText, {
    thinking: hit.thinking || null, modelId: conv.model_id,
    tokensIn: hit.tokens_in, tokensOut: hit.tokens_out,
  });
  setLeaf(conv.id, asst.id);
  recordEvent({
    userId: req.user.id, convId: conv.id, modelId: conv.model_id,
    kind: 'cache_hit', tokensIn: hit.tokens_in, tokensOut: hit.tokens_out,
    costUsd: 0,
    baselineUsd: costFor(modelRowForRemoteId(conv.model_id), hit.tokens_in, hit.tokens_out, 0),
    cacheHit: true,
  });
  send({ type: 'done', msg: asst });
  insertTitle?.();
  return asst;
}
// A diffusion-LLM turn: resolve the gguf, denoise once, stream every visual
// frame as { type:'diffusion_step' }, then save the final text like any reply.
export async function runDiffusionTurn({ conv, promptLeaf, send, abort, log }) {
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

// A web-search turn (Perplexity-style). The model drives it with web_search /
// fetch_page tool calls; we run them in small batches (up to 30 page reads),
// stream a live "searching the web" trace, collect the pages it actually read
// as citation sources, and let it write the final answer with inline links.
export async function runInlineSearch({
  conv, userId, userLoc, promptMessages, firstResult, params, searchTools, imgPrefs, caps, send, abort, onDelta, log, spec,
}) {
  const MAX_READS = caps?.reads ?? 200;      // hard cap on fetch_page calls
  const MAX_SEARCHES = caps?.searches ?? 40; // and on web_search calls
  const MAX_ROUNDS = caps?.rounds ?? 80;     // safety net on the whole loop (batches of ~3 reads)

  const messages = [...promptMessages];
  const steps = [];          // [{ query, sites:[{title,url,domain,read}] }]
  const sources = [];        // pages actually read → citation list
  const seen = new Set();
  let reads = 0, searches = 0;
  const reasons = [];        // reasoning from every round → full think→search→think chain
  let timings = firstResult.timings, usage = firstResult.usage;
  const mdImgs = [];
  const mdWidgets = [];      // ```duckwidget``` blocks appended to the final message

  const addSite = (title, url, read, snippet) => {
    const step = steps[steps.length - 1];
    if (!step) return;
    let site = step.sites.find((s) => s.url === url);
    if (!site) { site = { title, url, domain: sourceLabel(url), read: false, snippet: snippet || '' }; step.sites.push(site); }
    if (read) site.read = true;
    if (title && (!site.title || site.title === site.url)) site.title = title;
    if (snippet && !site.snippet) site.snippet = snippet;
  };
  const addSource = (title, url) => {
    if (seen.has(url)) return;
    seen.add(url);
    sources.push({ title: title || url, url, domain: sourceLabel(url) });
  };

  send({ type: 'search', phase: 'begin' });

  let res = firstResult;
  let finalText = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (abort.signal.aborted) break;
    const calls = res.toolCalls ?? [];
    if (res.reasoning) reasons.push(res.reasoning);
    if (!calls.length) { finalText = res.content ?? ''; break; }

    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: calls });

    for (const tc of calls) {
      let args = null;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* truncated */ }
      const name = tc.function.name;
      let result;

      if (args === null) {
        result = 'ERROR: tool arguments were not valid JSON (maybe truncated). Retry with complete JSON.';
      } else if (name === 'web_search') {
        if (searches >= MAX_SEARCHES) {
          result = 'Search limit reached — answer now with what you have, citing the pages you read.';
        } else {
          searches += 1;
          const query = String(args.query ?? '').slice(0, 300);
          steps.push({ query, sites: [] });
          send({ type: 'search', phase: 'query', query });
          try {
            const sp = spec?.take('web_search', query);
            const early = sp ? await sp : null;
            if (early?.ok) log?.info({ query }, 'speculative web_search hit');
            const { results, text } = early?.ok ? early.r : await searchWebStructured(query);
            for (const r of results) { addSite(r.title, r.url, false, r.content); send({ type: 'search', phase: 'site', title: r.title, url: r.url, domain: sourceLabel(r.url), read: false, snippet: r.content }); }
            result = text;
          } catch (err) { result = `ERROR: search failed: ${err.message}`; log?.warn?.({ err }, 'web_search failed'); }
        }
      } else if (name === 'fetch_page') {
        if (reads >= MAX_READS) {
          result = `Page-read limit (${MAX_READS}) reached — stop reading and answer now, citing the pages you read.`;
        } else {
          reads += 1;
          const url = String(args.url ?? '');
          send({ type: 'search', phase: 'reading', url, domain: sourceLabel(url) });
          try {
            const sp = spec?.take('fetch_page', url);
            const early = sp ? await sp : null;
            if (early?.ok) log?.info({ url }, 'speculative fetch_page hit');
            const { title, text } = early?.ok ? early.r : await fetchPageStructured(url);
            addSite(title, url, true);
            addSource(title, url);
            send({ type: 'search', phase: 'site', title, url, domain: sourceLabel(url), read: true });
            result = title ? `# ${title}\n${text}` : text;
          } catch (err) { result = `ERROR: couldn't read page: ${err.message}`; }
        }
      } else if (name === 'generate_image') {
        if (!imgPrefs.allowed || !args?.prompt?.trim()) {
          result = 'ERROR: image generation is not available or needs a prompt.';
        } else {
          const blocked = checkUserContent(userId, args.prompt, 'image');
          if (!blocked.ok) {
            result = `ERROR: ${blocked.reason} Tell the user briefly; do not retry the same prompt.`;
          } else {
          send({ type: 'image_job', prompt: args.prompt });
          try {
            const r = await generateViaBridge({
              userId, prompt: args.prompt, size: args.size ?? '1024x1024',
              steps: stepsForQuality(imgPrefs.quality),
              onProgress: (ev) => send(ev.type === 'preview'
                ? { type: 'image_preview', b64: ev.b64, image: ev.image, n: ev.n }
                : { type: 'image_progress', phase: ev.phase, step: ev.step, steps: ev.steps, image: ev.image, n: ev.n }),
            });
            const caption = r.model_used ? `\n*generated by ${r.model_used}*` : '';
            mdImgs.push(r.images.map((im) => `![generated image](${im.url})${caption}`).join('\n\n'));
            send({ type: 'image_done' });
            result = 'Image generated and shown to the user. Mention it briefly; do not repeat the prompt.';
          } catch (err) { send({ type: 'image_done' }); result = `ERROR: image generation failed: ${err.message}`; }
          }
        }
      } else if (WIDGET_BUILDERS[name]) {
        try {
          const wg = await WIDGET_BUILDERS[name](args, { userLoc, userId });
          send({ type: 'widget', widget: wg });
          mdWidgets.push('```duckwidget\n' + JSON.stringify(wg) + '\n```');
          const where = wg.data.place || wg.data.label || wg.data.title || wg.data.name || wg.data.query || 'it';
          result = `The ${wg.type} card for ${where} is now shown to the user, right below your reply. Add ONE short sentence about it in plain text — no links, ids, coordinates, and critically no markdown image syntax like ![...](...); the card is not a photo you need to embed, it is already rendered.`;
        } catch (err) { result = `ERROR: ${err.message}. Tell the user briefly.`; }
      } else if (MEMORY_TOOL_NAMES.has(name)) {
        try { result = await execMemoryTool(name, args, { userId, convId: conv.id }); }
        catch (err) { result = `ERROR: memory unavailable right now (${err.message})`; }
      } else {
        result = `Tool "${name}" is not available here. Use web_search, fetch_page, show_weather, show_map, or just answer.`;
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }

    // Next round streams a fresh answer/tool-batch. Wipe the live text buffer so
    // only the current round shows; stop offering tools once the read cap is hit
    // so the model is forced to finalize.
    send({ type: 'reset_text' });
    spec?.newRound();
    const capped = reads >= MAX_READS || round === MAX_ROUNDS - 1;
    res = await streamChat({
      model: conv.model_id, messages,
      params: capped ? params : { ...params, tools: searchTools, tool_choice: 'auto' },
      abortSignal: abort.signal, onDelta, onEvent: fallbackNotice(send),
    });
    if (capped) { finalText = res.content ?? ''; if (res.reasoning) reasons.push(res.reasoning); break; }
  }

  timings = res.timings ?? timings;
  usage = res.usage ?? usage;
  const text = [stripFakeImages(finalText), mdImgs.join('\n\n'), mdWidgets.join('\n\n')].filter(Boolean).join('\n\n');
  send({ type: 'search', phase: 'done' });
  return { text, reasoning: reasons.join('\n\n'), timings, usage, search: { steps, sources } };
}

// ---------- follow-up prompt chips (after a reply lands) ----------

/** Ask the warm model for 3 short clickable next-messages. Non-fatal helper. */
export async function generateFollowups({ model, userText, replyText, abortSignal }) {
  const { content } = await streamChat({
    model,
    messages: [{
      role: 'user',
      content:
        'You write short follow-up prompts the USER might click to continue this chat.\n'
        + 'Output EXACTLY 3 lines. Nothing else — no numbers, no bullets, no quotes, no intro.\n'
        + 'Each line is one complete message the user would send next (question or request).\n'
        + 'Rules: under 70 characters each; specific to THIS exchange (not generic filler like '
        + '"tell me more"); useful and distinct from each other; same language as the user.\n\n'
        + `---\nUser: ${String(userText).slice(0, 900)}\n\nAssistant: ${String(replyText).slice(0, 1400)}\n---`,
    }],
    params: {
      max_tokens: 220,
      temperature: 0.55,
      chat_template_kwargs: { enable_thinking: false },
    },
    abortSignal,
  });
  return parseFollowupLines(content);
}

function parseFollowupLines(raw) {
  if (!raw) return [];
  // drop thinking-style fences / leading labels if a model ignores instructions
  let text = String(raw)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?think>/gi, ' ');
  const lines = text.split('\n')
    .map((l) => l.trim())
    .map((l) => l
      .replace(/^[-*•]+\s+/, '')
      .replace(/^\d+[\).:\-]\s*/, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim())
    .filter((l) => l.length >= 8 && l.length <= 120)
    .filter((l) => !/^(here|follow|suggestion|option|prompt)/i.test(l))
    .filter((l) => !/^(none|n\/a)$/i.test(l));
  // de-dupe case-insensitively, keep order
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= 3) break;
  }
  return out;
}

// ---------- auto-compaction (cost saver) ----------
// In-memory twin of the manual /compact endpoint: when a remote prompt would
// blow past the model's context budget, summarize everything but the last few
// turns with the cheap aux model and splice the summary into the leading
// system message. The DB tree is untouched (the manual feature still exists
// for permanent compaction); this just keeps the turn alive AND cheaper.
export async function autoCompactMessages(messages, auxModel, abortSignal, log) {
  const KEEP = 8;
  const sys = messages[0]?.role === 'system' ? messages[0] : null;
  const rest = sys ? messages.slice(1) : [...messages];
  const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  const middle = rest.slice(0, Math.max(0, rest.length - KEEP))
    .filter((m) => m.role === 'user' || m.role === 'assistant');
  if (middle.length < 4) return null;
  const transcript = middle.map((m) => `${m.role.toUpperCase()}: ${textOf(m)}`).join('\n\n').slice(0, 60_000);
  try {
    const { content: summary, usage } = await streamChat({
      model: auxModel,
      messages: [{
        role: 'user',
        content: 'Compress this chat history into a context brief for a language model. '
          + 'Keep: user goals, decisions made, key facts (names, numbers, file paths, code identifiers), '
          + 'and unresolved tasks. Terse bullet points under the headings Goals / Decisions / Facts / Open items. '
          + `No preamble, no commentary.\n\n---\n${transcript}\n---`,
      }],
      params: { max_tokens: 900, temperature: 0.2 },
      abortSignal,
    });
    if (!summary?.trim()) return null;
    const kept = rest.slice(Math.max(0, rest.length - KEEP));
    const sysContent = (sys?.content ?? '') + `\n\n[Auto-compacted summary of ${middle.length} earlier messages]\n${summary.trim()}`;
    return { messages: [{ role: 'system', content: sysContent }, ...kept], usage, compacted: middle.length };
  } catch (err) {
    log?.warn({ err }, 'auto-compaction failed (sending full prompt instead)');
    return null;
  }
}


// The agent branch of a chat turn: the model reached for file/shell tools, so
// this turn becomes an agent run (local models only — the caller gates remote
// models out). Returns { text, reasoning, timings, usage, runId }.
export async function runAgentTurn({
  conv, req, res, promptMessages, promptLeaf, wsRow, imgPrefs, disabledTools,
  params, userLoc, send, abort, log,
}) {
  let { reasoning, timings, usage } = res;
// the model reached for tools → this turn becomes an agent run
// (local models only — remote/paid models never drive the sandbox)
let loopMessages = promptMessages;
let firstResult = res;
let runId = null;
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
  } else if (e.type === 'image_job' || e.type === 'image_progress'
      || e.type === 'image_preview' || e.type === 'image_done') {
    // live image progress from an agent-run generate_image → the same
    // top-level events (and imgjob UI) a plain chat image turn uses
    send({ type: e.type, prompt: e.prompt, phase: e.phase, step: e.step, steps: e.steps, b64: e.b64 });
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
  loopMessages = withToolsPolicy(buildPrompt(conv, promptLeaf.id), wsRow, imgPrefs.allowed, userLoc, disabledTools);
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
    tools: filterTools(imgPrefs.allowed ? AGENT_TOOLS : AGENT_TOOLS.filter((t) => t.function.name !== 'generate_image'), disabledTools),
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
  return {
    text: result.content,
    reasoning: result.reasoning ?? reasoning,
    timings: result.timings ?? timings,
    usage: result.usage ?? usage,
    runId: run.id,
  };
}
if (result.status === 'aborted') {
  finishRun(run.id, 'stopped');
  return { text: 'Stopped — everything done so far is saved in the workspace.', reasoning, timings, usage, runId: run.id };
}
if (result.status === 'steplimit') {
  finishRun(run.id, 'error');
  return { text: 'I hit the step limit for this run — everything done so far is saved in the workspace.', reasoning, timings, usage, runId: run.id };
}
finishRun(run.id, 'error');
return {
  text: `The run hit an error (${result.message ?? 'unknown'}) — everything done so far is saved in the workspace.`,
  reasoning, timings, usage, runId: run.id,
};
      
}

// A pure image-generation turn: run the bridge with live previews streaming
// into the chat, then let the model add a short comment. Returns
// { text, reasoning, timings, usage }.
export async function runImageTurn({
  conv, req, res, promptMessages, imgPrefs, params, send, abort, onDelta, log,
}) {
  let { reasoning, timings, usage } = res;
  let text = '';
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
    const blocked = checkUserContent(req.user.id, args.prompt, 'image');
    if (!blocked.ok) {
      toolResult = `ERROR: ${blocked.reason} Tell the user briefly; do not retry the same prompt.`;
    } else {
    send({ type: 'image_job', prompt: args.prompt });
    try {
      const r = await generateViaBridge({
        userId: req.user.id, prompt: args.prompt, size: args.size ?? '1024x1024',
        steps: stepsForQuality(imgPrefs.quality),
        onProgress: (ev) => send(ev.type === 'preview'
          ? { type: 'image_preview', b64: ev.b64, image: ev.image, n: ev.n }
          : { type: 'image_progress', phase: ev.phase, step: ev.step, steps: ev.steps, image: ev.image, n: ev.n }),
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
  }
  followup.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
}
// brief commentary pass — no tools, so it can't chain another job
let fin = { content: '' };
try {
  fin = await streamChat({
    model: conv.model_id, messages: followup, params,
    abortSignal: abort.signal, onDelta, onEvent: fallbackNotice(send),
  });
} catch (err) {
  if (!mdImgs.length) throw err;
  req.log.warn({ err }, 'image follow-up commentary failed; keeping the image');
}
text = [stripFakeImages(res.content), mdImgs.join('\n\n'), stripFakeImages(fin.content)]
  .filter(Boolean).join('\n\n');
reasoning = fin.reasoning ?? reasoning;
timings = fin.timings ?? timings;
usage = fin.usage ?? usage;
  return { text, reasoning, timings, usage };
}
