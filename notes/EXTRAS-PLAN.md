# EXTRAS PLAN — task #6 (updated 2026-07-11 by Fable)

Status of the extras batch, plus the architecture for whatever isn't done.
Anything marked GRIND is safe to hand to Sonnet; the designs are settled here.

## Done (this session)
- **Image generation** — SHIPPED + VERIFIED.
  - Bridge (:8765) live progress: `tag` in POST body, `GET /v1/progress?since=`,
    container writes progress.json + latent-approx preview.png per step
    (SDXL via factor matrices, flux2 via row-major unpack; ideogram coarse
    phases only). generate_once.py is mounted per-job — bridge restarts are
    only needed for bridge.py changes.
  - DuckPond: server/src/imagegen.js (shared client, always saves to
    data/images + `images` table), routes/images.js (models/gallery/file/
    delete/generate SSE), ImageStudio.svelte + lib/images.svelte.js (live
    "taking shape" view + gallery), Topbar/App wiring.
  - In-chat `generate_image` tool: offered alongside start_project (no
    workspace) and inside AGENT_TOOLS (project runs → 'image' run events,
    rendered in RunFeed). Inline branch in chat.js streams
    image_job/image_progress/image_preview/image_done over the chat SSE;
    Chat.svelte renders the live preview card; final message embeds the image
    as markdown. VERIFY: chat e2e was in flight when this was written — if it
    failed, debug from scratchpad chatimg2-sse.log equivalent (see
    OPUS-IMAGE-TODO.md step 4 for the checklist; steps 1-3 there are DONE).

## Diffusion LLMs (in flight — most complex extra)
- Binary: `/home/cranky/bin/llama-prebuilt/b9966-vulkan/llama-diffusion-cli`
  (built from source tag b9966 in a fedora:44 container, static, Vulkan;
  build script: scratchpad/build-diffusion-cli.sh — official release bundles
  do NOT ship this tool).
- Models in `/home/lewis/llm-models/llama.cpp-models/diffusion/`:
  llada-8b-q4km.gguf (diffuse-cpp/LLaDA-8B-Instruct-GGUF); optionally add
  LLaDA-MoE-7B-A1B-Instruct-TD Q4_K_M (mradermacher) — much faster (1B active).
- Server: routes/diffusion.js — POST /api/diffusion/generate (SSE) spawns the
  cli with --diffusion-visual, unloads router models first (VRAM), parses
  clear-screen-delimited frames → {type:'step', n, steps, text} throttled to
  ~8fps; GET /api/diffusion/models lists ggufs. One job at a time (`busy`).
- UI: DiffusionLab.svelte + lib/diffusion.svelte.js, FlaskConical topbar
  button, view 'diffusion'.
- OPEN: first smoke test of the cli output format — if no frames appear, the
  cli may disable visual mode when stdout isn't a tty; wrap the spawn in
  `script -qec '<cmd>' /dev/null` to fake a pty and re-test. Also confirm the
  chat template is applied for LLaDA-instruct (if output looks like raw
  completion gibberish, wrap the prompt server-side with the LLaDA chat
  format). Verify GPU offload works (radv warning is normal).

## Web search (next most complex) — design settled, NOT started
- Engine: SearxNG in podman (`docker.io/searxng/searxng`), loopback
  :8888, JSON API (`/search?q=…&format=json`). Run it like the sandbox
  containers: `systemd-run --user --scope --collect podman run …` + a user
  systemd unit so it survives reboots. settings.yml needs
  `search.formats: [html, json]`.
- Server: `web_search(query)` + `fetch_page(url)` as INLINE chat tools (no
  workspace). Generalize the chat.js inline-image branch into a small inline
  tool loop: tools that aren't start_project are executed in-place, results
  fed back, model re-called (cap ~6 iterations). web_search returns top 5
  results (title, url, snippet); fetch_page fetches with a 10s timeout,
  strips tags/scripts, caps ~4k chars. SSRF guard: block non-http(s) and
  private-range hosts.
- UI: the composer's globe button (currently "coming soon" toast) becomes a
  per-message toggle that appends a system hint "the user asked you to search
  the web for this" — the model still decides the query. Tool calls render as
  chips like agent runs (reuse tool_delta plumbing).
- Policy: add SEARCH_POLICY next to IMAGE_POLICY in chat.js — search for
  current events/facts you don't know; cite sources as markdown links.

## Memory / retrieval — design settled, NOT started (GRIND after schema)
- Table: `memories (id, user_id REFERENCES users ON DELETE CASCADE, content,
  source_conv_id, created_at)`.
- `remember(fact)` inline chat tool (same inline loop as web_search): the
  model saves durable user facts (name, preferences, projects). Policy: only
  save things worth remembering across chats; never secrets/passwords.
- Injection: buildPrompt prepends "## What you remember about this user"
  (newest 20, ~1500 chars cap) after the core prompt.
- UI: Settings → "Memory" section — list + delete per row; per-user.
- No embeddings/RAG in v1 — friend-scale, keep it simple.

## TTS — research done, NOT started
- `llama-tts` EXISTS in both prebuilt bundles (b9625 + b9966). It needs the
  OuteTTS model gguf + WavTokenizer gguf (~2GB total,
  OuteAI/OuteTTS-0.2-500M-GGUF + ggml-org/WavTokenizer). Download both to
  llm-models/tts/.
- Server: POST /api/tts {text} → spawn llama-tts (`-m outetts -mv wavtokenizer
  -p "<text>"`, cwd a temp dir) → returns output.wav → stream audio/wav.
  Serialize (one at a time), cap text ~600 chars per call, split longer.
  CPU-only is fine for short clips if the GPU is busy (test both).
- UI: speaker icon in Message.svelte action row → fetch blob → `new Audio`.
- If OuteTTS quality/speed disappoints: piper in a podman container is the
  fallback (rhasspy/piper, en_US voices, near-instant on CPU).

## Stats dashboard — GRIND, design trivial
- /api/stats already exists (per-model tokens/tok_s/requests + 7-day rolling).
  Add: images count + disk usage (data/images), workspace count, DB size.
- UI: either a Settings section or a small "Stats" view: stat tiles (tokens
  in/out, requests, avg tok/s) + per-model table + per-day bars (usage_stats
  has day granularity). Pixel-art or Lucide icons ONLY (no emoji).

## Two-user GPU queue (task #9 — related, unscoped here)
All GPU consumers now: router chat, image bridge (GEN_LOCK + unloads LLMs),
diffusion cli (unloads LLMs). A proper cross-feature queue in DuckPond
(serialize chat gens + image jobs + diffusion runs per GPU) is the right fix
for the "model failed to load" errors seen when an image job overlaps a chat
model load. Design later; don't band-aid.
