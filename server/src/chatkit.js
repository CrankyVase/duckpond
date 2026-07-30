// Shared chat helpers: conversation-tree walking, prompt building, message
// inserts, interrupted-reply persistence, usage/cost recording, and every tool
// definition + widget builder. Split out of routes/chat.js with chatpolicy.js,
// chatflow.js and routes/chatPost.js.
import { db } from './db.js';
import {
  makeChartWidget, makeColorPaletteWidget, makeCountdownWidget, makeCryptoWidget, makeCurrencyWidget,
  makeDashboardWidget, makeDictionaryWidget, makeFileWidget, makeGithubWidget, makeHackerNewsWidget,
  makeImagesWidget, makeLinkPreviewWidget, makeMapWidget, makeMathPlotWidget, makeMermaidWidget,
  makeNewsWidget, makeNpmWidget, makeQrWidget, makeTableWidget, makeWeatherWidget, makeWikipediaWidget,
  makeYoutubeWidget,
} from './widgets.js';
import { modelParamsB } from './modelDescribe.js';
import { buildCsv, buildPptx } from './exports.js';
import { modelSettings } from './routes/models.js';
import {
  deleteMemory, indexMessage, saveMemoryDirect, updateMemory,
} from './memory.js';
import { corePrompt } from './settings.js';
import { broadcast } from './liveJobs.js';
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
  const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  sysParts.push(`Today's date is ${todayStr}. Trust this over any date you might otherwise assume from training — use the correct current year (not an older one) when searching the web or reasoning about "latest", "current", "recent", or anything time-sensitive.`);
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
    const asst = insertMessage(conv.id, promptLeaf.id, 'assistant', text, {
      thinking: s.thinking || null,
      modelId: conv.model_id,
      runId: s.run?.id ?? null,
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

// The second way into project mode: attach a REAL folder from the machine
// DuckPond runs on, so "fix the bug in my app on my desktop" works on the
// actual files. Owner-only and allowlisted — see hostfs.js. Never offered to
// other users, so a model that can see this tool is already cleared to use it.
// It needs no companion "browse" tool: the allowed folders and their contents
// are listed in the system prompt (chatpolicy.js DESKTOP_POLICY), so the model
// always has real paths to work from instead of guesses.
export const OPEN_DESKTOP_TOOL = { type: 'function', function: {
  name: 'open_desktop_project',
  description: "Open one of the user's REAL folders on this machine as the project for this conversation, then work on those actual files with the file and shell tools. Use this when the user refers to something that already exists on their computer (\"my app on the desktop\", \"the project in ~/code/foo\", \"fix my website\"). The folder must be inside an allowed directory; if the call is refused, tell the user what the tool said instead of guessing another path. Prefer list_desktop first when you are not certain of the exact path — do NOT invent one.",
  parameters: { type: 'object', properties: {
    path: { type: 'string', description: 'absolute path to the folder, taken from the list in your system prompt (~ is allowed)' },
    plan: { type: 'string', description: 'optional short plan for what you are about to change. Written to PLAN.md only if the folder has no PLAN.md already — never overwrite the user\'s own file.' },
  }, required: ['path'] },
} };

// Widget tools: each returns a typed object we render as an interactive card in
// the chat and persist as a ```duckwidget``` block. More types come in later phases.
const SHOW_WEATHER_TOOL = { type: 'function', function: {
  name: 'show_weather',
  description: "Show an interactive weather card in the chat for a place. Use when the user asks about weather, temperature, or forecast. Pass the place name; omit it to use the user's own location if it's available.",
  parameters: { type: 'object', properties: {
    place: { type: 'string', description: 'city or place, e.g. "Tokyo" or "Austin, TX". Omit to use the user\'s current location.' },
    units: { type: 'string', enum: ['metric', 'imperial'], description: 'metric (°C) or imperial (°F). Default imperial (°F) — only pass metric when the place is clearly outside the US or the user asks for Celsius.' },
  }, required: [] },
} };

const SHOW_MAP_TOOL = { type: 'function', function: {
  name: 'show_map',
  description: 'Show an interactive map with a pin in the chat. Use when the user wants to see where a place, address, business, or landmark is. Pass a query (name or address).',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'place, address, business, or landmark to locate, e.g. "Blue Bottle Coffee, San Francisco"' },
    label: { type: 'string', description: 'optional short label for the pin' },
  }, required: ['query'] },
} };

