# Model Hub — todo

Requested 2026-08-30, biggest first. `HubPanel.svelte` + `hfHub.js` /
`routes/hf.js` unless noted.

## 1. Projected TPS based on hardware
Before download, estimate tokens/sec for the picked quant on this box's
actual hardware (VRAM free, GPU model, RAM) — same idea as LlamaDash's TPS
predictor (see `moe_offload_tuning.md` / `speculative_decoding.md` /
`llamadash_tps_calibration.md` memory notes for the model that already
exists there; check whether its logic/data is reusable or needs its own
simpler heuristic here since DuckPond doesn't have LlamaDash's calibration
harness). Show as a stat chip next to the VRAM-fit warning in the variant
picker.

## 2. Model card avatars (org/user PFP, not screenshots)
Replace the colored-initial squares with the real HF avatar image.
Confirmed working endpoints (tested live 2026-08-30):
- Org: `GET https://huggingface.co/api/organizations/{owner}/overview` →
  `avatarUrl`
- User: `GET https://huggingface.co/api/users/{owner}/overview` →
  `avatarUrl`
Try org first, fall back to user, fall back to the current colored-initial
square if both 404 (private/deleted accounts, edge cases). Needs a small
server-side proxy/cache route (same "browser never talks to
huggingface.co directly" reason as everything else in `hfHub.js`) —
`GET /api/hf/avatar/:owner` returning the image or a redirect, with an
in-memory or short-TTL cache per owner so the list view isn't firing N
avatar lookups on every render.

## Done
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
