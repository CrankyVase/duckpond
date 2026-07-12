# Diffusion LLM — handoff (2026-07-12, Sonnet stopping here per user)

User wants this folded into **normal chat**, not a separate tab: diffusion
gguf shows up in the regular model picker like any other model; picking it
and sending a message streams the live denoising text right in the chat
thread (same spirit as the in-chat image generation). Remove DiffusionLab.svelte,
its topbar button, and the `diffusion` view from App.svelte once this is wired
— they were built as a standalone tab before this decision and are no longer
wanted as a separate surface.

## State right now
- Both prior model files were **broken** and have been deleted:
  - `llada-8b-q4km.gguf` — corrupted (`tensor 'blk.21.ffn_up.weight' data is
    not within the file bounds`), confirmed by direct CLI load attempt.
  - `diffusiongemma-26B-A4B-it-Q4_K_M.gguf.part` — stalled partial download
    (16.8GB, hadn't grown in ~21h, no download process running).
- User is re-downloading diffusion-gemma themselves and will say when it's
  ready. **Drop new diffusion downloads in
  `/home/lewis/llm-models/llama.cpp-models/diffusion/`** — that directory is
  already excluded from `sync-model-ini.sh` (the new auto-model-add watcher,
  see `/home/lewis/bin/sync-model-ini.sh`) so a diffusion gguf never gets
  mistakenly registered as a normal router chat model.
- Binary confirmed working: `/home/cranky/bin/llama-prebuilt/b9966-vulkan/llama-diffusion-cli`
  (built from source, Vulkan). **`--no-warmup` is NOT a valid flag on this
  build** — the old `routes/diffusion.js` passed it and would have failed
  immediately on every run (this whole feature was never actually smoke
  tested end to end before now — task #19 sat "in_progress" the whole time).
  Confirmed valid flags via `--help`: `-m -p -n --diffusion-steps
  --diffusion-visual --diffusion-algorithm --diffusion-eps
  --diffusion-alg-temp --diffusion-block-length --diffusion-cfg-scale
  --diffusion-add-gumbel-noise -ngl --system-prompt/-sys`.
- Good news on templating: the CLI has its own `-sys/--system-prompt` flag
  ("system prompt to use with model (if applicable, depending on chat
  template)") — so it likely applies the gguf's baked-in chat template
  itself when you pass `-sys` + `-p`, same as regular llama-server. This
  resolves the "does LLaDA-instruct need a hand-built chat template" open
  question from the previous session — just pass system + latest user turn
  via `-sys`/`-p` and let the binary handle templating; don't hand-roll one.
- `--diffusion-visual` was NOT tested yet for tty-requirement (the open risk
  noted previously: it may need a real pty to emit progressive frames,
  fallback is wrapping the spawn in `script -qec '<cmd>' /dev/null`). Test
  this first thing once a working gguf exists — it's the crux of "watch it
  diffuse."

## Design already settled (do this)
1. New shared module `server/src/diffusiongen.js` (replaces
   `routes/diffusion.js`, which should be deleted along with its
   registration in `index.js`): export `listDiffusionModels()` (scan
   `DIFFUSION_MODELS_DIR` for `.gguf`, same logic as the old `ggufModels()`)
   and `generateDiffusion({ prompt, systemPrompt, model, onFrame, signal })`
   — port the spawn/parse/throttle logic straight from the old
   `routes/diffusion.js` (ANSI/CLEAR-frame parsing, ~8fps throttle, kill
   timer, abort-on-close), just restructured as a callback API instead of
   writing SSE itself, so `chat.js` can drive it.
2. `server/src/routes/models.js` `GET /api/models`: merge in virtual entries
   for each diffusion gguf — `{ id, status: 'unloaded', args: [], ctxSize:
   null, engine: 'diffusion', settings: modelSettings(id) }` — concatenated
   onto the normal router model list. `ModelPicker.svelte` needs no changes
   to just list/select them (it already falls back to "on disk" for any
   non-resident status and only shows load/eject buttons for
   loaded/sleeping/loading status, which these will never have).
3. `chat.js`'s `POST /api/conversations/:id/chat`: right after loading
   `conv`, check `isDiffusionModel(conv.model_id)` (import from
   `diffusiongen.js`) and branch into a dedicated path *before* the normal
   `streamChat`/tools flow — diffusion turns are single-shot, no tools, no
   agent loop. Insert the user message as normal, then call
   `generateDiffusion` with `onFrame` sending `{ type: 'diffusion_step', n,
   steps, text }` over the existing SSE `send()`, and on completion insert
   the assistant message with the final text + `send({ type: 'done', msg
   })` exactly like the normal path does, so everything downstream (title
   generation, context bar, message persistence) keeps working unmodified.
4. Frontend: add `diffusion_step` handling in `Chat.svelte`'s `handleEvent`
   (mirrors the existing `image_progress`/`image_preview` pattern already
   there) — store the latest step text on `app.streaming.diffusion = {
   step, steps, text }`, render it as a live text block (monospace,
   `white-space: pre-wrap`) in place of the normal streaming markdown body
   until `done` arrives. Duck mood: reuse `thinkhard` or consider a new
   mood if it feels right — not decided, judgment call for whoever picks
   this up.
5. Delete `DiffusionLab.svelte`, `web/src/lib/diffusion.svelte.js`, the
   `FlaskConical` topbar button + `'diffusion'` case in `Topbar.svelte`, and
   the `{:else if app.view === 'diffusion'}` branch in `App.svelte`.

Everything else (image gen, duck reaction catalog, auto-model-sync) shipped
this session and is deployed — this is the one open thread.
