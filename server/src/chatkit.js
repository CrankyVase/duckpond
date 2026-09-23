// Shared chat helpers: conversation-tree walking, prompt building, message
// inserts, interrupted-reply persistence, usage/cost recording, and every tool
// definition + widget builder. Split out of routes/chat.js with chatpolicy.js,
// chatflow.js and routes/chatPost.js.
import { db } from './db.js';
import { makeChartWidget, makeFileWidget, makeMermaidWidget, makeTableWidget } from './widgets.js';
import { buildCsv, buildPptx } from './exports.js';
import { modelSettings } from './routes/models.js';
import {
  deleteMemory, indexMessage, saveMemoryDirect, updateMemory,
} from './memory.js';
import { corePrompt } from './settings.js';
import { broadcast, hasActiveJob } from './liveJobs.js';
// remote providers + cost saver (feat/remote-providers)
import { isRemoteId } from './chatBackend.js';
import { modelRowForRemoteId, priceRemoteTurn, recordEvent } from './costs.js';

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
// slim: true drops the ~2100-token core persona prompt (Dumpling's identity/
// instructions) — a stopgap for backends where prefill time scales badly with
// prompt size (Colibri's disk-streaming engines today). Temporary: remove
// this param and its one caller-side check once that's not true anymore, or
// once a faster model is the default for those backends.
export function buildPrompt(conv, leafId, { slim = false } = {}) {
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
  const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  sysParts.push(`Today's date is ${todayStr}. Trust this over any date you might otherwise assume from training — use the correct current year (not an older one) when searching the web or reasoning about "latest", "current", "recent", or anything time-sensitive.`);
  if (!slim) {
    const core = corePrompt();
    if (core?.trim()) sysParts.push(core);
  }
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

export function convForUser(id, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
  if (conv) conv._settings = { ...modelSettings(conv.model_id ?? ''), ...JSON.parse(conv.settings_json) };
  return conv;
}

export function insertMessage(convId, parentId, role, content, extra = {}) {
  const r = db.prepare(`
    INSERT INTO messages (conv_id, parent_id, role, content, thinking, model_id, tokens_in, tokens_out, tok_per_sec, covers_json, run_id, search_json)
    VALUES (@convId, @parentId, @role, @content, @thinking, @modelId, @tokensIn, @tokensOut, @tokPerSec, @coversJson, @runId, @searchJson)`)
    .run({
      convId, parentId, role, content,
      thinking: extra.thinking ?? null, modelId: extra.modelId ?? null,
      tokensIn: extra.tokensIn ?? null, tokensOut: extra.tokensOut ?? null,
      tokPerSec: extra.tokPerSec ?? null, coversJson: extra.coversJson ?? null,
      runId: extra.runId ?? null,
      searchJson: extra.searchJson ?? null,
    });
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
  indexMessage(msg); // fire-and-forget: semantic-search vector for this message
  return msg;
}

export function setLeaf(convId, leafId) {
  db.prepare('UPDATE conversations SET active_leaf_id = ?, updated_at = unixepoch() WHERE id = ?')
    .run(leafId, convId);
}

/**
 * Crash recovery for the chat tree: when a turn dies before anything is saved
 * (process kill, dropped GPU-queue wait, a stream error with zero output), the
 * user's message stays in the DB but OFF the active path — the conversation
 * silently "forgets" the last prompt. Heal: any conversation whose newest
 * message is an unreplied user message gets it re-attached as the active leaf.
 */
export function healOrphanedPrompts(log) {
  const rows = db.prepare(`
    SELECT m.id, m.conv_id FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE m.id = (SELECT MAX(id) FROM messages WHERE conv_id = m.conv_id)
      AND m.role = 'user'
      AND c.active_leaf_id IS NOT m.id
      AND NOT EXISTS (SELECT 1 FROM messages k WHERE k.parent_id = m.id)`).all();
  let n = 0;
  for (const r of rows) {
    if (hasActiveJob(r.conv_id)) continue; // turn still in flight — wait for it
    setLeaf(r.conv_id, r.id);
    n += 1;
  }
  if (n) log?.info?.({ n }, 'healed orphaned user prompts back onto the active path');
  return n;
}

/** True if the live job has anything worth parking as an assistant bubble. */
function jobHasPartial(job) {
  if (!job) return false;
  const s = job.state || {};
  return !!(s.text || s.thinking || s.error || s.lastWrite || s.liveTool
    || (s.events && s.events.length) || (s.widgets && s.widgets.length)
    || s.image || s.diffusion || s.search);
}

/**
 * When generation dies mid-flight (error, abort, proxy blip after server stop),
 * always park an assistant message in the DB so:
 *  - the user still sees the work
 *  - saying "continue" has the partial + error on the path for the model
 * Skips if `done` already saved a final message.
 */
export function persistInterruptedReply(job, conv, promptLeaf, { aborted = false, log } = {}) {
  if (!job || job.finalMsg || !promptLeaf || !conv) return null;
  const s = job.state || {};
  if (!jobHasPartial(job) && !aborted && !s.error) return null;

  let text = String(s.text || '').trim();
  // Surface in-progress writes so "continue" can see what was mid-flight
  const write = s.lastWrite || (s.liveTool?.content ? s.liveTool : null);
  if (write?.path && write?.content && !text.includes(write.path)) {
    const lang = String(write.path).split('.').pop() || '';
    text += `${text ? '\n\n' : ''}// ${write.path}\n\`\`\`${lang}\n${write.content}\n\`\`\``;
  } else if (write?.path && !text.includes(write.path)) {
    text += `${text ? '\n\n' : ''}(was writing \`${write.path}\` — check Project files)`;
  }
  if (s.events?.length && !text) {
    const tools = s.events.filter((e) => e.type === 'tool_call').map((e) => e.name).filter(Boolean);
    if (tools.length) text = `Work in progress (${[...new Set(tools)].join(', ')}). Check Project files for what was written.`;
  }

  const reason = s.error
    ? String(s.error)
    : aborted
      ? 'Stopped by user.'
      : 'Connection or generation interrupted.';
  if (!text) text = `_(no text yet)_`;
  if (!text.includes(reason) && !text.includes('Interrupted:') && !text.includes('Stopped')) {
    text += `\n\n> Interrupted: ${reason}`;
  }
  if (!/say \*\*continue\*\*|say continue/i.test(text)) {
    text += `\n\n_Say **continue** to pick up from here — project files already written stay put._`;
  }

  try {
    // freeze the trace as "no longer live" — it never got a real 'done' event
    const search = s.search?.steps?.length ? { ...s.search, active: false, reading: null } : null;
    const asst = insertMessage(conv.id, promptLeaf.id, 'assistant', text, {
      thinking: s.thinking || null,
      modelId: conv.model_id,
      runId: s.run?.id ?? null,
      searchJson: search ? JSON.stringify(search) : null,
    });
    setLeaf(conv.id, asst.id);
    job.finalMsg = asst;
    // Fans out to every attached client (primary + reattach tails)
    broadcast(job, { type: 'done', msg: asst });
    return asst;
  } catch (err) {
    log?.error?.({ err }, 'persistInterruptedReply failed');
    return null;
  }
}

export function recordUsage(modelId, usage, timings, { userId = null, convId = null, kind = 'chat' } = {}) {
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
  // cost ledger: price remote calls; provider prompt-cache discounts count as savings
  if (userId != null && isRemoteId(modelId)) {
    try {
      const { cost, cachedDiscount, tin, tout, cached } = priceRemoteTurn(modelRowForRemoteId(modelId), {
        prompt_tokens: usage?.prompt_tokens ?? timings?.prompt_n ?? 0,
        completion_tokens: usage?.completion_tokens ?? timings?.predicted_n ?? 0,
        cached_tokens: usage?.cached_tokens ?? 0,
      });
      recordEvent({
        userId, convId, modelId, kind,
        tokensIn: tin, tokensOut: tout, cachedTokens: cached,
        costUsd: cost, baselineUsd: cost + cachedDiscount,
      });
    } catch { /* ledger is best-effort */ }
  }
}

export const GEN_PARAM_KEYS = ['temperature', 'top_p', 'top_k', 'repeat_penalty'];

// ---------- chat agent mode ----------
// Project mode is entered through ONE explicit tool call: until a conversation
// has a workspace, the model is only offered `start_project`. Calling it
// creates the sandbox, saves the model's plan as PLAN.md, and unlocks the real
// file/command tools for the rest of the run (and all later turns).

export const START_PROJECT_TOOL = { type: 'function', function: {
  name: 'start_project',
  description: 'Enter project mode: creates a persistent sandboxed Linux workspace for this conversation, saves your plan as PLAN.md, and unlocks file and shell tools (list/read/write files, run commands). Call this ONLY when the user wants real, runnable, multi-file work built — never for snippets, examples, or discussion.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'short kebab-case project name, e.g. "snake-game"' },
    plan: { type: 'string', description: 'concise markdown plan: goal, files you will create, implementation steps, how you will verify it' },
  }, required: ['name', 'plan'] },
} };

