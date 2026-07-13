# DuckPond backlog — who does what

Durable index of outstanding work (the live task tracker is ephemeral). Each item
lists its **tier** and the **handoff note** with the real detail. Tiers:
**Fable** = big architecture / craft, **Opus** = hard, done-right, **Sonnet** =
grind / repeats a known pattern.

## Fable (architecture / craft)
- **Core system prompt rewrite** — make it insanely good, small-model-calibrated.
  → `CORE-PROMPT-FABLE.md`
- **Memory / semantic recall** — embeddings service, message_vectors, cosine +
  FTS5 fallback. Blocked on an embed model / router `--embeddings`.
  → `MEMORY-RETRIEVAL-FABLE.md`
- **Widgets visual-cohesion pass** (Phase 5) — one design language across all
  widgets, light/dark. → `WIDGETS-AND-RESEARCH-PLAN.md` (§E Phase 5)

## Sonnet (grind / known pattern)
- **Build llama.cpp with diffusion-gemma support** — compile PR #24423 (EB
  decoder flags); installed binaries predate the arch. → `BUILD-DIFFUSION-GEMMA.md`
- **Stats dashboard frontend** — render `/api/stats`. → `EXTRA-STATS-DASHBOARD-SONNET.md`
- **TTS** — read replies aloud via piper. → `EXTRA-TTS-SONNET.md`
- **MCP support** — stdio JSON-RPC client, namespaced `mcp__server__tool`, plug
  into the inline tool loop (not a parallel one). → `MCP-SONNET.md`
- **Widgets Phase 2 embeds** — youtube / reddit / github / images widgets, once
  the Phase 1 framework exists. → `WIDGETS-AND-RESEARCH-PLAN.md` (§E Phase 2)
- **Dynamic welcome suggestions** — qwen3.5-2b generates prompt chips from chat
  history for the Welcome screen (`Welcome.svelte`, small resident model, cheap,
  cache per session). *No separate note — this line is the spec.*

## Opus (hard / done-right — mostly the widgets build)
- **Widgets Phase 0** — search hard-cap 200 + thinking watchdog.
- **Widgets Phase 1** — framework + weather + map + location. *(in progress)*
- **Widgets Phase 3** — chart widgets (LayerChart) + download-as-PNG.
- **Widgets Phase 4** — Ultra Research mode.
  → all in `WIDGETS-AND-RESEARCH-PLAN.md`
- **Mermaid diagram widget** — `create_diagram` tool → a `mermaid` widget type
  (render + copyable source + PNG export). Folds into the widget framework as
  one more type; see the widgets plan. *This line is the spec.*

## Done (for reference)
Web search + Perplexity-style citations (Opus), GPU queue / two-user concurrency,
in-chat image gen, diffusion-in-chat wiring (blocked only on the gemma binary),
SearxNG deploy. See git log.

---
**Standalone plans stay separate.** This index just links them; it does not merge
`EXTRAS-PLAN.md`, `DIFFUSION-HANDOFF.md`, or the per-tier notes into one. Point a
model at the specific note for its task.
