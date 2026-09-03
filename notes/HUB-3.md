# Hub 3 + Settings + Media — LM Studio / Unsloth Studio dissection (HUB-3)

> Requested 2026-09-02: literally dissect Unsloth Studio's backend (full source,
> installed at `~/.unsloth/studio/unsloth_studio/lib/python3.13/site-packages/studio`)
> and LM Studio's app (AppImage extracted, `.webpack/renderer/main_window.js`,
> terser-minified — not obfuscated, so Zod schemas and all UI copy strings are
> readable verbatim). User is fine with flat-out copying since this is
> single-user — no attribution hedging needed. Open WebUI ruled out as a model:
> "lmstudio and unsloth have what i want." Keep the duck mascot and the
> existing widget framework untouched. Other completion routers with better
% widget support are a maybe-later, not a priority.

## 0. What's already true (don't redo)

- HubPanel.svelte already deep-copies Unsloth's Hub: avatar cards, endless
  scroll, quant-maker chips, fit-badge vocabulary (fits/marginal/partial/ram/oom),
  downloaded-first sort. This round is about what it's still missing, not a
  rewrite from scratch.
- The LLM router (`llama-router-8081.service`) already *is* Unsloth's own
  ROCm/HIP llama.cpp build — "unified with unsloth-studio.service" per the
  systemd unit. Backend reuse for text generation is done.
- `server/image-bridge/bridge.py` runs inside Unsloth's venv (shares its deps,
  its HF cache) but only imports stdlib + torch + numpy — it does NOT call
  into Unsloth's `core.inference.diffusion_families` / `video_families` /
  `diffusion_engine_router`. It's a hand-rolled dispatcher sitting next to
  Unsloth's actual family-detection/build-check code, not on top of it.

## 1. Done this round (2026-09-02)

- **Avatar tinting bug** — every avatar was tinted a random per-owner hue,
  which bled through transparent-PNG org logos and turned clean brand icons
  into colored smudges. Hue now reserved for the no-image fallback only; real
  logos sit on a plain light tile like Unsloth's/LM Studio's, bumped bigger
  (48px list / 72px detail).
- **Task-type badges** — `pipeline_tag` mapped to Unsloth's own vocabulary
  ("Conversational" etc.), colored dot on list rows + full badge on the
  detail pane, so a model's type reads at a glance.
- **Type + Sort filters** — client-side over whatever's already loaded (no
  backend round trip): filter by chat/image/audio/video/embeddings, sort by
  downloads/likes/newest.
- **Hardened search box** reinstated on Discover (see notes/HUB-2.md's
  original removal) — randomized per-mount field name + the
  lpignore/1p-ignore/bwignore/autocomplete-off quartet, debounced 350ms.
  User explicitly approved this after the "no free-text inputs" rule.
- **"My Models" tab** — server-side disk scan (`server/src/localInventory.js`)
  across the whole HF cache + plain model dirs, `/api/hf/local(+delete)`
  route, independent of the router's preset ini.
