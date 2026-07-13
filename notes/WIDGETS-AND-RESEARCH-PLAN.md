# DuckPond — In-chat Widgets + Deep Research (plan)

The model should be able to summon **interactive widgets right in the chat** — a
themed weather card, a real pannable map with a pin, charts it builds from data,
embeds (YouTube / Reddit / GitHub / photos) — like the image bubble but *usable*,
not a dead embedded link. Multiple widgets can show up in one reply. Plus a
deep-"ultra research" search mode and a thinking watchdog.

No CSP is set on the app (verified), so Leaflet tiles, sandboxed iframes, and
external embeds all work in the browser.

---

## A. Widget system

### A1. What a widget *is* (representation + persistence)
A widget is a typed JSON object:
```json
{ "type": "weather", "id": "w1", "v": 1, "data": { ... } }
```
It is persisted **inline in the assistant message content** as a fenced block:
````
```duckwidget
{"type":"weather","id":"w1","data":{ ... }}
```
````
Why inline (not a separate DB column):
- **Ordering + interleaving with prose is free** — a widget sits exactly where
  the model put it, between paragraphs.
- Survives reload, **branching, edit, regenerate** with zero extra plumbing.
- The message renderer already maps over blocks → **multiple fences = multiple
  widgets**. That is the whole answer to "how does chat handle many widgets":
  they're just blocks in the stream, rendered in place, top-to-bottom.

### A2. How the model makes one (tools)
One tool per widget type (small local models handle several narrow, well-described
tools far better than one mega-tool). Each tool call follows the **existing
in-chat image pattern**:
1. Server fetches/normalizes data from a free API (or validates an embed URL).
2. Emits SSE `{type:'widget', widget}` → renders live under the streaming reply.
3. Appends the ```duckwidget``` block to the message content → persists.
4. Returns a short text result to the model so it can talk about it.

This drops into the **existing inline tool loop** (`runInlineSearch` in
`routes/chat.js`, which already handles web_search / fetch_page / generate_image
— rename it `runToolTurn`). No second loop, no new branch soup.

### A3. Widget catalog
Two families:
- **Template widgets** — fixed, designed layout; only the data changes.
- **Embed widgets** — external content in a sandboxed, allowlisted iframe.

| type | tool | free data source | interactive bits |
|---|---|---|---|
| weather | `show_weather(place?/coords)` | Open-Meteo (no key) + OM geocoding | now + hourly/daily tabs; **themed background by condition** (sun/cloud/rain/snow/night) — the elementor look |
| map | `show_map(query\|coords, label)` | Nominatim geocode + Leaflet + OSM tiles | pan / zoom / pin / popup |
| chart | `show_chart(kind, series, labels, opts)` | model-supplied data | hover tooltip, legend toggle, PNG export; pie/bar/line/area/scatter |
| github | `show_github_repo("owner/repo")` | GitHub REST (unauth, 60/hr) | stars/forks/lang/desc + link |
| youtube | `embed_youtube(url\|id)` | youtube-nocookie iframe | full player |
| reddit | `embed_reddit(url)` | reddit embed/oEmbed | native embed |
| images | `show_images(query, n)` | SearxNG image results | lightbox grid + download |
| later | stock, wikipedia card, week forecast, directions, countdown, poll, mermaid diagram | — | — |

### A4. Rendering (frontend)
- `Widget.svelte` = dispatcher: `switch(widget.type)` → the specific component.
- `WidgetFrame.svelte` = shared chrome: title, source link, toolbar
  (**download PNG**, expand/fullscreen). Every widget wraps in it → one visual
  language, light/dark aware.
- `Message.svelte`: in the block loop, detect a `duckwidget` block → render
  `<Widget>` instead of a code block; everything else stays markdown.
- Live streaming: `Chat.svelte` collects `{type:'widget'}` events into
  `app.streaming.widgets[]`, rendered under the streaming bubble. On `done` the
  content already carries the fences, so the live array is dropped and the saved
  message renders them — no flicker, no dupes (ids match).

### A5. Download-as-photo
Bundle `html-to-image`. WidgetFrame's download button renders the widget node to
PNG. Works for weather/chart/github/images. Maps need `leaflet-image` or a canvas
renderer — flagged as a phase-3 caveat.

