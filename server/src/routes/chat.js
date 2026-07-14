import { clientIp, requireAuth } from '../auth.js';
import { db, nowSec } from '../db.js';
import { ipLocation } from '../geoip.js';
import { countInputTokens, listModels, streamChat } from '../llama.js';
import {
  AGENT_TOOLS, FETCH_PAGE_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL,
  agentLoop, bindRunAbort, createRun, createWorkspaceRow,
  emit as emitRunEvent, execTool, finishRun, listTree, releaseRunAbort, subscribeRun,
} from './agent.js';
import { generateViaBridge, getUserImagePrefs, stepsForQuality } from '../imagegen.js';
import { fetchPageStructured, searchWebStructured, sourceLabel } from '../websearch.js';
import {
  makeChartWidget, makeColorPaletteWidget, makeCountdownWidget, makeCryptoWidget, makeCurrencyWidget,
  makeDictionaryWidget, makeFileWidget, makeGithubWidget, makeHackerNewsWidget, makeImagesWidget,
  makeLinkPreviewWidget, makeMapWidget, makeMathPlotWidget, makeMermaidWidget, makeNewsWidget,
  makeNpmWidget, makeQrWidget, makeTableWidget, makeWeatherWidget, makeWikipediaWidget, makeYoutubeWidget,
} from '../widgets.js';
import { buildCsv, buildPptx } from '../exports.js';
import { modelSettings } from './models.js';
import { convDocs, retrieveChunks } from '../docs.js';
import { indexMessage, memoryEnabled, rememberFromExchange, retrieveMemories } from '../memory.js';
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

function convForUser(id, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
  if (conv) conv._settings = { ...modelSettings(conv.model_id ?? ''), ...JSON.parse(conv.settings_json) };
  return conv;
}