const SHOW_GITHUB_TOOL = { type: 'function', function: {
  name: 'show_github_repo',
  description: 'Show a GitHub repository card (stars, language, description) in the chat. Use when discussing or recommending a specific repo.',
  parameters: { type: 'object', properties: {
    repo: { type: 'string', description: 'repository as "owner/name" or a github.com URL' },
  }, required: ['repo'] },
} };

const SHOW_WIKIPEDIA_TOOL = { type: 'function', function: {
  name: 'show_wikipedia',
  description: 'Show a Wikipedia summary card (title, extract, image) in the chat. Use to give a quick factual overview of a person, place, thing, or event.',
  parameters: { type: 'object', properties: {
    title: { type: 'string', description: 'article title or topic, e.g. "Great Barrier Reef"' },
  }, required: ['title'] },
} };

const SHOW_YOUTUBE_TOOL = { type: 'function', function: {
  name: 'show_youtube',
  description: 'Embed a playable YouTube video in the chat. Use when you have a specific relevant video URL or id to show.',
  parameters: { type: 'object', properties: {
    url: { type: 'string', description: 'YouTube link or 11-character video id' },
  }, required: ['url'] },
} };

const SHOW_IMAGES_TOOL = { type: 'function', function: {
  name: 'show_images',
  description: 'Show a small grid of real photos found on the web for a query. Use when the user wants to see what something looks like.',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'what to show photos of, e.g. "red panda"' },
    count: { type: 'integer', description: 'how many images (1-12, default 6)' },
  }, required: ['query'] },
} };

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

const SHOW_CRYPTO_TOOL = { type: 'function', function: {
  name: 'show_crypto',
  description: 'Show a cryptocurrency price card with a 7-day sparkline. Use when asked about a coin\'s price.',
  parameters: { type: 'object', properties: { coin: { type: 'string', description: 'coin name or symbol, e.g. "bitcoin" or "eth"' } }, required: ['coin'] },
} };
const SHOW_DICTIONARY_TOOL = { type: 'function', function: {
  name: 'show_dictionary',
  description: 'Show a dictionary card (pronunciation, definitions, examples) for an English word.',
  parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
} };
const SHOW_LINK_TOOL = { type: 'function', function: {
  name: 'show_link_preview',
  description: 'Show a rich preview card (title, description, image) for any web page URL.',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
} };
const SHOW_MERMAID_TOOL = { type: 'function', function: {
  name: 'show_diagram',
  description: 'Render a diagram (flowchart, sequence, mind map, gantt, etc.) from Mermaid source. Use for flows, architectures, timelines, or relationships. Provide valid Mermaid code.',
  parameters: { type: 'object', properties: {
    code: { type: 'string', description: 'Mermaid diagram source, e.g. "graph TD; A-->B;"' },
    title: { type: 'string' },
  }, required: ['code'] },
} };

const SHOW_CURRENCY_TOOL = { type: 'function', function: {
  name: 'show_currency',
  description: 'Show a currency conversion card between two currencies at the latest rate.',
  parameters: { type: 'object', properties: {
    from: { type: 'string', description: '3-letter code, e.g. USD' },
    to: { type: 'string', description: '3-letter code, e.g. EUR' },
    amount: { type: 'number', description: 'amount to convert (default 1)' },
  }, required: ['from', 'to'] },
} };
const SHOW_NPM_TOOL = { type: 'function', function: {
  name: 'show_npm',
  description: 'Show an npm package card (version, weekly downloads, description).',
  parameters: { type: 'object', properties: { package: { type: 'string' } }, required: ['package'] },
} };
const SHOW_HN_TOOL = { type: 'function', function: {
  name: 'show_hackernews',
  description: 'Show the top Hacker News story for a topic (or the current front-page top if no query).',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: [] },
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

const SHOW_NEWS_TOOL = { type: 'function', function: {
  name: 'show_news',
  description: 'Show a list of recent news headlines for a topic.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' } }, required: ['query'] },
} };
const SHOW_COUNTDOWN_TOOL = { type: 'function', function: {
  name: 'show_countdown',
  description: 'Show a live countdown timer to a future date/time.',
  parameters: { type: 'object', properties: {
    title: { type: 'string' }, date: { type: 'string', description: 'ISO date/time, e.g. 2027-01-01T00:00:00Z' },
  }, required: ['date'] },
} };
const SHOW_PALETTE_TOOL = { type: 'function', function: {
  name: 'show_color_palette',
  description: 'Show a color palette card with copyable hex swatches.',
  parameters: { type: 'object', properties: {
    title: { type: 'string' },
    colors: { type: 'array', items: { type: 'object', properties: { hex: { type: 'string' }, name: { type: 'string' } }, required: ['hex'] } },
  }, required: ['colors'] },
} };
const SHOW_QR_TOOL = { type: 'function', function: {
  name: 'show_qr',
  description: 'Show a scannable QR code for a URL or text.',
  parameters: { type: 'object', properties: { text: { type: 'string' }, label: { type: 'string' } }, required: ['text'] },
} };
const SHOW_MATHPLOT_TOOL = { type: 'function', function: {
  name: 'show_math_plot',
  description: 'Plot a mathematical function y = f(x) over a range. Use for graphing equations.',
  parameters: { type: 'object', properties: {
    expr: { type: 'string', description: 'expression in x, e.g. "sin(x)*x" or "x^2 - 3*x + 2" (functions: sin,cos,tan,sqrt,abs,exp,ln,log; constants: pi,e)' },
    from: { type: 'number' }, to: { type: 'number' },
  }, required: ['expr'] },
} };

