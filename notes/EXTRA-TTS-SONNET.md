# TTS (read replies aloud) — handoff for SONNET (engine + endpoint + UI)

New feature, self-contained. Grind-tier. ~1 session incl. a voice download.

## Engine: piper (local, fast, CPU-only — no GPU contention)
- Install piper (binary release from rhasspy/piper, or `pip install piper-tts`
  inside a venv — check what works on this atomic OS; a static binary under
  `/home/cranky/bin/` is cleanest).
- Download one voice, e.g. `en_US-amy-medium` (.onnx + .onnx.json) to
  `/home/lewis/tts-voices/`. Add env `PIPER_BIN`, `PIPER_VOICE`.
- Sanity check: `echo "quack" | piper -m <voice>.onnx -f /tmp/out.wav` plays.

## Server
- New `server/src/tts.js`: `synth(text) -> wav buffer` (spawn piper, stdin text,
  stdout/-f wav). Guard length (~2000 chars), one job at a time is fine.
- New `server/src/routes/tts.js`: `POST /api/tts` `{ text }` (or `{ messageId }`
  → look up message content) → `reply.type('audio/wav').send(buffer)`. requireAuth.
- Register in `index.js`. **Cache** by hash(text+voice) on disk to avoid
  re-synth (store under a tts-cache dir; serve if present).

## Frontend
- Add a small speaker play/stop button to assistant messages in
  `Message.svelte` (custom pixel-art sprite per house rule — NO emoji). On click:
  `fetch('/api/tts', {text})` → `new Audio(URL.createObjectURL(blob))` → play;
  toggle to stop. Show a subtle playing state.
- Optional: a global "auto-read replies" toggle in prefs + SettingsPanel.

## Notes
- Piper is CPU — won't fight the GPU chat/image/diffusion jobs. Good.
- Keep it a per-message on-demand action first; auto-read is a nice-to-have.
- Strip markdown before synth (code blocks, links) so it doesn't read syntax.
