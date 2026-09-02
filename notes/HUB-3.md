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

## 2. Todos — most complex → least complex

### 1. Reuse Unsloth's own inference engine code in the media bridge
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

### 2. Settings page: flat 1302-line scroll → sectioned nav
LM Studio's load-settings pattern is title/subTitle/info triples per row,
grouped into named sections navigated from a left rail (General, Hardware,
Developer). DuckPond's SettingsPanel.svelte is one continuous page mixing
context-saver stats, tool permissions, GitHub, memory, per-model settings,
account, and owner admin. Split into sections with the same left-nav pattern;
keep every existing feature, just re-house it. This is the concrete answer to
"how settings work and are laid out — make it more user-friendly." Medium-high
complexity because it's 1302 lines of stateful UI to re-partition without
breaking any of the existing effects/api calls.

### ~~3. Model Hub: add a "My Models" tab~~ — done, see §1

### 4. Media Studio panel polish
Once #1 lands, the model list MediaPanel.svelte shows should come from the
same family-detection Unsloth uses, so "no video models downloaded" etc.
reflects real buildability, not just presence in the HF cache. Also worth
adopting LM Studio's title/subTitle/info row style here for the per-task
knobs (steps, size, frames/fps, duration) instead of bare labeled inputs.
Lower complexity — mostly cosmetic once #1's data is available.

### 5. Rankings tab — coding score, benchmark leaderboards
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

### 6. Staff Pick style badge (the rest of the old #6 — "(Recommended)" is done)
Consider a "Staff Pick" style badge for curated/Popular-tab entries (LM
Studio's `staffPick` boolean on search results) distinct from the existing
Unsloth-owner verified checkmark. Lowest complexity — pure template/CSS,
no new backend data needed since "Popular" is already a curated allowlist
server-side.

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
