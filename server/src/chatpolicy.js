// Turn policies + speculative tool calling: the system-prompt blocks that
// describe tools to the model, and the stream watcher that pre-fires search /
// fetch calls as soon as their argument finishes streaming.
import { readdirSync } from 'node:fs';
import { listTree } from './routes/agent.js';
import { fetchPageStructured, searchWebStructured } from './websearch.js';
import { hostRoots } from './hostfs.js';

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

export function makeSpeculator(log) {
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
  ['show_dashboard', 'compose 2-8 of the widgets above into ONE titled grid — prefer it over separate calls when the cards belong together (a trip: weather + map + currency; a project: repo + npm + chart).'],
  ['generate_slides', 'build a real downloadable PowerPoint deck from an outline you write.'],
  ['export_csv', 'save tabular data as a downloadable CSV file.'],
];

const EMPTY_DISABLED = new Set();

function widgetPolicyFor(disabled) {
  const lines = WIDGET_LINES.filter(([name]) => !disabled.has(name)).map(([name, desc]) => `- ${name} — ${desc}`);
  if (!lines.length) return null;
  return `## Widgets\nYou can drop interactive cards right into the chat:\n${lines.join('\n')}\nBe proactive with these — don't wait to be asked for "the widget". The moment you're about to state a fact one of these covers, call the tool instead of just typing the number: a temperature or forecast → show_weather; a coin price → show_crypto; an exchange rate → show_currency; a package version/downloads → show_npm; a repo's stars/language → show_github_repo; a word's definition → show_dictionary; a place, address, or business → show_map; a date you're counting down to → show_countdown; a set of hex colors → show_color_palette; a small table of numbers or comparisons → show_table; a y=f(x) relationship → show_math_plot. Recommending a restaurant, landmark, or repo also earns its card the same way. The card renders for the user automatically, so don't paste a link, id, or coordinates in your text — just call the tool, then add one short sentence around it. You may use more than one in a reply, and it's fine to lead with the tool call before you've written anything.`;
}

// The coding panel itself. Models kept describing DuckPond's project mode
// wrongly — promising hosted preview URLs, telling users to "download the zip
// and run npm start", or claiming they couldn't show code at all — because
// nothing in the prompt ever described the UI the user is actually looking at.
// This block is included on EVERY turn that has any project capability, so the
// model can talk about the panel accurately even before entering project mode.
const CODING_PANEL_POLICY = `## The coding panel (what the user sees)
DuckPond has a real coding UI, not just chat. When a conversation is in project mode the user gets a Files rail beside the thread:
- a file tree of the project, with every file clickable and editable by them directly
- an in-canvas preview for HTML/CSS/JS and images — they see the page render inside DuckPond, with no server and no URL
- a live run feed: each of your tool calls appears as a step, shell output is shown, and every file you write or edit renders as a real before/after diff they can read
- a download button per file, and the whole project stays put between turns and between chats
Talk about it accurately: the user can already see the files, the diffs, and the preview — so do not paste an entire file back into chat after writing it, do not tell them to copy-paste code into an editor, and never offer a hosted link or a localhost URL, because there is no server and no port. "Open the preview in the Files rail" is the right instruction; "run npm start and visit localhost:3000" is not.`;

const GATE_POLICY = `## Project mode
You can build real software in this chat. To do it, call the start_project tool — it creates a sandboxed Linux workspace (Debian, Node 24 + npm, Python 3.13 + pip, git), saves your plan as PLAN.md, and unlocks file and shell tools.

Call start_project ONLY when:
- the user asks for a real project, app, game, script, or website they want to keep, run, or iterate on
- the work needs multiple files or packages, or must be executed to verify it

Do NOT call it when:
- the user wants a snippet, one-file example, or code just to read — answer in chat with a markdown code block
- the user is asking a question, discussing, or still planning — keep talking; only start the project when they clearly want it built

CRITICAL — no hosting / no ports:
- NEVER start a long-running web server, dev server, or anything that listens on a port (no npm run dev, vite, webpack-dev-server, python -m http.server, flask/django/express listen, etc.).
- There is no live preview host. The user previews HTML/CSS/JS in-canvas in the DuckPond Files rail (static files only) and can download any file.
- For websites/apps, write complete static files (index.html + css/js) or a self-contained HTML document. For scripts, write the file and verify with a one-shot command (node x.js, python x.py, tests) that exits.

If you do call start_project, briefly tell the user what you're about to build first, then call the tool with a short kebab-case name and a concise plan.`;

