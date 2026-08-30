# Model Hub — todo

Requested 2026-08-30, biggest first. `HubPanel.svelte` + `hfHub.js` /
`routes/hf.js` unless noted.

## 1. Tab-based browsing instead of sort chips
Replace the Trending/Most-downloads/Most-likes/Recently-updated sort chips
with tabs: **Unsloth** (default landing tab — everything they've shipped,
newest first) · **Popular** (last ~30 days, from the big names: Kimi, GLM,
Qwen, DeepSeek, Llama, etc.) · **Image** · **Audio** (music included) ·
**Video**. Default tab is a per-user setting in Settings (default: Unsloth),
so a different user can make Popular (or anything else) their landing tab.
- Unsloth tab: `searchModels('', { sort: 'lastModified' })` filtered to
  `unsloth/*` owner, or a dedicated author-scoped HF query.
- Popular tab: needs a "big name" owner allowlist + a `lastModified`/date
  cutoff (~30 days) combined with trending sort — HF's API doesn't have a
  single param for this, will need to fetch trending and filter client- or
  server-side by owner + recency.
- Wire `prefs.hubDefaultTab` (or similar) into `prefs.svelte.js`, add a
  Settings row next to the existing Sidebar-navigation section.

## 2. Projected TPS based on hardware
Before download, estimate tokens/sec for the picked quant on this box's
actual hardware (VRAM free, GPU model, RAM) — same idea as LlamaDash's TPS
predictor (see `moe_offload_tuning.md` / `speculative_decoding.md` /
`llamadash_tps_calibration.md` memory notes for the model that already
exists there; check whether its logic/data is reusable or needs its own
simpler heuristic here since DuckPond doesn't have LlamaDash's calibration
harness). Show as a stat chip next to the VRAM-fit warning in the variant
picker.

## 3. Model card avatars (org/user PFP, not screenshots)
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
- ~~Trending/search returning nothing on load~~ — fixed 2026-08-30, `doSearch()`
  and the server route both required a non-empty `q`; empty query is a valid
  "browse" call.
- ~~Quant-maker step (unsloth vs bartowski vs mradermacher etc.)~~ — shipped
  2026-08-30 via `findQuantizers()` / `base_model:quantized:` HF filter.
- ~~`Shard_Rewrite` junk folder winning the default-smallest-quant pick~~ —
  fixed 2026-08-30, `groupVariants()` now drops any subfolder with zero real
  `.gguf` files before ranking by size.