// Useful visual outputs only. Historical widget blocks still render in the browser.
const SHOW_CHART_TOOL = { type: 'function', function: {
  name: 'show_chart',
  description: 'Render an interactive chart in the chat from data you provide. Use to visualize numbers, comparisons, trends, or proportions. You supply all the data.',
  parameters: { type: 'object', properties: {
    kind: { type: 'string', enum: ['bar', 'line', 'area', 'pie', 'donut', 'scatter'], description: 'chart type' },
    title: { type: 'string', description: 'short chart title' },
    labels: { type: 'array', items: { type: 'string' }, description: 'category / x-axis labels' },
    series: {
      type: 'array',
      description: 'one or more data series; each has a name and numeric values aligned to labels',
      items: { type: 'object', properties: {
        name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } },
      }, required: ['values'] },
    },
  }, required: ['kind', 'labels', 'series'] },
} };

const SHOW_MERMAID_TOOL = { type: 'function', function: {
  name: 'show_diagram',
  description: 'Render a diagram (flowchart, sequence, mind map, gantt, etc.) from Mermaid source. Use for flows, architectures, timelines, or relationships. Provide valid Mermaid code.',
  parameters: { type: 'object', properties: {
    code: { type: 'string', description: 'Mermaid diagram source, e.g. "graph TD; A-->B;"' },
    title: { type: 'string' },
  }, required: ['code'] },
} };