function insertMessage(convId, parentId, role, content, extra = {}) {
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

// name → builder(args, ctx). ctx has { userLoc, userId }. Each returns a widget object.
const WIDGET_BUILDERS = {
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

const WIDGET_TOOLS = [
  SHOW_WEATHER_TOOL, SHOW_MAP_TOOL, SHOW_GITHUB_TOOL, SHOW_WIKIPEDIA_TOOL,
  SHOW_YOUTUBE_TOOL, SHOW_IMAGES_TOOL, SHOW_CHART_TOOL, SHOW_CRYPTO_TOOL,
  SHOW_DICTIONARY_TOOL, SHOW_LINK_TOOL, SHOW_MERMAID_TOOL,
  SHOW_CURRENCY_TOOL, SHOW_NPM_TOOL, SHOW_HN_TOOL, SHOW_TABLE_TOOL,
  SHOW_NEWS_TOOL, SHOW_COUNTDOWN_TOOL, SHOW_PALETTE_TOOL, SHOW_QR_TOOL, SHOW_MATHPLOT_TOOL,
  GENERATE_SLIDES_TOOL, EXPORT_CSV_TOOL,
];
const WIDGET_TOOL_NAMES = new Set(WIDGET_TOOLS.map((t) => t.function.name));

// Small models sometimes hallucinate a markdown image (![alt](url), often with
// a bogus/empty url) right next to a widget/generated-image tool call — as if
// narrating "here's a photo" on top of the card that's already rendered. Every
// *real* image or widget in a reply is appended by us (mdImgs/mdWidgets), never
// typed by the model, so any ![...](...)  found in the model's own raw text is
// always spurious. Strip it there, before it's combined with the real markdown.
const stripFakeImages = (s) => (s ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[ \t]+\n/g, '\n').trim();

// per-model-profile tool gating (settings panel "enabled tools" checkboxes)
const filterTools = (tools, disabled) => (disabled.size ? tools.filter((t) => !disabled.has(t.function.name)) : tools);

// ---------- speculative tool calling ----------
// Tool-call JSON streams token by token, and for the latency-bound tools the
// interesting argument (the query / the url) is complete long before the JSON
// closes and the round finishes. Start the network work the moment the
// argument string closes; when the tool actually executes, take the in-flight
// result instead of starting over. Wrong guesses just get dropped — the
// speculative fetch was going to a search engine / public page either way.
// Biggest wins: multi-call rounds (call 2's page loads while call 1 still
// streams) and slow models (seconds of JSON tail + finalization to overlap).
const SPEC_ARG = {
  web_search: /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/,
  fetch_page: /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/,
};
const SPEC_MAX_INFLIGHT = 6;

function makeSpeculator(log) {
  const buf = new Map();    // stream index → { name, args, fired }
  const cache = new Map();  // "name\0arg" → promise of the tool result
  return {
    // wire into onDelta: watch fragments accumulate, fire when the arg closes
    onFrag(frag) {
      let b = buf.get(frag.index);
      if (!b) { b = { name: '', args: '', fired: false }; buf.set(frag.index, b); }
      if (frag.name) b.name = frag.name;
      b.args += frag.args ?? '';
      const re = SPEC_ARG[b.name];
      if (!re || b.fired || cache.size >= SPEC_MAX_INFLIGHT) return;
      const m = b.args.match(re);
      if (!m) return;
      let val;
      try { val = JSON.parse(`"${m[1]}"`); } catch { return; } // arg still mid-escape
      b.fired = true;
      const key = `${b.name}\0${val}`;
      if (cache.has(key)) return;
      log?.info({ tool: b.name, arg: val.slice(0, 120) }, 'speculative tool start');
      cache.set(key, (b.name === 'web_search'
        ? searchWebStructured(val.slice(0, 300))
        : fetchPageStructured(val)
      ).then((r) => ({ ok: true, r }), (err) => ({ ok: false, err })));
    },
    // stream indexes restart at 0 every round — reset the buffers, keep the cache
    newRound() { buf.clear(); },
    // executor side: claim the in-flight result for this exact call, if any
    take(name, val) {
      const p = cache.get(`${name}\0${val}`);
      if (p) cache.delete(`${name}\0${val}`);
      return p ?? null;
    },
  };
}

// [tool name, one-line description] — data-driven so a disabled tool both
// drops out of the offered `tools` array AND stops being described here.
const WIDGET_LINES = [
  ['show_weather', "live weather card for a place (or the user's location)."],
  ['show_map', '3D map with a pin for a place, address, or business.'],
  ['show_github_repo', 'a GitHub repo card (stars, language, description).'],
  ['show_wikipedia', 'a Wikipedia summary card (title, extract, image).'],
  ['show_youtube', 'embed a playable YouTube video.'],
  ['show_images', 'a grid of real photos for a query.'],
  ['show_chart', 'an interactive chart (bar/line/area/pie/donut/scatter) from data you provide.'],
  ['show_crypto', 'a coin price card with a 7-day sparkline.'],
  ['show_dictionary', "a word's pronunciation, definitions, and examples."],
  ['show_link_preview', 'a rich preview card for any web page URL.'],
  ['show_diagram', 'render a Mermaid diagram (flowchart, sequence, mind map, etc.).'],
  ['show_currency', 'convert between two currencies at the latest rate.'],
  ['show_npm', 'an npm package card (version, downloads, description).'],
  ['show_hackernews', 'the top Hacker News story for a topic.'],
  ['show_table', 'a clean data table from columns and rows you provide.'],
  ['show_news', 'recent news headlines for a topic.'],
  ['show_countdown', 'a live countdown to a date/time.'],
  ['show_color_palette', 'copyable hex color swatches.'],
  ['show_qr', 'a scannable QR code for a URL or text.'],
  ['show_math_plot', 'graph a function y = f(x) over a range.'],
  ['generate_slides', 'build a real downloadable PowerPoint deck from an outline you write.'],
  ['export_csv', 'save tabular data as a downloadable CSV file.'],
];

const EMPTY_DISABLED = new Set();

function widgetPolicyFor(disabled) {
  const lines = WIDGET_LINES.filter(([name]) => !disabled.has(name)).map(([name, desc]) => `- ${name} — ${desc}`);
  if (!lines.length) return null;
  return `## Widgets\nYou can drop interactive cards right into the chat:\n${lines.join('\n')}\nBe proactive with these — don't wait to be asked for "the widget". The moment you're about to state a fact one of these covers, call the tool instead of just typing the number: a temperature or forecast → show_weather; a coin price → show_crypto; an exchange rate → show_currency; a package version/downloads → show_npm; a repo's stars/language → show_github_repo; a word's definition → show_dictionary; a place, address, or business → show_map; a date you're counting down to → show_countdown; a set of hex colors → show_color_palette; a small table of numbers or comparisons → show_table; a y=f(x) relationship → show_math_plot. Recommending a restaurant, landmark, or repo also earns its card the same way. The card renders for the user automatically, so don't paste a link, id, or coordinates in your text — just call the tool, then add one short sentence around it. You may use more than one in a reply, and it's fine to lead with the tool call before you've written anything.`;
}

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
You can search the web with web_search and read pages with fetch_page. Use them for current events, prices, versions, library docs, or any fact you are not confident about — never guess when you can check.
Use today's actual date (given above) when it matters: for anything about "latest", "current", "this year", recent releases, or news, search with the real current year — do not default to a year from your training data, and do not assume something is out of date just because it's after your training cutoff.
Work in small batches: run a search, then read up to about 3 of the most promising results with fetch_page. If that is not enough, refine your query and read another batch. Most questions need only a handful of pages — stop as soon as you are confident. You may read many more if a question truly demands deep research (a hard limit of 200 pages), but reaching for a lot of pages should be rare, not the default.
Cite as you write: right after any sentence or bullet that rests on something you read, add a markdown link to the exact page it came from, like [OpenAI pricing](https://example.com/pricing). Use the real page URL, never a bare URL on its own line, and never invent a link. If two pages back the same point, add both links next to each other. These links render as small source tags, so keep the link text to a couple of words. Skip searching for things you already know well.`;

// Search depth tiers. Caps flow into the inline-search loop; ultra also raises
// the thinking budget, turns up reasoning, and injects a deep-research directive.
const RESEARCH_MODES = {
  quick: { reads: 8, searches: 6, rounds: 12, thinkMs: 60 * 60_000, ultra: false },
  normal: { reads: 200, searches: 40, rounds: 80, thinkMs: 60 * 60_000, ultra: false },
  ultra: { reads: 400, searches: 80, rounds: 160, thinkMs: 60 * 60_000, ultra: true },
};
const ULTRA_DIRECTIVE = `## Deep research mode (active)
The user wants the most thorough, concrete answer you can produce. Do real research:
1. Break the question into sub-questions.
2. Search each, and read widely — open many sources with fetch_page, not just snippets.
3. Cross-check facts across independent sources; prefer primary/authoritative ones; note disagreements.
4. Keep going until you can answer with specifics and confidence (you may read up to 400 pages).
5. Then synthesize a well-structured, richly cited answer — cite the pages you used inline.
Do not stop early or hand-wave; be exhaustive, then conclude clearly.`;

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

function withToolsPolicy(promptMessages, wsRow, imageAllowed = true, userLoc = null, disabled = EMPTY_DISABLED) {
  const locPolicy = userLoc
    ? `## User location\nAn approximate location is available for the user (lat ${userLoc.lat}, lon ${userLoc.lon}, near ${userLoc.label ?? 'their area'}). You may omit place/query in show_weather or show_map to use it — do not ask them where they are.`
    : `## User location\nNo location is available for the user right now. Never omit place/query in show_weather or show_map expecting it to fall back to "where they are" — it will fail. Ask what place they mean.`;
  const showGate = !wsRow && !disabled.has('start_project');
  const showImage = imageAllowed && !disabled.has('generate_image');
  const showSearch = !disabled.has('web_search');
  const parts = [
    wsRow ? ACTIVE_POLICY : (showGate ? GATE_POLICY : null),
    showImage ? IMAGE_POLICY : null,
    showSearch ? SEARCH_POLICY : null,
    widgetPolicyFor(disabled),
    locPolicy,
  ].filter(Boolean);
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

// A web-search turn (Perplexity-style). The model drives it with web_search /
// fetch_page tool calls; we run them in small batches (up to 30 page reads),
// stream a live "searching the web" trace, collect the pages it actually read
// as citation sources, and let it write the final answer with inline links.
async function runInlineSearch({
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

  const addSite = (title, url, read) => {
    const step = steps[steps.length - 1];
    if (!step) return;
    let site = step.sites.find((s) => s.url === url);
    if (!site) { site = { title, url, domain: sourceLabel(url), read: false }; step.sites.push(site); }
    if (read) site.read = true;
    if (title && (!site.title || site.title === site.url)) site.title = title;
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
            for (const r of results) { addSite(r.title, r.url, false); send({ type: 'search', phase: 'site', title: r.title, url: r.url, domain: sourceLabel(r.url), read: false }); }
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
          send({ type: 'image_job', prompt: args.prompt });
          try {
            const r = await generateViaBridge({
              userId, prompt: args.prompt, size: args.size ?? '1024x1024',
              steps: stepsForQuality(imgPrefs.quality),
              onProgress: (ev) => send(ev.type === 'preview'
                ? { type: 'image_preview', b64: ev.b64 }
                : { type: 'image_progress', phase: ev.phase, step: ev.step, steps: ev.steps }),
            });
            const caption = r.model_used ? `\n*generated by ${r.model_used}*` : '';
            mdImgs.push(r.images.map((im) => `![generated image](${im.url})${caption}`).join('\n\n'));
            send({ type: 'image_done' });
            result = 'Image generated and shown to the user. Mention it briefly; do not repeat the prompt.';
          } catch (err) { send({ type: 'image_done' }); result = `ERROR: image generation failed: ${err.message}`; }
        }
      } else if (WIDGET_BUILDERS[name]) {
        try {
          const wg = await WIDGET_BUILDERS[name](args, { userLoc, userId });
          send({ type: 'widget', widget: wg });
          mdWidgets.push('```duckwidget\n' + JSON.stringify(wg) + '\n```');
          const where = wg.data.place || wg.data.label || wg.data.title || wg.data.name || wg.data.query || 'it';
          result = `The ${wg.type} card for ${where} is now shown to the user, right below your reply. Add ONE short sentence about it in plain text — no links, ids, coordinates, and critically no markdown image syntax like ![...](...); the card is not a photo you need to embed, it is already rendered.`;
        } catch (err) { result = `ERROR: ${err.message}. Tell the user briefly.`; }
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
      abortSignal: abort.signal, onDelta,
    });
    if (capped) { finalText = res.content ?? ''; if (res.reasoning) reasons.push(res.reasoning); break; }
  }

  timings = res.timings ?? timings;
  usage = res.usage ?? usage;
  const text = [stripFakeImages(finalText), mdImgs.join('\n\n'), mdWidgets.join('\n\n')].filter(Boolean).join('\n\n');
  send({ type: 'search', phase: 'done' });
  return { text, reasoning: reasons.join('\n\n'), timings, usage, search: { steps, sources } };
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
    // coarse location, resolved from the request's own IP (no browser prompt,
    // no client involvement) → lets show_weather/show_map default to where the
    // user is when they name no place
    const userLoc = await ipLocation(clientIp(req));
    // search depth: quick | normal | ultra (deep research)
    const researchMode = RESEARCH_MODES[req.body?.researchMode] ? req.body.researchMode : 'normal';
    const modeCfg = RESEARCH_MODES[researchMode];

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
    let thinkTimer = null;      // thinking-watchdog handle (cleared in finally)
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
      const disabledTools = new Set(conv._settings.disabledTools ?? []);
      const promptMessages = withToolsPolicy(
        buildPrompt(conv, promptLeaf?.id ?? conv.active_leaf_id), wsRow, imgPrefs.allowed, userLoc, disabledTools);
      // deep-research mode: prepend the directive to the leading system message
      if (modeCfg.ultra && promptMessages[0]?.role === 'system') {
        promptMessages[0] = { role: 'system', content: `${promptMessages[0].content}\n\n${ULTRA_DIRECTIVE}` };
      }
      // long-term memory: what the duck remembers about this user, retrieved
      // by meaning against this turn (retrieval also reinforces — see memory.js)
      if (promptLeaf?.content && promptMessages[0]?.role === 'system' && memoryEnabled(req.user.id)) {
        try {
          const mems = await retrieveMemories(req.user.id, promptLeaf.content);
          if (mems.length) {
            req.log.info({ count: mems.length }, 'memories injected');
            const lines = mems.map((m) => `- (${new Date(m.created_at * 1000).toISOString().slice(0, 10)}) ${m.text}`);
            // leads the system prompt: small models pay the most attention to
            // the top, and a memory that gets ignored is worse than none
            const memBlock = '## What you know about this user\n'
              + 'You remember these facts about this user from your previous conversations with them. '
              + 'They are true — when the user asks about themselves or the facts are relevant, use them '
              + 'directly and confidently instead of asking the user to repeat things. This overrides any '
              + 'impulse to say you have no access to personal information: you DO have these remembered '
              + "facts. Don't recite this list unprompted.\n" + lines.join('\n');
            promptMessages[0] = { role: 'system', content: memBlock + '\n\n' + promptMessages[0].content };
          }
        } catch { /* embed service down — the turn proceeds memoryless */ }
      }
      // attached documents (RAG): pull the excerpts relevant to this message
      // and pin them at the END of the system prompt, closest to the question
      if (promptLeaf?.content && promptMessages[0]?.role === 'system') {
        try {
          const attached = convDocs(conv.id);
          if (attached.length) {
            const hits = await retrieveChunks(req.user.id, attached.map((d) => d.id), promptLeaf.content);
            const names = attached.map((d) => d.name).join(', ');
            let block = `## Attached documents\nThe user attached these documents to this conversation: ${names}.`;
            if (hits.length) {
              req.log.info({ hits: hits.length }, 'doc excerpts injected');
              block += '\nRelevant excerpts for this message — answer from them when they apply, cite the '
                + "document by name when you use one, and if they don't contain the answer say so honestly:\n\n"
                + hits.map((h) => `[${h.name} · part ${h.idx + 1}]\n${h.text.slice(0, 900)}`).join('\n\n');
            } else {
              block += '\nNo excerpt matched this message — if the user asks about the documents, say you '
                + "couldn't find it in them rather than guessing.";
            }
            promptMessages[0] = { role: 'system', content: promptMessages[0].content + '\n\n' + block };
          }
        } catch { /* embed service down — the turn proceeds without excerpts */ }
      }
      const params = { max_tokens: -1 };
      for (const k of GEN_PARAM_KEYS) params[k] = conv._settings[k];
      // thinking control: enable_thinking is honored by qwen-style templates,
      // reasoning_effort by gpt-oss-style ones; unsupported kwargs are ignored
      const think = conv._settings.thinking;
      if (think === 'none') params.chat_template_kwargs = { enable_thinking: false };
      else if (modeCfg.ultra) params.reasoning_effort = 'high';
      else if (think === 'high' || think === 'low') params.reasoning_effort = think;

      let lastTick = 0;
      const t0 = Date.now();
      // Thinking watchdog: a model may think for as long as it genuinely keeps
      // working — hard problems (especially coding) can legitimately reason for
      // a long time. This is a true idle/hang timeout, not a cap on total
      // thinking duration: every new reasoning token resets the clock, so it
      // only fires if reasoning goes completely silent (stream stalled/stuck)
      // for the full window. Disarmed the moment real content or a tool
      // fragment appears. Covers the first call and every research round
      // (shared onDelta).
      const THINK_TIMEOUT_MS = Number(process.env.THINK_TIMEOUT_MS ?? modeCfg.thinkMs);
      const disarmThink = () => { if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; } };
      const armThink = () => {
        clearTimeout(thinkTimer);
        thinkTimer = setTimeout(() => {
          thinkTimer = null;
          send({ type: 'error', message: `Stopped — the model went silent mid-thought for over ${Math.round(THINK_TIMEOUT_MS / 60_000)} min without answering or using a tool.` });
          abort.abort();
        }, THINK_TIMEOUT_MS);
      };
      // Loop detector: a model can keep emitting tokens forever without ever
      // going idle, just repeating the same phrase — the idle watchdog above
      // can't see that. Keep a bounded tail of reasoning text and check the
      // most recent chunk-sized window for verbatim repeats; 3+ identical
      // repeats in the recent tail means it's stuck in a loop, not thinking.
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
      const spec = makeSpeculator(req.log);
      const onDelta = (chunk, meta) => {
        if (meta?.reasoning) {
          armThink();
          reasoningTail = (reasoningTail + meta.reasoning).slice(-REPEAT_SCAN * 2);
          if (checkRepeat()) {
            send({ type: 'error', message: 'Stopped — the model got stuck repeating itself instead of thinking.' });
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

      // first call offers the tools (just the start_project gate until the
      // conversation has a workspace); if the template rejects them, retry plain
      let res;
      let toolsOn = true;
      try {
        const baseTools = filterTools(wsRow ? [...AGENT_TOOLS, ...WIDGET_TOOLS]
          : [START_PROJECT_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL, FETCH_PAGE_TOOL, ...WIDGET_TOOLS], disabledTools);
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
      text = stripFakeImages(text);
      let runId = null;
      let searchData = null;

      const callNames = new Set((res.toolCalls ?? []).map((t) => t.function.name));
      const wantsInlineTools = callNames.has('web_search') || callNames.has('fetch_page')
        || [...WIDGET_TOOL_NAMES].some((n) => callNames.has(n));
      if (toolsOn && res.toolCalls?.length && wantsInlineTools && !callNames.has('start_project')) {
        // inline-tools turn: web search (with live trace + citations) and/or
        // interactive widgets, in one batched loop; the model answers at the end.
        const searchTools = filterTools([
          ...(imgPrefs.allowed ? [GENERATE_IMAGE_TOOL] : []),
          WEB_SEARCH_TOOL, FETCH_PAGE_TOOL, ...WIDGET_TOOLS,
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
        text = [stripFakeImages(res.content), mdImgs.join('\n\n'), stripFakeImages(fin.content)]
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
        searchJson: searchData && searchData.steps.length ? JSON.stringify(searchData) : null,
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

      // learn: distill durable facts from this exchange into long-term memory
      // (runs on the still-warm model after the reply is already delivered)
      if (!abort.signal.aborted && text && promptLeaf?.content && memoryEnabled(req.user.id)) {
        try {
          await rememberFromExchange({
            model: conv.model_id, userText: promptLeaf.content, replyText: text,
            userId: req.user.id, convId: conv.id, log: req.log,
          });
        } catch (err) { req.log.warn({ err }, 'memory extraction failed (non-fatal)'); }
      }
    } catch (err) {
      req.log.error({ err }, 'chat generation failed');
      if (!abort.signal.aborted && !reply.raw.writableEnded) {
        send({ type: 'error', message: String(err.message ?? err) });
      }
    } finally {
      if (thinkTimer) clearTimeout(thinkTimer);
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