const ACTIVE_POLICY = `## Project mode (active)
This conversation has a persistent sandboxed workspace at /workspace (Debian, Node 24 + npm, Python 3.13 + pip, git). You have tools to list/read/write files and run shell commands.

Rules:
- Use tools when the user wants project work done (build, change, fix, run). For pure questions or discussion, just answer in chat — no tools.
- Keep PLAN.md current: check items off as you finish them; update it when the plan changes.
- Look before you leap: list or read files before editing them.
- write_file replaces the whole file — always write complete content, never fragments or placeholders.
- NEVER start long-running servers or bind ports. No dev servers. Write static HTML/CSS/JS for UIs; the user previews them in-canvas and can download files. Verify with one-shot commands that exit (node, python, test runners, build tools that finish).
- Package installs pause for the user's approval and may be denied; if denied, adapt.
- After tool work, finish with a short plain-text summary: what you built, how you verified it, what could come next. No tool calls in that final message.`;

/**
 * Desktop access, for the owner only. The model gets the REAL allowed folders
 * and their immediate contents inline, which is why no browse tool is needed:
 * it can name an exact path on the first try instead of guessing one and being
 * refused. Two readdir calls' worth of work, once per turn.
 */
function desktopPolicy() {
  let roots = [];
  try { roots = hostRoots(); } catch { return null; }
  if (!roots.length) return null;
  const lines = [];
  for (const root of roots.slice(0, 8)) {
    let kids = [];
    try {
      kids = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
        .slice(0, 25);
    } catch { continue; } // root was removed or is unreadable — skip it silently
    lines.push(`- ${root}${kids.length ? `\n    contains: ${kids.join(', ')}` : ' (no subfolders)'}`);
  }
  if (!lines.length) return null;
  return `## The user's own files on this machine
DuckPond runs on the user's own computer, and you can work directly on these real folders:
${lines.join('\n')}

When the user talks about something that already exists on their machine — "my app on the desktop", "the site in ~/code/foo", "fix the bug in my project" — call open_desktop_project with the exact absolute path from the list above, then use the normal file and shell tools on it. Nothing outside those folders is reachable, and credential files (.env, .ssh, keys, tokens) are refused even inside them; if a path is refused, tell the user what the error said instead of trying variations.

These are REAL files that the user cares about and has not backed up for you:
- Read before you edit. Always.
- Use edit_file with exact search/replace blocks. Do NOT rewrite a whole file to change a few lines, and never replace a file you have not read.
- Change only what they asked for. No opportunistic refactors, no reformatting, no renaming, no deleting files, no reorganising directories.
- Never run destructive shell commands (rm -rf, git reset --hard, git clean, checkout over uncommitted work, force pushes). If the job genuinely needs one, stop and ask first.
- If the folder is a git repo, say so and suggest they commit before you start on anything large.
The shell runs inside a container with just this folder mounted at /workspace, so builds and tests work normally, and nothing else on their computer is reachable from it.`;
}

