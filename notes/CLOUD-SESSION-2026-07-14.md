# Cloud session status — 2026-07-14 (Fable, remote container)

**Read this together with `notes/WHATS-LEFT-2026-07-14.md`** (the previous
session's handoff — its mission rules still apply: attempt everything,
hardest-first). This doc records what a *cloud* session did on top of it and
what still needs the real machine.

**Where the code is:** everything below is committed and pushed to branch
**`claude/markdown-instructions-review-pfjdjf`** on
`github.com/CrankyVase/duckpond`. It is NOT on `main` yet and NOT deployed —
the public site on the host (port 3001) still runs the old build until someone
on the host pulls, builds, and restarts (exact commands below).

**What this session could and couldn't do:** it ran in an isolated cloud
container — full code access, `node --check` + `vite build` + logic-level tests
all pass, but **no GPU, no live llama-server, no browser, no access to the host
machine**. So nothing here has been verified against a real model yet. Also
note: huggingface.co was blocked by the *container's* egress allowlist; the
host has open internet (the widgets already hit CoinGecko/Open-Meteo), so the
new HF lookup is expected to work there but is untested end-to-end.

---

## Shipped this session (on the branch, build-verified)

1. **Dashboard widget — generative UI extended (triage item 7 / EPIC 3).**
   New `show_dashboard` tool: the model composes 2-8 existing widgets into one
   titled grid (`panels: [{ tool, args, wide }]`). Panel builders run in
   parallel; a failed panel renders as an error tile instead of sinking the
   grid; all-fail and <2 panels throw back to the model. Gated behind models
   ≥9B *total* params (`modelParamsB` in `server/src/modelDescribe.js`) — below
   that the tool is neither offered nor described; the per-model tool toggle in
   Settings works on top. Files: `routes/chat.js` (tool schema, `dashboardPanels`,
   gate where `disabledTools` is built), `widgets.js` (`makeDashboardWidget`),
   `toolCatalog.js`, `web/.../widgets/DashboardWidget.svelte` (recursive through
   the `Widget` dispatcher), `Widget.svelte`. Verified at logic level by
   exercising `WIDGET_BUILDERS.show_dashboard` directly (pure panels + failure
   paths); NOT yet verified with a live model.

2. **Mirostat + GBNF grammar / JSON-schema constrained output (triage item 8).**
   Per-model settings (same `model_settings` row): `mirostat` 0/1/2 with
   tau/eta sliders, and a "Structured output" section with GBNF grammar and
   JSON schema textareas — all llama.cpp-native, passed straight through to
   llama-server. Key behavior: a grammar/schema constrains the WHOLE reply, so
   a constrained turn runs plain — no tools offered, no tool policy in the
   system prompt (see `constrained` in `routes/chat.js`). Schema wins if both
   set; invalid schema JSON is rejected on save (client) and at request time
   (server). Files: `routes/models.js` (DEFAULT_SETTINGS), `routes/chat.js`,
   `SettingsPanel.svelte`.

3. **Model descriptions from real Hugging Face model cards (old explicit ask).**
   New `server/src/modelCards.js`: searches HF for each local gguf id (quant
   tokens stripped), demands ≥60% name-token match so a wrong card never beats
   the filename heuristic, pulls the README and extracts the first real prose
   paragraph (front-matter/badges/HTML/lists/code fences skipped). Cached in a
   new `model_cards` table (auto-created by `db.js`) for 30 days with negative
   caching; lookups run serially in the background so `/api/models` never
   blocks. The picker's info icon links to the card when found. Heuristics
   remain the instant fallback. **Untested against live HF from here** (egress
   blocked in the container) — the extraction/scoring logic is unit-tested.

4. **Agent-run image progress fix: code-verified.** Traced the full chain
   (agent.js `execTool` store:false emits → chat.js subscribeRun forward →
   Chat.svelte top-level `image_job/…` handlers → `imgjob` UI renders
   independently of the run feed). Coherent end-to-end; still needs the
   original browser-watch verification on the host (below).