### A6. Multiple widgets — solved
- Independent blocks → stack in order, interleaved with prose.
- Model can fire several widget tools in one turn; the loop runs them
  sequentially, each appends a block + SSE event.
- **Grid polish:** when ≥2 *compact* widgets are adjacent with no prose between,
  wrap them in a responsive grid (`auto-fit, minmax(260px, 1fr)`). v1 stacks;
  grid is a later refinement.

### A7. Security
- Embeds: `<iframe sandbox>` + **host allowlist** (youtube-nocookie, reddit,
  redditmedia, imgur, …). Unknown host → refuse, fall back to a plain link card.
- Server-side fetches keep the existing **SSRF guard** (public http(s) only).
- No API keys in the client; if a keyed API is ever added, the server proxies it.

---

## B. User location (for weather / maps)
- Client: `navigator.geolocation` behind an explicit **Settings toggle**
  ("Share location for weather & maps") + a one-time permission prompt. Cache
  `{lat, lon, label}` in prefs (localStorage). Never silent.
- Sent with each chat body as `userLoc`; threaded into tool context so
  `show_weather` / `show_map` default to it when the user names no place.
- Fallback: coarse server-side IP geolocation if permission denied.

---

## C. Search modes (deep research)
A mode control near the composer; default **Normal**. Caps become mode-driven
params passed into `runToolTurn` (`MAX_READS`, `MAX_SEARCHES`, `MAX_ROUNDS`), and
`SEARCH_POLICY` text varies per mode.

| mode | page-read hard cap | behavior |
|---|---|---|
| Quick | ~8 | fast, shallow, answer soon |
| **Normal** (default) | **200** | soft-suggest few (~6–12); prompt nudges "stop as soon as confident" — *try not to reach 200* |
| **Ultra Research** | **~400** | decompose question → subqueries → search each → read widely → **synthesize** a concrete, heavily-cited answer; `reasoning_effort: high`; deeper round cap; bigger progress trace ("Researched N sources across M searches") |

Guardrails: dedupe URLs (never reread), keep batch-of-3 pacing, hard stops at the
caps, Stop button already exists. Ultra can run minutes and holds the GPU → show
elapsed; consider owner-gating or a confirm.

---

## D. Thinking watchdog
Allow long thinking generally, but if the model streams reasoning for **60s
straight with no content token and no tool-call fragment**, abort that
generation. Arm a 60s timer on the first thinking token after any productive
output; disarm on any content/tool fragment; on fire → abort + clean note (or one
auto-retry with thinking off). Applies to every `streamChat` (first call + each
research round).

---

## E. Phases & tiering
- **Phase 0 (quick):** search hard-cap → 200 + thinking watchdog. *(Opus/Sonnet)*
- **Phase 1 (core):** widget framework (block format, Widget dispatcher,
  WidgetFrame, SSE plumbing, tool-loop integration) + **WeatherWidget** +
  **MapWidget** + location capture. *(Opus)*
- **Phase 2:** embeds — youtube, reddit, github, images. *(Sonnet — repeats the pattern)*
- **Phase 3:** charts (use the **dataviz** skill) + download-PNG everywhere. *(Opus)*
- **Phase 4:** Ultra Research mode + mode switcher + deep-research prompt. *(Opus/Fable)*
- **Phase 5:** more widgets, grid layout for multiples, cohesive visual polish. *(Fable / Sonnet)*

## F. Libraries to add (web)
- `leaflet` (maps) — npm reachable (verified).
- a chart lib — **LayerChart** (Svelte-native) or Chart.js or uPlot; decide in Phase 3 with the dataviz skill.
- `html-to-image` (PNG export).

## Decisions (locked 2026-07-12)
- **Build order:** everything, phase by phase (0 → 1 → 2 → 3 → 4), starting with Phase 0.
- **Chart library:** LayerChart (Svelte-native).
- **Ultra Research:** available to everyone (still show elapsed + Stop; caps are hard stops).
- **Location:** geolocation opt-in via a Settings toggle.

## Scope note
This is a **standalone** plan. It does not replace or fold into the older DuckPond
plans (`EXTRAS-PLAN.md`, `DIFFUSION-HANDOFF.md`, `CORE-PROMPT-FABLE.md`,
`MEMORY-RETRIEVAL-FABLE.md`, `MCP-SONNET.md`, …) — those stay separate and valid.
Point Fable at the specific plan file for the task at hand.