// Generative UI (EPIC 3): the model composes several of the widgets above into
// one titled grid instead of scattering separate cards. Only offered to models
// big enough to reliably author the nested tool-call JSON — see
// dashboardCapable() and the gate where disabledTools is built in the route.
const DASHBOARD_PANEL_TOOLS = [
  SHOW_WEATHER_TOOL, SHOW_MAP_TOOL, SHOW_GITHUB_TOOL, SHOW_WIKIPEDIA_TOOL,
  SHOW_YOUTUBE_TOOL, SHOW_IMAGES_TOOL, SHOW_CHART_TOOL, SHOW_CRYPTO_TOOL,
  SHOW_DICTIONARY_TOOL, SHOW_LINK_TOOL, SHOW_MERMAID_TOOL, SHOW_CURRENCY_TOOL,
  SHOW_NPM_TOOL, SHOW_HN_TOOL, SHOW_TABLE_TOOL, SHOW_NEWS_TOOL,
  SHOW_COUNTDOWN_TOOL, SHOW_PALETTE_TOOL, SHOW_QR_TOOL, SHOW_MATHPLOT_TOOL,
];
const DASHBOARD_PANEL_NAMES = new Set(DASHBOARD_PANEL_TOOLS.map((t) => t.function.name));

const SHOW_DASHBOARD_TOOL = { type: 'function', function: {
  name: 'show_dashboard',
  description: 'Compose 2-8 of the other show_* widgets into ONE titled dashboard grid. Use it when the user wants an overview that naturally spans several cards: a trip (weather + map + currency), a project (github repo + npm + chart), a market snapshot (crypto cards + a chart). Each panel names a widget tool and passes exactly the arguments that tool takes. When several cards clearly belong together, prefer one dashboard over separate widget calls.',
  parameters: { type: 'object', properties: {
    title: { type: 'string', description: 'short dashboard title, e.g. "Tokyo trip"' },
    panels: {
      type: 'array',
      description: '2-8 panels in display order',
      items: { type: 'object', properties: {
        tool: { type: 'string', enum: [...DASHBOARD_PANEL_NAMES], description: 'which widget fills this panel' },
        args: { type: 'object', description: 'the arguments you would pass to that widget tool' },
        wide: { type: 'boolean', description: 'span the full dashboard width — good for charts, tables, news' },
      }, required: ['tool', 'args'] },
    },
  }, required: ['title', 'panels'] },
} };

// Models below this many (total) params too often fumble the nested tool-call
// JSON a dashboard needs; unknown sizes count as not capable — the model can
// still show every widget individually. Remote (paid API) models are all
// frontier-grade tool users, so they always qualify.
const DASHBOARD_MIN_TOTAL_B = 9;
export const dashboardCapable = (modelId) => isRemoteId(modelId) || (modelParamsB(modelId).totalB ?? 0) >= DASHBOARD_MIN_TOTAL_B;

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

