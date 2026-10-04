// Turn policies + speculative tool calling: the system-prompt blocks that
// describe tools to the model, and the stream watcher that pre-fires search /
// fetch calls as soon as their argument finishes streaming.
import { listTree } from './routes/agent.js';
import { fetchPageStructured, searchWebStructured } from './websearch.js';
import { createReadAhead } from './normalChatHarness.js';

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
const SPEC_MAX_STARTED = 48;

export function makeSpeculator(log, signal, available = null) {
  const buf = new Map();    // stream index → { name, args, fired }
  let queue = createReadAhead({ concurrency: 3, maxEntries: 12, signal });
  const started = new Set();
  return {
    // wire into onDelta: watch fragments accumulate, fire when the arg closes
    onFrag(frag) {
      if (signal?.aborted) return;
      let b = buf.get(frag.index);
      if (!b) { b = { name: '', args: '', fired: false }; buf.set(frag.index, b); }
      if (frag.name) b.name = frag.name;
      b.args += frag.args ?? '';
      if ((available && !available.has(b.name)) || b.args.length > 16000) { b.fired = true; return; }
      const re = SPEC_ARG[b.name];
      if (!re || b.fired || started.size >= SPEC_MAX_STARTED) return;
      const m = b.args.match(re);
      if (!m) return;
      let val;
      try { val = JSON.parse(`"${m[1]}"`); } catch { return; } // arg still mid-escape
      val = val.trim();
      if (!val || (b.name === 'fetch_page' && !/^https?:\/\//i.test(val))) return;
      if (b.name === 'web_search') val = val.slice(0, 300).replace(/\s+/g, ' ');
      else val = val.split('#')[0];
      b.fired = true;
      const key = `${b.name}\0${val}`;
      if (started.has(key)) return;
      const name = b.name;
      const pending = queue.start(key, workSignal => name === 'web_search'
        ? searchWebStructured(val, { signal: workSignal })
        : fetchPageStructured(val, { signal: workSignal }));
      if (pending) {
        started.add(key);
        log?.info({ tool: name, arg: val.slice(0, 120) }, 'speculative tool queued');
      }
    },
    // Finished rounds have claimed their actual tools. Cancel unused guesses
    // instead of letting them compete with the next inference or tool batch.
    newRound() { buf.clear(); queue.dispose(); queue = createReadAhead({ concurrency: 3, maxEntries: 12, signal }); },
    // executor side: claim the in-flight result for this exact call, if any
    take(name, val) {
      return queue.take(`${name}\0${val}`);
    },
    dispose() { buf.clear(); queue.dispose(); },
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
  ['show_dashboard', 'compose 2-8 of the widgets above into ONE titled grid — prefer it over separate calls when the cards belong together (a trip: weather + map + currency; a project: repo + npm + chart).'],
  ['generate_slides', 'build a real downloadable PowerPoint deck from an outline you write.'],
  ['export_csv', 'save tabular data as a downloadable CSV file.'],
];

const EMPTY_DISABLED = new Set();

export function selectTurnWidgets(message = '') {
  const text = String(message).toLowerCase();
  const asksForVisual = /\b(show|make|create|draw|plot|embed|display|build|give me|export|want|need)\b/.test(text);
  if (!asksForVisual) return new Set();
  const intents = [
    [/\b(weather card|forecast card)\b/, 'show_weather'],
    [/\b(map|directions map)\b/, 'show_map'],
    [/\b(chart|graph)\b/, 'show_chart'],
    [/\b(table)\b/, 'show_table'],
    [/\b(diagram|flowchart|mind map|sequence diagram)\b/, 'show_diagram'],
    [/\b(dashboard)\b/, 'show_dashboard'],
    [/\b(slides|powerpoint|presentation deck)\b/, 'generate_slides'],
    [/\b(csv|spreadsheet file)\b/, 'export_csv'],
    [/\b(qr code)\b/, 'show_qr'],
    [/\b(color palette|colour palette|swatches)\b/, 'show_color_palette'],
    [/\b(countdown)\b/, 'show_countdown'],
    [/\b(youtube video|video embed)\b/, 'show_youtube'],
    [/\b(photo grid|image grid)\b/, 'show_images'],
  ];
  return new Set(intents.filter(([re]) => re.test(text)).map(([, name]) => name));
}

function widgetPolicyFor(available) {
  const lines = WIDGET_LINES.filter(([name]) => available.has(name)).map(([name, desc]) => `- ${name} — ${desc}`);
  if (!lines.length) return null;
  return `## Requested visual output\nThe user asked for a visual or downloadable result. Available tools:\n${lines.join('\n')}\nUse the relevant tool when it helps fulfill this request. Explain the result briefly; the card or file renders automatically.`;
}

const GATE_POLICY = `## Project work
Answer in chat for questions, examples, snippets, and single-file fixes. Call start_project when the user wants a runnable or persistent multi-file app, site, game, or repository. Start with a short plan, then build and verify it in the workspace. Do not turn a small answer into a project.`;

const ACTIVE_POLICY = `## Active project
The workspace is at /workspace. Use project tools to finish requested work; answer pure questions in chat. Respect the user's scope and execution constraints throughout the run.
Inspect AGENTS.md (including nested instructions), project manifests, and relevant source before editing. Search for existing implementations and reuse the project's framework and conventions. Preserve unrelated changes.
For work with several steps, use update_plan if available to keep a short task list with one step in progress; update it as work finishes or the approach changes. Keep existing PLAN.md task checkboxes accurate. Simple edits do not need a plan.
Put working code in files. Prefer exact edit_file changes for existing source; write_file should contain complete new files. After a failed edit, read the latest source and repair the search block. After a failed command, inspect the actual error and change the approach; do not repeat an unchanged failing call.
Verify with relevant checks when execution is permitted. Read the manifest to choose existing scripts. Inspect browser output when visual behavior matters and browser use is permitted. Managed dev servers use start_server and server_status. If the user requests edits only or forbids running code, do static review and explicitly say checks were not run.
Finish with the concrete changes, what you actually verified, and any unfinished work. Never imply a successful build, test, or browser check without its tool result.`;

const SEARCH_POLICY = `## Web search
You can search the web with web_search and read pages with fetch_page. Use them for current events, prices, versions, library docs, or any fact you are not confident about — never guess when you can check.
Use today's actual date (given above) when it matters: for anything about "latest", "current", "this year", recent releases, or news, search with the real current year — do not default to a year from your training data, and do not assume something is out of date just because it's after your training cutoff.
Work in small batches: run a search, then read up to about 3 promising results with fetch_page. Refine the query only when the evidence is insufficient. Stop when you can answer confidently; normal mode allows at most 18 page reads and deep research allows more.
Cite as you write: right after any sentence or bullet that rests on something you read, add a markdown link to the exact page it came from, like [OpenAI pricing](https://example.com/pricing). Use the real page URL, never a bare URL on its own line, and never invent a link. If two pages back the same point, add both links next to each other. These links render as small source tags, so keep the link text to a couple of words. Skip searching for things you already know well.`;

// Search depth tiers. Caps flow into the inline-search loop; ultra also raises
// the thinking budget, turns up reasoning, and injects a deep-research directive.
export const RESEARCH_MODES = {
  quick: { reads: 6, searches: 3, rounds: 8, thinkMs: 60 * 60_000, ultra: false },
  normal: { reads: 18, searches: 8, rounds: 22, thinkMs: 60 * 60_000, ultra: false },
  ultra: { reads: 80, searches: 30, rounds: 90, thinkMs: 60 * 60_000, ultra: true },
};
export const ULTRA_DIRECTIVE = `## Deep research mode (active)
The user wants the most thorough, concrete answer you can produce. Do real research:
1. Break the question into sub-questions.
2. Search each, and read widely — open many sources with fetch_page, not just snippets.
3. Cross-check facts across independent sources; prefer primary/authoritative ones; note disagreements.
4. Keep going until you can answer with specifics and confidence (you may read up to 80 pages).
5. Then synthesize a well-structured, richly cited answer — cite the pages you used inline.
Do not stop early or hand-wave; be exhaustive, then conclude clearly.`;

const IMAGE_POLICY = `## Image generation
You can create real images with the generate_image tool (local diffusion model). Use it when the user asks for a picture, artwork, photo, logo, or wallpaper. Write the complete visual prompt yourself — subject, setting, style, lighting, composition — don't ask the user to write it. Generation takes a few minutes on the local GPU, so briefly say what you're creating before the call. Never claim you made an image without calling the tool; the finished image is shown to the user automatically.`;

const NAME_STOPWORDS = new Set([
  'make', 'me', 'a', 'an', 'the', 'i', 'want', 'you', 'to', 'please', 'pls', 'build',
  'create', 'write', 'my', 'for', 'of', 'in', 'with', 'that', 'this', 'it', 'can',
  'and', 'then', 'than', 'like', 'us', 'some', 'new', 'app', 'project', 'game',
]);

export function wsNameFrom(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w && !NAME_STOPWORDS.has(w));
  return (words.slice(0, 3).join('-') || 'project').slice(0, 40);
}

export function slugify(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}

export function withToolsPolicy(promptMessages, wsRow, imageAllowed = true, userLoc = null, disabled = EMPTY_DISABLED, offered = EMPTY_DISABLED, available = null) {
  const hasTool = (name) => available ? available.has(name) : !disabled.has(name);
  const activeWidgets = available ? new Set([...offered].filter((name) => available.has(name))) : offered;
  const locPolicy = userLoc
    ? `## User location\nAn approximate location is available for the user (lat ${userLoc.lat}, lon ${userLoc.lon}, near ${userLoc.label ?? 'their area'}). You may omit place/query in show_weather or show_map to use it — do not ask them where they are.`
    : `## User location\nNo location is available for the user right now. Never omit place/query in show_weather or show_map expecting it to fall back to "where they are" — it will fail. Ask what place they mean.`;
  const showGate = !wsRow && hasTool('start_project');
  const showImage = imageAllowed && hasTool('generate_image');
  const showSearch = hasTool('web_search') && hasTool('fetch_page');
  const parts = [
    wsRow && (!available || ['read_file', 'write_file', 'edit_file', 'run_command'].some(hasTool))
      ? ACTIVE_POLICY : (showGate ? GATE_POLICY : null),
    showImage ? IMAGE_POLICY : null,
    showSearch ? SEARCH_POLICY : null,
    widgetPolicyFor(activeWidgets),
    (activeWidgets.has('show_weather') || activeWidgets.has('show_map')) ? locPolicy : null,
  ].filter(Boolean);
  if (wsRow) {
    const files = listTree(wsRow).slice(0, 60)
      .map((f) => (f.dir ? `${f.path}/` : f.path)).join('\n');
    parts.push(`Current workspace files:\n${files || '(empty)'}`);
    if (wsRow.host_path) parts.push(`This workspace is linked to an existing host project at ${wsRow.host_path}. Edits in /workspace change its real source files. A deployment may watch these files; follow the user's requested scope.`);
  }
  const policy = parts.join('\n\n');
  if (!policy) return promptMessages;
  if (promptMessages[0]?.role === 'system') {
    return [{ role: 'system', content: promptMessages[0].content + '\n\n' + policy }, ...promptMessages.slice(1)];
  }
  return [{ role: 'system', content: policy }, ...promptMessages];
}
