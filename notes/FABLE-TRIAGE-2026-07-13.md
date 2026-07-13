# 2026-07-13 idea dump — Sonnet's triage for Fable

The user dropped a big, unstructured list of feature ideas in one message and
asked for it to be organized and handed to Fable, with **Fable free to refine
this further** — re-scope, reorder, disagree, decide what a first slice actually
looks like. This document is Sonnet's honest first pass, not a final spec.

Two ground rules the user set:
1. **Be honest about genuine feasibility**, not just complexity. "Hard but
   doable" and "not achievable / bad fit for this app" are different verdicts —
   don't blur them.
2. **Order by complexity** among the doable ones: most complex-but-possible
   first, down to least complex last.

Read `FABLE-PLAN.md` first — several of these ideas already have a home there
(EPIC 1 Council, EPIC 2 Memory, EPIC 3 Generative UI, EPIC 5 Voice — just
restored today with new detail from this same conversation, EPIC 6 Document
RAG). Don't duplicate; extend or cross-link instead.

---

## Not a good fit / reconsider before building

**Live Google Slides API integration.** The user asked for "google slides"
generation. Actually creating/editing documents in a user's real Google account
requires OAuth consent, API credentials, token storage/refresh, and a Google
Cloud project — a fundamentally different kind of integration (external account,
cloud dependency) than anything else in DuckPond, which is otherwise entirely
self-hosted with no external accounts. This doesn't mean "skip the underlying
want" — it means the actual deliverable should be **PowerPoint (.pptx)
generation** (a real, well-supported local library path — see below), which
opens natively in Google Slides via upload/import. Build that; don't build
Google OAuth for this unless the user explicitly confirms they want DuckPond
holding a Google account credential, which is a real trust/scope decision worth
asking about on its own, separately from this list.

**"A complex way of choosing the best model that always gets best speed and
quality."** Taken completely literally — a routing system with a *provably
optimal* speed/quality tradeoff — that's a research problem (it's what much of
frontier-lab routing/MoE work is chasing), not a buildable feature. The
achievable version of this want already exists as a plan: **EPIC 1, The
Council**, in `FABLE-PLAN.md` — a classifier model + confidence-gated
escalation + optional multi-model debate for hard questions. That's the right
target. Build that, not a perfection oracle.

---

## Fable-tier, ordered most → least complex (of what's genuinely doable)

### 1. Adaptive/automatic model routing
Maps directly onto **EPIC 1 — The Council** in `FABLE-PLAN.md`. Don't treat this
as a separate feature — it's the same ask. Genuinely doable: a small always-warm
classifier model picking a target resident model per turn, with confidence-gated
escalation to a bigger model when unsure. The single-GPU constraint is the real
design pressure (loading a second model to double-check costs real seconds) —
`FABLE-PLAN.md` already flags this. **Verdict: doable, hard, already scoped —
just point Fable at Epic 1 rather than re-designing it here.**

### 2. Live voice conversation (reactive orb)
Just restored as **EPIC 5** in `FABLE-PLAN.md` with the new detail from today's
conversation (the orb reacts to *both* the AI talking and the user talking — two
distinct live-audio-reactive states, not one; button placement should be small
and out of the way, not a permanent composer fixture). Piper (TTS) is already
installed and working this session
(`/home/cranky/bin/piper-install/piper/piper`,
`/home/lewis/tts-voices/en_US-amy-medium.onnx`) but only wired for on-demand
per-message playback so far, per `EXTRA-TTS-SONNET.md` — the always-on live
duplex conversation loop (STT + barge-in + turn-taking) is the actual new work.
**Verdict: doable, hard — realtime turn-taking and barge-in on local hardware is
a genuine systems problem. Read EPIC 5 in full before scoping.**

### 3. Speculative tool calling
Predict which tool the model is about to call from partial streamed output,
start running it before generation finishes, discard if the prediction was
wrong. This is genuinely possible — `llama.js`'s `streamChatInner` already
accumulates `tool_calls` fragments incrementally as they stream (name and
arguments arrive in pieces), so there's a real signal to pattern-match against.
**But**: flag the honest caveat — this technique earns its keep when tool-call
*network* latency is the bottleneck (cloud APIs). On this local single-GPU
setup, the model's own token generation is usually the dominant cost, so the
win is real but narrower than the "up to 50% faster" pitch suggests — it mainly
helps for tools with real external latency (`web_search`, `fetch_page`), not
free/instant ones (widgets, math). **Verdict: doable, genuinely complex,
uncertain ROI here — worth a focused experiment if there's appetite, but budget
it as exploratory, not a guaranteed win. Lowest priority of the "hard" items.**

### 4. Semantic conversation search
"Find that old conversation about GPU memory even if I didn't use those exact
words." Needs embeddings — **same infrastructure blocker already documented in
`MEMORY-RETRIEVAL-FABLE.md`**: the router doesn't serve embeddings, there's no
embedding model on disk yet, a dedicated `--embeddings` side-service needs
standing up. One correction to the user's framing: **there is no ChromaDB
anywhere in this stack today** (checked — nothing in `server/`) — the existing
memory plan deliberately recommends brute-force cosine similarity in SQLite over
introducing a vector database, specifically to avoid one more service to run and
maintain on a single self-hosted box. Semantic search should reuse that same
embedding pipeline and storage approach once Epic 2 (Memory) lands, not stand up
ChromaDB separately. **Verdict: doable, depends entirely on the Memory epic's
embedding infrastructure landing first — sequence it right after, don't build in
parallel.**