const SHOW_TABLE_TOOL = { type: 'function', function: {
  name: 'show_table',
  description: 'Render a clean, sortable data table in the chat from columns and rows you provide.',
  parameters: { type: 'object', properties: {
    title: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'each row is an array of cell values aligned to columns' },
  }, required: ['columns', 'rows'] },
} };

const GENERATE_SLIDES_TOOL = { type: 'function', function: {
  name: 'generate_slides',
  description: 'Create a real downloadable PowerPoint (.pptx) presentation from an outline you write. Use when the user wants slides, a deck, or a presentation (it also opens in Google Slides via upload). You write ALL the content: a deck title and one entry per slide with a title and bullet points.',
  parameters: { type: 'object', properties: {
    title: { type: 'string', description: 'deck title for the cover slide' },
    subtitle: { type: 'string', description: 'optional cover subtitle, e.g. author or date' },
    slides: {
      type: 'array',
      description: 'the content slides, in order (max 40)',
      items: { type: 'object', properties: {
        title: { type: 'string' },
        bullets: { type: 'array', items: { type: 'string' }, description: 'up to ~8 concise bullet points' },
        notes: { type: 'string', description: 'optional speaker notes' },
      }, required: ['title'] },
    },
  }, required: ['title', 'slides'] },
} };

const EXPORT_CSV_TOOL = { type: 'function', function: {
  name: 'export_csv',
  description: 'Create a downloadable CSV file from tabular data you provide. Use when the user wants data as a file/spreadsheet rather than just shown in chat.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'short file name, e.g. "expenses-2026"' },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'rows of cell values aligned to columns' },
  }, required: ['columns', 'rows'] },
} };

// name → builder(args, ctx). ctx has { userLoc, userId }. Each returns a widget
// object. Exported so the builders can be exercised without booting the server.
export const WIDGET_BUILDERS = {
  generate_slides: async (a, ctx) => {
    const f = await buildPptx(ctx.userId, a);
    return makeFileWidget({ ...f, detail: `${f.slides} slides` });
  },
  export_csv: async (a, ctx) => {
    const f = await buildCsv(ctx.userId, a);
    return makeFileWidget({ ...f, detail: `${f.rows} rows` });
  },
  show_chart: (a) => makeChartWidget(a),
  show_diagram: (a) => makeMermaidWidget(a),
  show_table: (a) => makeTableWidget(a),
};

