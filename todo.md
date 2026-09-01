# Model Hub — todo

Requested 2026-08-30, biggest first. `HubPanel.svelte` + `hfHub.js` /
`routes/hf.js` unless noted.

## Open
- **Media e2e test** — video/audio generation through the Media Studio UI
  hasn't been exercised yet (bridge health + PyAV encode smoke-tested only).
  First video run may pull VAE/text-encoder subfolders; watch the jobbar.
- **Voice + music UI** — SpeechT5/VITS/Bark (voice) and MusicGen (music) are
  wired in the bridge task map but MediaPanel's audio tab has no dedicated
  controls (speaker ref, melody prompt) yet.
- **i2v** — image-to-video isn't in the bridge task map (t2v only).
- **Held-out TPS calibration** — the `~t/s` chip runs LlamaDash's physics
  (t_token = weights/bandwidth × 1.18 + 5ms) on this box's measured numbers
  (9070 XT 600 GB/s, DDR5 53.6 GB/s) but with no calibration harness.
  LlamaDash got MdAPE 9.8% after fitting per-model scales from real
  generations; DuckPond's `messages` don't store per-turn timings against a
  model size yet. If the estimates feel off, log `tokens_out/tok_s` +
  model size per turn and fit a global scale — that's the cheap 80%.

## Done
- ~~Multi-job download manager~~ — shipped 2026-08-31: server-side registry
  (`server/src/downloadManager.js`), one `hf download` worker subprocess per
  repo, concurrent repos, disk-scan progress (survives restarts), claim/adopt,
  cancel (SIGTERM→SIGKILL), boot-time orphan reap, state in
  `$HF_HOME/.duckpond-downloads/`. Routes: `/api/hf/downloads`,
  `/download`, `/download/cancel`, `/downloads/clear`.
- ~~Media Studio (image/video/audio)~~ — shipped 2026-08-31: bridge.py
  rewritten for multi-task generation under Unsloth's venv (systemd service
  `image-gen-bridge-8765`), models discovered from the shared HF cache,
  video encoded with PyAV, audio with soundfile. `MediaPanel.svelte` — task
  tabs, per-task model picker, SSE progress, gallery + lightbox. Sidebar
  nav item "Media". See `notes/HUB-2.md`.
- ~~Search bars removed~~ — shipped 2026-08-31 everywhere (Sidebar,
  ModelPicker, Hub, Settings, Providers, Themes): password managers
  autofilled into them. Paste-repo row + curated chips instead.
  Do not re-add free-text inputs.
- ~~Unsloth-style quant picker~~ — shipped 2026-08-31, borrowed from their
  shipped bundle: flat quant rows with fit badges (fits / might fit /
  partial / won't fit — same thresholds: 97% VRAM budget, +15% overhead,
  partial = VRAM + 50% available RAM), size, on-disk state, `~t/s` estimate
  chip, per-row download AND delete, recommended default pre-picked
  (largest quant that fits), rows sorted fit-tier then size. All the math
  is server-side (`fitTier()` / `estimateTps()` in `hfHub.js`) from live
  rocm-smi + /proc/meminfo; the browser never talks to huggingface.co.
- ~~Projected TPS based on hardware~~ — shipped 2026-08-31 as the `~t/s`
  chip (see Open note for calibration follow-up).
- ~~Model card avatars~~ — shipped 2026-08-31: `GET /api/hf/avatar/:owner`
  resolves org → user overview, 12h in-memory cache, 302 redirect; the
  colored initial stays as the onerror fallback.
- ~~Structured download progress~~ — shipped 2026-08-31: jobbar parses the
  hf CLI's tqdm line into percent / transferred / total / speed / ETA and
  draws a real progress bar; variant label shown; done/error states
  distinct.
- ~~Delete models~~ — shipped 2026-08-31, two levels: (a) Model Picker
  trash button (owner-only, confirm dialog) → unload + `rm -rf` the whole
  `models--*` cache dir + strip matching sections from the router preset
  ini (`LLAMA_ROUTER_INI`, default
  `/home/lewis/llama-router-bazzite-vulkan.ini`); conversation falls back
  to the default model. (b) Hub quant-row delete → unlinks just that
  variant's snapshot blobs, other quants stay.
- ~~Tab-based browsing instead of sort chips~~ — shipped 2026-08-30: Unsloth
  (default landing tab, configurable in Settings > Sidebar navigation) /
  Popular (last 30d, big-name owner allowlist, merged+deduped server-side in
  `popularModels()`) / Image / Audio / Video (multi-pipeline_tag merge in
  `modalityModels()`). `prefs.hubDefaultTab` in `prefs.svelte.js`.
- ~~Trending/search returning nothing on load~~ — fixed 2026-08-30, `doSearch()`
  and the server route both required a non-empty `q`; empty query is a valid
  "browse" call.
- ~~Quant-maker step (unsloth vs bartowski vs mradermacher etc.)~~ — shipped
  2026-08-30 via `findQuantizers()` / `base_model:quantized:` HF filter.
- ~~`Shard_Rewrite` junk folder winning the default-smallest-quant pick~~ —
  fixed 2026-08-30, `groupVariants()` now drops any subfolder with zero real
  `.gguf` files before ranking by size.