// A dashboard call fans out into the panel widgets' own builders, in parallel.
// A failed panel becomes an error tile instead of sinking the whole grid; only
// when every panel fails does the tool itself error.
async function dashboardPanels(a, ctx) {
  const raw = Array.isArray(a.panels) ? a.panels.slice(0, 8) : [];
  if (raw.length < 2) throw new Error('a dashboard needs 2-8 panels, each { tool, args }');
  const panels = await Promise.all(raw.map(async (p) => {
    const tool = String(p?.tool ?? '');
    const wide = !!p?.wide;
    if (!DASHBOARD_PANEL_NAMES.has(tool)) return { wide, tool, error: 'not a widget tool that can be used inside a dashboard' };
    try { return { wide, widget: await WIDGET_BUILDERS[tool](p.args ?? {}, ctx) }; }
    catch (err) { return { wide, tool, error: String(err.message ?? err).slice(0, 200) }; }
  }));
  if (!panels.some((p) => p.widget)) {
    throw new Error(`every panel failed: ${panels.map((p) => `${p.tool} (${p.error})`).join('; ')}`.slice(0, 400));
  }
  return panels;
}

// name → builder(args, ctx). ctx has { userLoc, userId }. Each returns a widget
// object. Exported so the builders can be exercised without booting the server.
export const WIDGET_BUILDERS = {
  show_dashboard: async (a, ctx) => makeDashboardWidget({ title: a.title, panels: await dashboardPanels(a, ctx) }),
  generate_slides: async (a, ctx) => {
    const f = await buildPptx(ctx.userId, a);
    return makeFileWidget({ ...f, detail: `${f.slides} slides` });
  },
  export_csv: async (a, ctx) => {
    const f = await buildCsv(ctx.userId, a);
    return makeFileWidget({ ...f, detail: `${f.rows} rows` });
  },
  show_weather: (a, ctx) => makeWeatherWidget({
    place: a.place?.trim() || undefined, lat: ctx.userLoc?.lat, lon: ctx.userLoc?.lon,
    label: a.place?.trim() ? undefined : ctx.userLoc?.label,
    units: a.units === 'metric' ? 'metric' : 'imperial',
  }),
  show_map: (a, ctx) => makeMapWidget({
    query: a.query?.trim() || undefined,
    lat: a.query ? undefined : ctx.userLoc?.lat, lon: a.query ? undefined : ctx.userLoc?.lon,
    label: a.label?.trim() || (a.query ? undefined : ctx.userLoc?.label),
  }),
  show_github_repo: (a) => makeGithubWidget(a.repo),
  show_wikipedia: (a) => makeWikipediaWidget(a.title),
  show_youtube: (a) => makeYoutubeWidget(a.url),
  show_images: (a) => makeImagesWidget(a.query, a.count ?? 6),
  show_chart: (a) => makeChartWidget(a),
  show_crypto: (a) => makeCryptoWidget(a.coin),
  show_dictionary: (a) => makeDictionaryWidget(a.word),
  show_link_preview: (a) => makeLinkPreviewWidget(a.url),
  show_diagram: (a) => makeMermaidWidget(a),
  show_currency: (a) => makeCurrencyWidget(a),
  show_npm: (a) => makeNpmWidget(a.package),
  show_hackernews: (a) => makeHackerNewsWidget(a.query),
  show_table: (a) => makeTableWidget(a),
  show_news: (a) => makeNewsWidget(a.query, a.count ?? 5),
  show_countdown: (a) => makeCountdownWidget(a),
  show_color_palette: (a) => makeColorPaletteWidget(a),
  show_qr: (a) => makeQrWidget(a),
  show_math_plot: (a) => makeMathPlotWidget(a),
};

export const WIDGET_TOOLS = [
  SHOW_WEATHER_TOOL, SHOW_MAP_TOOL, SHOW_GITHUB_TOOL, SHOW_WIKIPEDIA_TOOL,
  SHOW_YOUTUBE_TOOL, SHOW_IMAGES_TOOL, SHOW_CHART_TOOL, SHOW_CRYPTO_TOOL,
  SHOW_DICTIONARY_TOOL, SHOW_LINK_TOOL, SHOW_MERMAID_TOOL,
  SHOW_CURRENCY_TOOL, SHOW_NPM_TOOL, SHOW_HN_TOOL, SHOW_TABLE_TOOL,
  SHOW_NEWS_TOOL, SHOW_COUNTDOWN_TOOL, SHOW_PALETTE_TOOL, SHOW_QR_TOOL, SHOW_MATHPLOT_TOOL,
  SHOW_DASHBOARD_TOOL, GENERATE_SLIDES_TOOL, EXPORT_CSV_TOOL,
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