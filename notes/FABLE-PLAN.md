# DuckPond — the Fable deep-end plan

The ambitious, architecturally-hard backlog, routed to **Fable** (top tier: big
design, systems that touch many parts at once, things that need real judgment to
get right). Each epic below is a *system*, not a feature — they rewire how DuckPond
thinks, remembers, or acts. Pick one, design it end-to-end, ship it in slices.

Stack recap (what you're building on): Fastify + Svelte 5 + SQLite (better-sqlite3),
a llama.cpp **router** on :8081 that hot-loads one GGUF at a time on a single AMD
GPU, a **podman** project sandbox (routes/agent.js), the **inline tool loop**
(`runInlineSearch` in routes/chat.js) that already runs web-search + 21 widgets,
SearxNG on :8888, and the message-tree DB. Existing Fable notes:
`CORE-PROMPT-FABLE.md`, `MEMORY-RETRIEVAL-FABLE.md`. Standing constraints: one GPU
(serialize or the router thrashes), small local models (2B–35B), no emojis in UI
(pixel/SVG), the GPU queue is currently OFF (`DUCKPOND_GPU_QUEUE=1` re-enables).

---

## EPIC 1 — The Council: intelligent multi-model orchestration
**Vision.** The user already thinks in model tiers. Make DuckPond do it
automatically: every turn, route to the *right* resident model, escalate when a
cheap model is unsure, and for hard questions convene a short **debate/ensemble**
that beats any single small model.

**Features**
- **Router-classifier.** A tiny always-warm model (qwen3.5-2b) classifies each turn:
  difficulty, domain (code/math/creative/factual), needs-tools?, needs-vision? →
  picks the target model. Cache the decision; show it as a subtle chip ("routed to
  qwen3-6-27b · hard/coding").
- **Confidence-gated escalation.** Cheap model answers first; a self-rated
  confidence (logprob heuristic or a 1-token self-check) below threshold silently
  re-runs on the big model. User sees "double-checking with a stronger model…".
- **The Council (hard questions).** Fan out the SAME prompt to 2–3 models (or the
  same model at different temperatures), then a **judge** pass synthesizes/critiques
  and returns the best answer with a short "why". This is the single biggest quality
  lever on small local models.
- **Speculative drafting.** Small model drafts, big model verifies/edits — faster
  than big-model-from-scratch for many turns.

**Architecture.** New `server/src/orchestrator.js`: `route(turn) → {model, mode}`;
`council(prompt, models) → {answer, transcript}`. Sits in front of `streamChat`.
Must respect the **single GPU**: council = sequential model loads (expensive) →
gate behind Ultra/"best effort" mode, or only when models are already resident.
Stream each stage so the user watches the deliberation (reuse the SearchTrace-style
disclosure). Persist the transcript for replay.

**Hard parts / why Fable.** Confidence estimation on local models is genuinely
tricky; the GPU-serialization cost of multi-model turns needs a smart budget; the
judge prompt is prompt-engineering craft. Get the routing wrong and everything
feels worse.

---

## EPIC 2 — Long-term memory & a personal knowledge graph
Extends `MEMORY-RETRIEVAL-FABLE.md` from "semantic recall" to a real memory system.

**Vision.** The duck *knows you* — your projects, preferences, people, decisions —
across conversations, and uses it without being creepy or wrong.

**Features**
- **Two-store memory.** *Episodic* (what happened: auto-summarized conversation
  facts, timestamped) + *semantic* (durable facts about the user/world). Write path:
  after each turn a cheap model extracts candidate memories → dedup → store.
- **Per-user profile** the model can read each turn ("you're Lewis, you build
  DuckPond, you prefer terse answers, no emojis…"), auto-maintained, user-editable
  in Settings (transparency + control).
- **Knowledge graph.** Entities (people/projects/tools) + relations, built from
  extracted memories; powers "what do you know about X" and disambiguation.
- **RAG-every-turn.** Retrieve top-k relevant memories (vector + FTS5 hybrid) and
  inject a compact "relevant context" block, budgeted against the context bar.
- **Forgetting & provenance.** Every memory shows where it came from and can be
  edited/deleted; decay for stale episodic items.

**Architecture.** Needs an **embedding model** (the router 501s on `/v1/embeddings`
— start a dedicated `llama-server --embeddings` on a side port, or a small ONNX
embedder on CPU so it never fights the GPU). Tables: `memories(user_id, kind, text,
embedding, source_msg, created_at, strength)`, `entities`, `edges`. Hybrid search =
cosine (JS) ∪ FTS5. Hook into `buildPrompt` in routes/chat.js.

**Hard parts / why Fable.** Extraction precision (garbage memories poison every
future turn), dedup, the privacy/trust surface, and keeping the injected context
small. This is the feature most likely to make DuckPond feel magical *or* broken.

---

## EPIC 3 — Generative UI: the model builds live interactive things
**Vision.** Go past the 21 fixed widgets: let the model **compose and update**
interactive UI on the fly — dashboards, mini-apps, forms, simulations — rendered
safely in-chat, stateful, and able to talk back to the model.

**Features**
- **Composable dashboards.** The model emits a *layout* of existing widgets (grid,
  tabs, rows) as one unit — e.g. a "trip planner" = map + weather + currency + a
  checklist, arranged and titled.
- **Interactive feedback loop.** Widgets raise events back to the model: click a
  chart bar → "tell me about Q3"; toggle a filter → the model re-issues a tool call
  and the widget updates **in place** (no new message). Needs a widget→server→model
  channel over the existing SSE.
- **Model-authored components (sandboxed).** For the truly custom case, the model
  writes a small declarative spec (or sandboxed JS in an iframe/worker, CSP-locked)
  that renders a bespoke interactive element — a unit converter, a quiz, a physics
  toy. This is DuckPond's answer to Claude Artifacts, but inline and local.
- **Live/streaming widgets.** Crypto/stock/countdown that refresh; a "watch" that
  re-runs a tool on an interval and animates deltas.

**Architecture.** Builds directly on the widget framework (`Widget.svelte`,
`duckwidget` blocks, `runInlineSearch`). Add a `dashboard` widget type (nested
widget tree) and a `widget_event` SSE→POST path that re-enters the tool loop with
the event as context. Sandboxed custom code = iframe with a strict CSP + a tiny
message-passing API; **never** eval in the main page.

**Hard parts / why Fable.** The event/update loop (mutating a rendered widget
mid-conversation) touches the streaming model, persistence, and reactivity at once;
the sandbox security model must be airtight; deciding declarative-spec vs sandboxed-JS
is a real design fork.

---

## EPIC 4 — Autonomous research workspace (Ultra research, evolved)
**Vision.** Ultra mode today reads up to 400 pages and answers. Make it **build a
living research artifact**: a structured, cited, drill-downable report that improves
as it researches.

**Features**
- **Plan → sub-agents → synthesize.** Decompose the question into sub-questions,
  spawn a lightweight researcher per sub-question (sequential on one GPU), each
  returning cited findings; a synthesis pass composes the report.
- **Living document.** A right-hand panel that fills in real time: outline → sections
  → citations, with a source list and confidence per claim. Reuses the agent
  event-stream pattern (routes/agent.js `subscribeRun`).
- **Verification pass.** A dedicated critic re-checks key claims against sources,
  flags unsupported statements, and asks for another search round if weak.
- **Contradiction surfacing.** When sources disagree, show both and say so.
- **Export.** The report → Markdown/PDF; the research graph → a saved artifact.

**Architecture.** Generalize `runInlineSearch` into a `researchRun` with a
plan/queue/scratchpad, streaming into a new `ResearchPanel.svelte`. Persist
sub-findings so a long run survives reload. Budget the 400-read cap across
sub-agents.

**Hard parts / why Fable.** Orchestrating many sequential sub-agents on one GPU
without it taking an hour; the verification/critic loop; keeping the living doc
coherent while streaming. This is agentic-systems design.

---

## EPIC 5 — Voice: the duck you can talk to
**Vision.** Full hands-free conversation with the duck — speak, it listens, thinks,
and talks back, with barge-in.

**Features**
- **STT** via whisper.cpp (there's already a whisper-capable stack around); push-to-
  talk first, then wake-word ("hey duck").
- **Streaming TTS** via piper (already routed to Sonnet in `EXTRA-TTS-SONNET.md` —
  Fable owns the *realtime duplex* version): speak sentences as they stream.
- **Barge-in.** User talking interrupts playback and starts a new turn.
- **Voice-reactive duck.** The mascot lip-syncs / bobs to TTS amplitude (ties into
  the existing Duck.svelte mood engine).
- **Full-duplex loop.** VAD → STT → model (with tools!) → TTS, all streaming, with
  clean turn-taking.

**Architecture.** whisper.cpp + piper as side services (CPU where possible to spare
the GPU). WebAudio capture + a VAD in the browser; stream audio to a `/api/voice`
socket; reuse the chat pipeline for the brain. State machine for turn-taking is the
crux.

**Hard parts / why Fable.** Realtime turn-taking, barge-in, and latency budgeting
across STT/LLM/TTS on constrained hardware is a genuine systems problem.

---

## EPIC 6 — Document RAG / your own knowledge base
**Vision.** Drop in PDFs, notes, code, a whole folder — then chat over them with
citations back to the exact page/chunk.

**Features**
- **Ingestion pipeline.** Upload → extract (pdf/docx/txt/code/html) → smart chunk →
  embed → store, with progress in the UI.
- **Collections.** Group docs; scope a conversation to a collection.
- **Cited answers.** Retrieved chunks power the answer; citations link to the source
  chunk with a preview (reuses the citation-pill pattern).
- **"Chat with this page/file"** from anywhere; drag-drop into the composer.

**Architecture.** Same embedder as Epic 2. Tables: `documents`, `chunks(embedding,
doc_id, page, text)`. Retrieval merges into the prompt like memory does. Parsing is
the grind (route the parsers to Sonnet; Fable designs the pipeline + retrieval).

**Hard parts / why Fable.** Chunking strategy and retrieval quality make or break
it; scoping/permissions in a multi-user instance; keeping it fast on SQLite.

---

## EPIC 7 — Proactive automations: the duck does things on its own
**Vision.** Move from reactive chat to an assistant that acts on a schedule or a
trigger — morning briefings, "watch this repo/site and ping me," recurring digests.

**Features**
- **Automation builder.** "Every morning, summarize HN + my starred repos' releases
  + weather" → a saved job. Natural-language → a structured schedule the user can
  edit.
- **Triggers.** Time (cron), or event (a page changed, a price crossed X, a new
  release). Each run is a normal tool-using agent turn.
- **Delivery.** Results land as a new conversation / a notification / an emailed
  digest. Ties into the widget system for rich output.
- **Guardrails.** Runs are sandboxed, rate-limited, GPU-scheduled off-peak, and fully
  visible/editable.

**Architecture.** A scheduler (node-cron or a DB-backed tick loop) → enqueues agent
runs → results persisted + surfaced. Careful GPU scheduling so automations never
fight interactive use.

**Hard parts / why Fable.** Turning fuzzy NL into reliable recurring jobs; safe
autonomous execution; GPU contention with live users.

---

## EPIC 8 — Multimodal vision
**Vision.** "Look at this" — paste a screenshot, photo, diagram, and the duck sees it.

**Features.** Image understanding via the resident omni/vision models
(nemotron-omni etc.): describe, extract text/tables, answer about an image, critique
a design, read a chart back into a `chart` widget. Drag-drop images into the
composer; the vision model routes via the Council (Epic 1).

**Hard parts / why Fable.** Wiring image inputs through the router/template for
vision GGUFs, and the router/Council integration.

---

## Cross-cutting: a self-improvement / eval harness
Underneath several epics sits the same need: **measure**. A small harness that runs
a fixed prompt suite against resident models + prompt variants, scores them
(exact-match, a judge model, latency), and tracks regressions — this is how the core
prompt (`CORE-PROMPT-FABLE.md`), the Council judge, and memory extraction actually
get *good* instead of vibes. Build it early; it pays for itself across every epic.

---

## Suggested order (impact × leverage)
1. **Memory (Epic 2)** — makes everything else feel personal; unblocks RAG (6).
2. **The Council (Epic 1)** — biggest single quality jump on small models.
3. **Generative UI (Epic 3)** — the "wow", and it builds on the shipped widgets.
4. **Research workspace (Epic 4)** — evolves Ultra mode you already have.
5. Then Voice / RAG / Automations / Vision as appetite allows.

Each is a slice-able program, not a weekend. Design first (data model + the one hard
part), ship the thin vertical, then widen. Point Fable at this file per-epic.