- **Quant list collapses** behind the picked-quant summary row (chevron,
  matches Unsloth's own screenshot) instead of always rendering everything;
  downloaded rows dropped a redundant duplicate "on device" icon.
- **"(Recommended)" inline label** on whichever quant Hub auto-picked, LM
  Studio-style.
- **Local-generation retry** (`llama.js: streamChat`) — a dropped connection
  to the router (sleeping model waking up, mid-swap, TCP hiccup) now retries
  up to 3x with backoff, only while nothing has streamed yet, only on
  network-level errors or a 503 — not on a real model-load failure. Surfaces
  as a "reconnecting…" notice instead of a hard error. This was the
  session's "pet peeve" ask; check back if errors during generation persist,
  since not every failure mode is a dropped connection (a genuinely broken
  GGUF, e.g. an unsupported experimental quant, still fails immediately and
  correctly — that's not a bug).
- **GGUF classification fix** — the Type filter/task badge shipped earlier
  this round trusted HF's `pipeline_tag` literally, but that field is very
  often just missing on GGUF-only repos (confirmed live: `unsloth/Qwen3.8-
  27B-GGUF`, `DeepSeek-V4-Pro-0813-GGUF` etc. all return no tag at all), so
  a huge share of the real catalog silently vanished under every filter but
  "All". Fixed by extracting the LLM picker's own classifier (which already
  falls back to filename regex heuristics and defaults to chat rather than
  "unknown") into a shared `server/src/modelKind.js`, and having `hfHub.js`
  attach the same `kind` to every Hub result so the client filters/badges
  off that instead of a raw tag lookup. Also split video out from image
  (`image-text-to-video` etc. were falling into the image bucket).
- **"Downloads" tab** — the Hub only ever showed a transient top banner for
  jobs currently in flight, which vanished the moment a download finished,
  errored, or got cancelled — no way to see what happened to something
  after the fact. Added as a third mode next to Discover/My Models
  (`downloadManager.js` already persisted the full job history server-side,
  `GET /api/hf/downloads` already returned it — this was purely a missing
  frontend view), with a "Clear finished" action wired to the existing
  `clearFinished()` endpoint, and an active-count badge on the tab itself.
- **Ghost models in the picker after deleting from My Models** — deleting a
  model through the My Models tab (`POST /api/hf/local/delete`) stripped
  its router-preset ini section on disk but never told the *running*
  router to re-read it, so the picker kept listing a model whose file was
  already gone until something else happened to trigger a reload. Fixed by
  force-reloading the router (`reloadRouterModels()`) right after any
  preset-section removal, same pattern the classic model-picker trash
  button already used. Also closed a related gap: deleting a single quant
  (not the whole repo) never stripped its preset section at all if it had
  one — `deleteVariant()` now does that too.

## 1b. Done 2026-09-03 (GGUF quant display was actively wrong)

- **Unsloth Dynamic quants all rendered as the bare word "dynamic"** —
  `quantLabel()` collapsed every `UD-*` level (`UD-TQ1_0`, `UD-IQ2_M`,
  `UD-Q3_K_XL`, ...) to the literal string `"dynamic"`, so a repo with 20+
  dynamic variants showed 20+ rows reading identically, only distinguishable
  by scrolling to compare byte sizes. This is what "the gguf stuff isn't
  showing up correctly" and "unsloth quants... it just says dynamic" were
  about. Now shows the specific level: "Dynamic Q2_K_XL", "Dynamic TQ1_0".
- **Speculative-decoding draft heads mislabeled as real quants** — a repo
  that ships an MTP/EAGLE/dFlash draft head quantized the same as the main
  model (e.g. `TaterTotterson/gemma-4-26B-A4B-it-GGUF-Tater-NoThink`'s
  `-MTP-Q8_0.gguf` and `-DFlash-Q8_0.gguf`, ~460MB each, next to the real
  17GB `-UD-Q4_K_M.gguf`) got the exact same bare "Q8_0" label as a real
  full-size Q8_0 quant would — indistinguishable, and what actually happened
  when trying to download "the Q8_0 model". Now reads "MTP draft (Q8_0)" /
  "dFlash draft (Q8_0)", stays downloadable on its own, and is excluded from
  the recommended-default pick.
- **Downloaded models missing from My Models** — `hf download` writes a
  file's blob before creating the snapshot symlink pointing to it; a cancel
  or crash in that gap leaves a real, fully-written blob with nothing
  referencing it, so the repo scanned as completely empty. Found 5 repos,
  ~48GB orphaned this way, including `unsloth/Qwen3.8-27B-GGUF` (17GB).
  `localInventory.js` now surfaces these as an "Incomplete — not usable"
  row with a one-click delete to reclaim the space.
- **Quant-maker chips hijacking an already-GGUF repo** — opening a repo
  that's already real GGUF (e.g. `unsloth/GLM-5.3-Flash-GGUF`) queried HF for
  "who else quantized this already-quantized repo" and defaulted straight to
  whatever unrelated third-party repackaging came back first (layer-sharded
  mirrors like `meshllm/...-layers`) instead of showing the repo actually
  clicked. Chips now only auto-navigate away for a genuine base/safetensors
  model with no GGUF of its own.

## 2. Todos — most complex → least complex

### 0. Old/removed models sometimes still show in the model picker
Reported 2026-09-03, after already fixing one cause of this on 2026-09-02
(router-reload-before-preset-edit ordering bug, + My Models delete not
refreshing the picker's store). Still happening "sometimes" per the user, so
there's at least one more cause not yet found. Not investigated this round —
next session should check: (a) the idle-reaper (`reapIdleModels` in
llama.js) unloading a model in the background without the picker's `app.models`
store ever refreshing to reflect it went from loaded→unloaded/gone; (b) a
race between ModelPicker's optimistic state and its 2.5s/6-8s delayed
re-polls (see 2026-09-02's ModelPicker commit) landing in the wrong order;
(c) whether the router's own preset ini can drift out of sync with disk some
other way (e.g. a model deleted by hand outside DuckPond, or by another tool
sharing the same HF cache — Unsloth Studio, Duck Pond Control). Needs
reproduction first — ask what "sometimes" correlates with (right after a
delete? after idle unload? after a router restart?) before guessing at a fix.

### 1. Sort/filter sidebar for Discover — size, TPS, param count, recency sliders
Requested 2026-09-03: "sort by model size, tps speed so like only show
models that will hit above the tps slider or below... same for the param
size... a slider for how recent... a whole sidebar I can click through like
sort settings basically." Currently Discover only has the two flat dropdowns
(Type, Sort-by) added 2026-09-02 — this is a bigger ask: a persistent
side panel with range sliders that actually FILTER the list (not just
reorder it), for at minimum:
- **TPS** — `estimateTps()` already runs per-variant in `hfHub.js`, but only
  against the currently-selected repo's variants once you've drilled in;
  filtering the top-level Discover list by TPS means either estimating TPS
  for every search result up front (expensive — needs param count + a
  chosen/assumed quant, not just the repo id) or estimating it against the
  repo's *recommended* variant only as a stand-in. Needs a decision on which.
- **Param size** — `modelParamsB()` (`modelDescribe.js`) already parses
  param count from a repo id/name string for the TPS estimator and the LLM
  picker's blurb; same parser reusable here, but only ever a name-based
  guess, not authoritative (no HF field for it) — same caveat as TPS.
- **Recency** — trivial, `updatedAt` is already on every search result.
- **Model size (bytes)** — trivial for a single quant, ambiguous for a
  multi-quant repo (smallest variant? recommended variant? total repo size?
  probably recommended variant, matching what TPS/fit already key off of).
Given TPS/param-size need a per-result estimate that isn't free at Discover's
current scale (30-100 results/page, cursor-paginated), this needs a design
pass on where that computation happens (server-side per search result vs.
client-side only after opening each repo) before implementing — flag this
back to the user rather than guessing.

### 2. Reuse Unsloth's own inference engine code in the media bridge
Right now `bridge.py` hand-rolls model → pipeline dispatch. Unsloth's
`core/inference/diffusion_families.py`, `video_families.py`, and
`diffusion_engine_router.py` already do family detection (which repo/GGUF is
Flux vs SDXL vs Wan vs LTX-V) and `family_buildable_here()` / AMD-ROCm
capability checks — this is the part that's "already optimised for AMD" the
user wants to inherit rather than re-derive. Needs: import these modules
directly from the bridge's venv (same interpreter already, so no new dep),
replace bridge.py's own family-guessing with calls into them, and pull in
`offload_planner.py`'s placement logic for the video/diffusion side too
(it's currently LLM-only via the llama.cpp router). Biggest lift here because
it means understanding Unsloth's internal module boundaries well enough to
call them as a library rather than through their FastAPI routes — check
whether `studio.backend.core.inference.*` has any hidden dependency on
Studio's own FastAPI app state (DB connections, settings singletons) before
assuming it's import-safe standalone.

### 3. Settings page: flat 1302-line scroll → sectioned nav
LM Studio's load-settings pattern is title/subTitle/info triples per row,
grouped into named sections navigated from a left rail (General, Hardware,
Developer). DuckPond's SettingsPanel.svelte is one continuous page mixing
context-saver stats, tool permissions, GitHub, memory, per-model settings,
account, and owner admin. Split into sections with the same left-nav pattern;
keep every existing feature, just re-house it. This is the concrete answer to
"how settings work and are laid out — make it more user-friendly." Medium-high
complexity because it's 1302 lines of stateful UI to re-partition without
breaking any of the existing effects/api calls.

### ~~Model Hub: add a "My Models" tab~~ — done, see §1

### 5. Media Studio panel polish
Once #2 lands, the model list MediaPanel.svelte shows should come from the
same family-detection Unsloth uses, so "no video models downloaded" etc.
reflects real buildability, not just presence in the HF cache. Also worth
adopting LM Studio's title/subTitle/info row style here for the per-task
knobs (steps, size, frames/fps, duration) instead of bare labeled inputs.
Lower complexity — mostly cosmetic once #1's data is available.

### 6. Rankings tab — coding score, benchmark leaderboards
Requested 2026-09-02: a tab (alongside Unsloth/Popular/Image/Audio/Video)
that ranks models by benchmark scores (coding score, Chatbot Arena-style
Elo, etc.), plus surfacing that same signal as a sortable/visible thing on
the main Discover list too. **Blocked on a decision, not just effort**: HF's
own model API has no benchmark-score field — this needs pulling from an
external leaderboard source (LMSYS Chatbot Arena, HF Open LLM Leaderboard,
Aider's coding leaderboard, LiveBench, etc.), which is a hosted external API
DuckPond doesn't currently call — per standing rule, wiring any of those in
needs the user's explicit go-ahead first, every time, not just once. Also
non-trivial matching-wise even once approved: leaderboards rank BASE models,
not the GGUF quant repos Discover actually lists, so a repo would need
fuzzy-matching back to its base model (the existing quant-maker plumbing
already resolves that direction once, could maybe be reused) before a score
could attach to it.

### ~~Staff Pick style badge~~ — done, see §1's 2026-09-02 entry

## 3. Reference: exact vocabulary pulled from LM Studio (for #5, and general flavor)

Fit tiers (`modelSearchResultDownloadOptionFitEstimationSchema`, a 4-way enum
vs. Unsloth/DuckPond's 5-way fits/marginal/partial/ram/oom):
- `fullGPUOffload` — "Full GPU Offload Possible" / "This model might fit
  entirely in your GPU's memory. This could considerably speed up inference."
- `partialGPUOffload` — "Partial GPU Offload Possible" / "...might fit
  partially in your GPU's memory. This could often considerably speed up
  inference."
- `fitWithoutGPU` — "Likely Fit"
- `willNotFit` — "Likely too large" (description mentions architecture / file
  integrity / available memory as possible causes)

Per-model load-setting copy (title / subTitle / info triples — the pattern to
reuse for Settings):
- GPU Offload — "Number of discrete model layers to compute on GPU for GPU
  acceleration" / "Set the number of layers to offload to the GPU."
- Flash Attention — "Reduces memory usage and generation time on some models"
  / "Speeds up attention mechanisms for faster and more efficient processing"
- Keep Model in Memory — "Reserve system memory for the model, even when
  offloaded to GPU. Improves performance but requires more system RAM"
- Use FP16 For KV Cache — "Reduces memory usage by storing cache in
  half-precision (FP16)"
- Num Experts — "The number of experts to use in the model"

Downloaded-model row actions: two side-by-side secondary buttons, "Use in New
Chat" (play icon) and "Load Model" (code icon).

Search result identifier is a discriminated union of `catalog` (LM Studio's
own curated set) vs `hf` (raw HuggingFace) — mirrors DuckPond's existing
Unsloth-tab/Popular-tab vs raw-search split, so no new concept needed there.

## 4. Reference: Unsloth internals worth knowing about (beyond what's already borrowed)

- `core/inference/offload_planner.py` — `-ot` tensor-level spill planner
  (spills FFN blocks to host RAM while keeping KV cache resident, instead of
  llama.cpp's default whole-layer `-ngl` spill). Ladder is cost-modeled in
  actual ms/token, not just byte-fit. **Off by default** behind
  `UNSLOTH_SMART_OFFLOAD` — their own comment says it was validated on
  datacenter GPUs (T4/L4/A100/B200/gfx1151 APU) and measured to actively hurt
  small consumer boxes in a later report (slower in 40/43 planned cells on a
  6-core desktop). Do not flip this on for the 9070 XT box without measuring
  first — it may be a net loss here, same as it was on their small-host test.
- `utils/vram_budget_settings.py` — a persisted 0.80–1.00 VRAM budget
  fraction (default 0.97) the user can tune via settings, replacing what used
  to be a hardcoded constant. Simple, low-risk pattern DuckPond could copy
  as a Settings slider if the VRAM fit math ever needs user tuning.
- `hub/utils/gguf.py: pick_best_gguf()` — the exact quant-preference-order
  fallback logic behind "recommended default" (`GGUF_QUANT_PREFERENCE` list,
  falls back to first file if nothing preferred is present). DuckPond's
  `hfHub.js: recommendVariant()` likely reimplements the same idea — worth a
  side-by-side diff of the preference order if recommendations ever look off.