### 5. Forgetting-curve memory decay (Ebbinghaus)
A scoring/ranking refinement on top of stored memories — decay relevance over
time unless a memory gets referenced again. Elegant, and a legitimately good
idea for keeping the memory store lean. **But it has nothing to decay until
Memory (Epic 2) exists.** **Verdict: doable, small — sequence as a refinement
inside Epic 2's design, not a standalone epic.**

### 6. RAG (document knowledge base)
The user explicitly said to skip detailing this one — it already has its own
plan. This is **EPIC 6 — Document RAG** in `FABLE-PLAN.md`, and shares the same
embedding blocker as items 4 and 5 above. No new triage needed here; just note
the shared dependency chain: **Memory → embedding service exists → RAG and
Semantic Search both become straightforward extensions of the same pipeline.**

### 7. Dynamic UI generation, extended
The user's framing: "we already have that" (correct — 21 widget types, the
model calls a tool and a structured card renders) "but I want the model to have
more choice." Their own caveat is the right one: this needs a capable
coding/reasoning model, not a 2B chat model, to reliably compose novel
structured output instead of picking from the fixed widget menu. This is
**EPIC 3 — Generative UI** in `FABLE-PLAN.md` already, specifically the
"model-authored components" feature. **Verdict: doable, moderate — mostly an
extension of shipped infrastructure, but gate it behind model capability (only
offer the "compose something custom" tool to models above some capability
threshold), exactly as the user suggested.**

### 8. CSV / PowerPoint export
Splitting this because the two halves are very different sizes:
- **CSV**: genuinely small — a tool that takes structured data (the model
  already emits structured rows for the `table` widget) and offers it as a
  downloadable file. This is closer to Sonnet-tier than Fable-tier; could be
  built as a quick follow-on to the existing `show_table` widget rather than
  needing real architecture work.
- **PowerPoint (.pptx)**: moderate — needs a deck-generation library
  (`pptxgenjs` on the Node side is the natural fit, pure JS, no native build
  step) and a `generate_slides` tool that turns a structured outline into a real
  downloadable .pptx. This *is* the answer to the "Google Slides" want above —
  a .pptx opens directly in Google Slides via upload, with no OAuth needed.
**Verdict: CSV is a quick win (see below), .pptx is doable and moderate, no
blockers — could plausibly be Opus-tier rather than Fable-tier since there's no
architecture question, just a new tool + library.**

---

## Not actually Fable-tier — quick wins, recommend building these directly

These don't need Fable's judgment; they're small, mechanical, and mostly
frontend/config. Listed here so Fable sees the full picture, but the
recommendation is Sonnet or Opus just does them without a design phase:

- **GBNF grammar-constrained generation.** llama.cpp already supports this
  natively (the diffusion CLI alone exposes `-j/--json-schema` and
  `-jf/--json-schema-file` right now) — this is exposing an existing llama.cpp
  capability through DuckPond's own API/settings, not building new
  infrastructure.
- **Mirostat sampling.** Also a native llama.cpp sampling parameter — exposing
  it as a per-model setting alongside the existing temperature/top_p/top_k
  controls in `SettingsPanel.svelte`.
- **Full-size denoising/image preview.** `ImageStudio.svelte`'s `.preview` class
  currently caps at `width: min(480px, 90%)` (line ~261) — straightforward CSS
  change to make it genuinely large, matching the ask to actually see each step.
- **UI decluttering.** Concretely: `Topbar.svelte` now has three separate icon
  toggle-buttons crammed in (Images / Workbench / Stats, lines 28-43) plus the
  VRAM chip plus the context bar plus settings — this is the exact clutter the
  user is describing, and it got worse this session when the Stats button was
  added. The fix is consolidating these into a single "more views" menu/dropdown
  instead of one dedicated icon per view. Separately: the user isn't sure the
  **image studio panel is worth keeping at all** now that `generate_image` works
  fine inline in chat — worth asking them directly whether to cut it rather than
  guessing.
- **HTML live preview in the agent workspace.** Worth checking what already
  exists before scoping new work — task #5 in the project's completed list says
  the agentic coding panel already has "preview" as a shipped feature (sandbox
  dev servers bind ports 3000-3009 per `SONNET-TODO.md`), so this may already be
  most of the way there and just need a raw-HTML-file preview mode added
  alongside the running-dev-server preview, not a build from zero.

---

## For Fable

This is Sonnet's read, not gospel. In particular: re-verify the complexity
ordering above against what you'd actually design for items 1-3 — the
speculative-tool-calling ROI caveat especially deserves your own judgment call,
and the Council/routing item (1) may turn out simpler or harder once you're
actually designing the classifier. Reorganize freely; the goal is a plan you'd
actually commit to building, not one that matches this document exactly.