const SEARCH_POLICY = `## Web search
You can search the web with web_search and read pages with fetch_page. Use them for current events, prices, versions, library docs, or any fact you are not confident about — never guess when you can check.
Use today's actual date (given above) when it matters: for anything about "latest", "current", "this year", recent releases, or news, search with the real current year — do not default to a year from your training data, and do not assume something is out of date just because it's after your training cutoff.
Work in small batches: run a search, then read up to about 3 of the most promising results with fetch_page. If that is not enough, refine your query and read another batch. Most questions need only a handful of pages — stop as soon as you are confident. You may read many more if a question truly demands deep research (a hard limit of 200 pages), but reaching for a lot of pages should be rare, not the default.
Cite as you write: right after any sentence or bullet that rests on something you read, add a markdown link to the exact page it came from, like [OpenAI pricing](https://example.com/pricing). Use the real page URL, never a bare URL on its own line, and never invent a link. If two pages back the same point, add both links next to each other. These links render as small source tags, so keep the link text to a couple of words. Skip searching for things you already know well.`;

// Search depth tiers. Caps flow into the inline-search loop; ultra also raises
// the thinking budget, turns up reasoning, and injects a deep-research directive.
export const RESEARCH_MODES = {
  quick: { reads: 8, searches: 6, rounds: 12, thinkMs: 60 * 60_000, ultra: false },
  normal: { reads: 200, searches: 40, rounds: 80, thinkMs: 60 * 60_000, ultra: false },
  ultra: { reads: 400, searches: 80, rounds: 160, thinkMs: 60 * 60_000, ultra: true },
};
export const ULTRA_DIRECTIVE = `## Deep research mode (active)
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

export function wsNameFrom(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w && !NAME_STOPWORDS.has(w));
  return (words.slice(0, 3).join('-') || 'project').slice(0, 40);
}

export function slugify(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}

export function withToolsPolicy(
  promptMessages, wsRow, imageAllowed = true, userLoc = null, disabled = EMPTY_DISABLED,
  { desktopAllowed = false } = {},
) {
  const locPolicy = userLoc
    ? `## User location\nAn approximate location is available for the user (lat ${userLoc.lat}, lon ${userLoc.lon}, near ${userLoc.label ?? 'their area'}). You may omit place/query in show_weather or show_map to use it — do not ask them where they are.`
    : `## User location\nNo location is available for the user right now. Never omit place/query in show_weather or show_map expecting it to fall back to "where they are" — it will fail. Ask what place they mean.`;
  const showGate = !wsRow && !disabled.has('start_project');
  const showImage = imageAllowed && !disabled.has('generate_image');
  const showSearch = !disabled.has('web_search');
  // The panel description goes in whenever this turn has ANY project
  // capability — in an active project, at the gate, or with desktop access —
  // so the model never has to invent what the coding UI looks like.
  const showPanel = !!wsRow || showGate || desktopAllowed;
  const parts = [
    wsRow ? ACTIVE_POLICY : (showGate ? GATE_POLICY : null),
    showPanel ? CODING_PANEL_POLICY : null,
    // once a desktop folder is open, ACTIVE_POLICY plus the desktop rules below
    // both apply; before that, this is what tells the model the folders exist
    desktopAllowed || wsRow?.host_path ? desktopPolicy() : null,
    showImage ? IMAGE_POLICY : null,
    showSearch ? SEARCH_POLICY : null,
    widgetPolicyFor(disabled),
    locPolicy,
  ].filter(Boolean);
  if (wsRow) {
    const files = listTree(wsRow).slice(0, 60)
      .map((f) => (f.dir ? `${f.path}/` : f.path)).join('\n');
    parts.push(wsRow.host_path
      ? `This project IS the user's real folder ${wsRow.host_path}. Every path you use is relative to it.\nFiles:\n${files || '(empty)'}`
      : `Current workspace files:\n${files || '(empty)'}`);
  }
  const policy = parts.join('\n\n');
  if (promptMessages[0]?.role === 'system') {
    return [{ role: 'system', content: promptMessages[0].content + '\n\n' + policy }, ...promptMessages.slice(1)];
  }
  return [{ role: 'system', content: policy }, ...promptMessages];
}