## Left to do (mission order)

5. **Stats dashboard redo — IN PROGRESS, not committed.** Plan settled:
   extend `GET /api/stats` with `daily` (last 30 days: tokens in/out, requests,
   tok/s per day, gaps filled), user-scoped `counts` (chats, messages,
   memories, documents, images, agent runs — all tables have `user_id`), and
   `vram` (from `gpuVram()` + loaded model list). Client: stat-tile row
   (+VRAM meter), 30-day activity bar chart, tok/s trend line, keep per-model
   bars + table. House style: single accent hue, thin marks with 2px gaps,
   rounded data ends, hover tooltips, no legend for single series.
6. **Final UI decluttering pass** — deliberately after features; voice orb
   placement explicitly called out by the user.
7. **Mobile pass** — sidebar→drawer, composer, widgets, orb, settings.
8. **Themes** — on the CSS variables in `web/src/app.css`, picker in Settings.

---

## For the model on the HOST computer (needs the real machine)

### A. whisper.cpp one-time build — do this first
The user is seeing "Speech-to-text is not installed on the server yet" from
the voice orb. Everything else about voice mode is wired and waiting. The
model file is already at `/home/lewis/whisper-models/ggml-base.en.bin`. Build:

```
distrobox enter llamabuild -- bash -c '
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/src/whisper.cpp &&
  cd ~/src/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release &&
  cmake --build build -j24'
mkdir -p /home/cranky/bin/whisper-prebuilt
cp ~/src/whisper.cpp/build/bin/whisper-cli /home/cranky/bin/whisper-prebuilt/
cp ~/src/whisper.cpp/build/src/libwhisper.so* ~/src/whisper.cpp/build/ggml/src/libggml*.so /home/cranky/bin/whisper-prebuilt/ 2>/dev/null || true
```

Then `GET /api/voice/status` should flip to `{"stt":true}`, and talking to the
orb in a browser should work. (`server/src/stt.js` expects the binary at
`/home/cranky/bin/whisper-prebuilt/whisper-cli` with its .so files beside it.)

### B. Deploy the new code to the public site
The user asked for the publicly hosted site to get the new stuff. Once this
branch is merged to main (or checked out directly):

```
cd <repo>
git fetch origin
git checkout claude/markdown-instructions-review-pfjdjf   # or main after merge
git pull
cd web && npm install && npx vite build
systemctl --user restart duckpond.service    # runs as user cranky
curl -s localhost:3000/api/health            # sanity
```

The new `model_cards` table is created automatically on server start.

### C. Live verification checklist (in order of value)
1. **Agent-run image progress in a real browser** — start a project-mode task
   that generates an image; the shimmer/steps/preview must appear during the
   run (plain chat already verified last session).
2. **Dashboard widget** — on a capable model (e.g. qwen3-6-27b or the 35b-a3b):
   "give me a Tokyo trip overview" should produce ONE dashboard card (weather +
   map + currency…), not scattered widgets. On a <9B model the tool must not
   be offered at all. Check Settings→Tools shows the "Dashboard" toggle.
3. **Mirostat / grammar** — Settings→Generation: set Mirostat v2 and chat
   (reply should stream normally); set GBNF grammar `root ::= "yes" | "no"`
   and confirm the reply is exactly yes/no and that NO tools fire; clear it.
4. **HF model cards** — after the server has been up a few minutes, hover the
   info icon in the model picker: real descriptions with a link to the HF
   repo. `SELECT model_id, repo, ok FROM model_cards;` to see matches. If a
   card is wrong for some model, deleting its row re-fetches after restart.
5. **Speculative tool calling / memory / RAG / TTS** — all verified last
   session, no changes here; only regression-check if something looks off.

### D. Session habits (unchanged)
Commit + push after every slice; verify live with curl against :3000 (mint a
session via `createSession` from server/src/auth.js against the ducktest
user); one GPU — never load a second model casually; no emoji in UI.