export const WIDGET_TOOLS = [
  SHOW_CHART_TOOL, SHOW_MERMAID_TOOL, SHOW_TABLE_TOOL,
  GENERATE_SLIDES_TOOL, EXPORT_CSV_TOOL,
];
export const WIDGET_TOOL_NAMES = new Set(WIDGET_TOOLS.map((t) => t.function.name));

// Memory tools: the model's direct line into its own long-term memory, on top
// of the automatic post-exchange extraction. Recalled memories are injected
// with their ids, so update/forget can target them precisely.
export const MEMORY_TOOLS = [
  { type: 'function', function: {
    name: 'save_memory',
    description: 'Save a durable fact about the user to your long-term memory, so you still know it in future conversations. Use when the user tells you something worth keeping (their name, people in their life, preferences, projects) or asks you to remember something. Facts are also extracted automatically after each exchange — reach for this when something clearly matters or the user says "remember this".',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: 'the fact, one short third-person sentence, e.g. "Lewis\'s dog is named Pretzel"' },
      tier: { type: 'string', enum: ['core', 'durable', 'context'], description: 'core = permanent identity (name, family, where they live) — never fades. durable = preferences, tools, interests — fades slowly if never used. context = current project / temporary situation — fades in weeks. Default durable.' },
    }, required: ['text'] },
  } },
  { type: 'function', function: {
    name: 'update_memory',
    description: 'Correct or update one of your existing memories about the user (they are listed with ids in your system prompt when recalled). Use when the user corrects you or a remembered fact is outdated.',
    parameters: { type: 'object', properties: {
      id: { type: 'integer', description: 'the memory id, from the recalled list' },
      text: { type: 'string', description: 'the corrected fact (omit to keep the text)' },
      tier: { type: 'string', enum: ['core', 'durable', 'context'], description: 'new tier (omit to keep)' },
    }, required: ['id'] },
  } },
  { type: 'function', function: {
    name: 'forget_memory',
    description: 'Permanently delete one of your memories about the user, by id. Use when the user asks you to forget something or a memory is plain wrong with no correction.',
    parameters: { type: 'object', properties: {
      id: { type: 'integer', description: 'the memory id, from the recalled list' },
    }, required: ['id'] },
  } },
];
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.function.name));

export async function execMemoryTool(name, args, { userId, convId }) {
  if (name === 'save_memory') {
    const r = await saveMemoryDirect({ userId, text: args.text, tier: args.tier, convId, source: 'tool' });
    if (r.error) return `ERROR: ${r.error}`;
    return r.action === 'reinforced'
      ? `You already had a memory very close to that (id ${r.id}) — it was strengthened instead of duplicated.`
      : `Saved to long-term memory (id ${r.id}). You will recall this in future conversations when it's relevant. No need to announce the mechanics — a brief natural acknowledgement is enough.`;
  }
  if (name === 'update_memory') {
    const r = await updateMemory({ userId, id: Number(args.id), text: args.text, tier: args.tier });
    return r.error ? `ERROR: ${r.error}` : `Memory ${r.id} updated.`;
  }
  if (name === 'forget_memory') {
    return deleteMemory(userId, Number(args.id))
      ? `Memory ${args.id} deleted.` : `ERROR: no memory with id ${args.id}`;
  }
  return `ERROR: unknown memory tool ${name}`;
}

// Small models sometimes hallucinate a markdown image (![alt](url), often with
// a bogus/empty url) right next to a widget/generated-image tool call — as if
// narrating "here's a photo" on top of the card that's already rendered. Every
// *real* image or widget in a reply is appended by us (mdImgs/mdWidgets), never
// typed by the model, so any ![...](...)  found in the model's own raw text is
// always spurious. Strip it there, before it's combined with the real markdown.
export const stripFakeImages = (s) => (s ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[ \t]+\n/g, '\n').trim();

// per-model-profile tool gating (settings panel "enabled tools" checkboxes)
export const filterTools = (tools, disabled) => (disabled.size ? tools.filter((t) => !disabled.has(t.function.name)) : tools);