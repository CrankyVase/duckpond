# What's left — handoff for the next AI (Fable)

**Date: 2026-07-14.** Written by Fable 5 at the end of a long build session.
The mission is `notes/FABLE-TRIAGE-2026-07-13.md` (read it first — it has the
user's two firm rules: **attempt everything, hardest-first**) plus a mid-session
addendum from the user captured below. Everything below is committed and pushed
to `github.com/CrankyVase/duckpond` main.

---

## Shipped and verified this session (don't redo)

1. **TTS foundation** — piper synth module w/ disk cache (`server/src/tts.js`),
   `POST /api/tts`, read-aloud button on replies. Verified via curl.
2. **Voice mode (EPIC 5)** — full engine in `web/src/lib/voice.svelte.js`:
   AudioWorklet 16 kHz capture, energy VAD w/ adaptive noise floor + pre-roll,
   utterance → `/api/voice/transcribe` → normal chat pipeline → sentence-chunked
   TTS playback, barge-in aborts the stream. `VoiceOrb.svelte` reacts to BOTH
   sides (green ring = user mic level, warm core = duck TTS level, conic spin =
   thinking). Trigger: composer AudioLines button. **Blocked on one thing** —
   see "whisper.cpp" below.
3. **Speculative tool calling** — `makeSpeculator` in `routes/chat.js` fires
   web_search/fetch_page the moment the arg string closes in the streaming
   tool-call JSON. Verified live (speculative hit logged 1.1 s early).
4. **Embedding service** — `duckpond-embed.service` (systemd user unit):
   llama-server `--embeddings`, nomic-embed-text-v1.5 Q8, CPU-only on :8083,
   `-ub 2048` (needed for long inputs). Client: `server/src/embed.js`.
5. **Semantic conversation search** — message vectors + FTS5 hybrid
   (`server/src/memory.js`, `GET /api/search`), Sidebar deep search on Enter.
   Whole history backfilled. Verified by meaning ("video card memory release"
   found llama.cpp chats).
6. **Long-term memory + Ebbinghaus decay** — extraction after each turn
   (quote-verified against the user's message; hallucination-proofed — see the
   FACT:/FROM: format in memory.js), retrieval injected at the TOP of the
   system prompt with wording that overrides the "no access to personal info"
   reflex (that wording is load-bearing, tested), reinforcement on retrieval,
   `exp(-age/(10d × strength))` decay + prune sweep. Settings → Memory shows
   the toggle + everything remembered w/ retention % + forget buttons.
   Verified end-to-end on qwen3-6-27b. **Known caveat:** lfm2-24b-a2b ignores
   the injected block (weak long-prompt instruction following) — model issue,
   not pipeline.
7. **Document RAG (EPIC 6 vertical)** — composer paperclip is real: PDFs via
   host pdftotext, text/code direct; chunk+embed; per-conversation attach
   (chips above composer); per-turn excerpt injection with doc-name citations
   and honest "couldn't find it" instruction. Verified live incl. a real PDF.
8. **PPTX + CSV export** — `generate_slides` (pptxgenjs, themed deck) and
   `export_csv` tools → files in `data/exports/<user>/` behind an
   ownership-checked route, rendered as a new `file` widget download card.
   Verified live (model built a 4-slide deck from one prompt).
9. **Live image progress in agent runs (bug fix)** — project-mode
   generate_image had NO progress callback, so the user saw nothing while an
   image generated. Now streams transient (store:false) image_job/progress/
   preview/done run events, forwarded in chat.js to the same imgjob UI plain
   chat uses. Plain-chat path verified live (68 progress + 4 preview frames);
   **agent-run path is code-complete but not yet watched in a browser — verify
   it first.**

## The one hard blocker — whisper.cpp (voice can talk but not hear)

The permission classifier twice denied cloning/building whisper.cpp, so STT is
NOT installed. Everything else is wired and degrades cleanly (the orb explains
what's missing). The model is already downloaded
(`/home/lewis/whisper-models/ggml-base.en.bin`). The user (or a session with
permission) needs to run, using the same distrobox as the llama.cpp builds:

```
distrobox enter llamabuild -- bash -c '
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/src/whisper.cpp &&
  cd ~/src/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release &&
  cmake --build build -j24'
mkdir -p /home/cranky/bin/whisper-prebuilt
cp ~/src/whisper.cpp/build/bin/whisper-cli /home/cranky/bin/whisper-prebuilt/
cp ~/src/whisper.cpp/build/src/libwhisper.so* ~/src/whisper.cpp/build/ggml/src/libggml*.so /home/cranky/bin/whisper-prebuilt/ 2>/dev/null || true
```

`server/src/stt.js` expects `WHISPER_BIN` (default
`/home/cranky/bin/whisper-prebuilt/whisper-cli`) with its .so files beside it
(LD_LIBRARY_PATH is set to the binary's dir). Test: `GET /api/voice/status`
should flip to `{"stt":true}`, then talk to the orb in a browser.

## Remaining work, in order (user's rules: attempt all, hardest first)

1. **Verify the agent-run image fix in a real browser** (bug #80, above).
2. **Generative UI extended (triage item 7 / EPIC 3)** — `dashboard` widget
   type nesting existing widgets in a model-authored layout; gate behind
   capable models. Widget plumbing: `server/src/widgets.js` (`widget()` maker),
   `WIDGET_BUILDERS`/`WIDGET_TOOLS`/`WIDGET_LINES` in routes/chat.js,
   `toolCatalog.js`, dispatcher in `web/src/components/Widget.svelte`.
3. **GBNF grammar + Mirostat exposure (triage item 8)** — per-model settings
   (`model_settings` table via routes/models.js `modelSettings`) for
   mirostat/mirostat_tau/mirostat_eta + optional `grammar`/`json_schema`
   passthrough in the `params` object in routes/chat.js; UI in
   SettingsPanel.svelte next to temperature etc.
4. **Model-description script** (old task) — auto-generate model descriptions
   from Hugging Face model cards, replacing the heuristics in
   `server/src/modelDescribe.js`. User asked for this explicitly.
5. **Stats dashboard redo** — nicer + more useful (per-model usage, tok/s
   trends, daily activity, memories/search/docs counts, VRAM). Current:
   `StatsPanel.svelte` + `routes/stats.js`.
6. **Final UI decluttering pass** — LAST, deliberately, with all new buttons in
   view (voice trigger, paperclip chips, exports...). The user wants it
   "more professional"; voice orb placement is explicitly called out.
7. **Mobile pass** — full functionality on phones (sidebar → drawer, composer,
   widgets, orb, settings). User: "intuitive and awesome, as much functionality
   as on PC."
8. **Themes** — AFTER the UI redo: theme system on the existing CSS variables
   in `web/src/app.css` (current warm-dark becomes one of several; add a
   picker in Settings).

Explicitly out of scope (user decision, unchanged): Google Slides OAuth
integration (PPTX export covers it) and adaptive model routing (EPIC 1).

## Session habits the user expects

- **Commit + push to GitHub after every slice** ("push as you work in case we
  screw stuff up").
- Verify live with curl against :3000 before calling anything done (mint a
  session: `createSession` from server/src/auth.js against the ducktest user).
- One GPU: never load a second model casually; embed service is CPU-only on
  purpose. Piper/whisper are CPU on purpose.
- Build: `cd web && npx vite build`, then `systemctl --user restart
  duckpond.service` (runs as user cranky), health at `/api/health`.
- No emoji in UI; lucide icons match the existing style.
- The user drops mid-session scope additions — fold them into the task list,
  don't restart the plan.
