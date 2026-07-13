# 2026-07-13 idea dump — Sonnet's triage for Fable

The user dropped a big, unstructured list of feature ideas in one message and
asked for it to be organized and handed to Fable. Updated same-day after a
follow-up from the user — read the whole doc, the directive changed partway
through.

**The brief, as it now stands:** build all of this for real. Not a sampler —
the user wants this UI to become genuinely state-of-the-art: more impressive
and more usable than other local/self-hosted chat UIs, not just "a few new
features bolted on." Fable should **attempt every item below**, not
self-select the easy ones — difficulty is not a reason to skip something.
**Order of attack: most complex first, least complex last** (the user's own
instruction — start with the hardest, hairiest system while there's the most
runway, don't save it for "later" and never get to it). Within that constraint,
**Fable decides how to actually organize and sequence the work** — this
document is a briefing, not a spec to follow literally.

Read `FABLE-PLAN.md` first — several items already have a home there (EPIC 1
Council, EPIC 2 Memory, EPIC 3 Generative UI, EPIC 5 Voice, EPIC 6 Document
RAG). Don't duplicate; extend or cross-link instead.

---

## Explicitly set aside — do not build these right now

The user pulled these two out of scope themselves, after Sonnet's feasibility
read below. Different reasons for each:

- **Google Slides API integration** — genuinely a poor fit (see below for why:
  OAuth/external account/cloud dependency, unlike everything else in this
  self-hosted app). Not being built at all right now.
- **Adaptive/automatic model routing** ("the auto model") — this one **is**
  genuinely feasible and already has a home (EPIC 1, The Council, in
  `FABLE-PLAN.md`) — the user is choosing to deprioritize it for this round,
  not agreeing it's infeasible. Leave Epic 1 as-is in the plan for whenever it
  comes back into scope; don't start it now.

**Why Google Slides is a poor fit, for the record:** actually creating/editing
documents in a user's real Google account requires OAuth consent, API
credentials, token storage/refresh, and a Google Cloud project — a
fundamentally different kind of integration (external account, cloud
dependency) than anything else in DuckPond. The underlying want (a slide deck)
is still worth building — see item 6 below (PowerPoint export, which opens
directly in Google Slides via upload, no OAuth needed).

---

## Already done this session (context for Fable, not to-do)

- **Thinking watchdog fixed.** It was killing legitimate long reasoning at a
  fixed 60s (180s in Ultra) after the first reasoning token, regardless of
  whether the model kept working. Now a true idle timeout (resets on every
  reasoning token) at 60 minutes, plus a separate loop detector that catches a
  model stuck repeating the same ~200-char phrase forever (which an idle
  timeout alone can't see, since a repeating model never goes idle). See
  `server/src/routes/chat.js` around `armThink`/`checkRepeat`.
- **Core prompt updated** to tell models to stop reasoning once they've
  decided on an approach and write the actual code as the real answer/tool
  call, instead of re-deriving or narrating the code again inside their
  thinking first (`server/src/settings.js`, `DEFAULT_CORE_PROMPT`).
- **Image Studio and Workbench panels removed.** Both were redundant —
  `generate_image` already works inline in chat, and agent/coding mode already
  runs inline too (inline run feed, `ChatFiles` file tree). Deleted
  `ImageStudio.svelte`, `Workbench.svelte`, `AgentPanel.svelte`,
  `FileTree.svelte`, and their state modules; removed their Topbar buttons.
  **The one genuinely unique thing Workbench had — the live dev-server
  preview — was moved, not lost**: `ChatFiles.svelte` now has a preview button
  that opens an embedded iframe overlay (`localhost:3000` dev server), bigger
  and actually inline where the user wanted it, instead of Workbench's
  new-tab link. Manual file editing and the standalone cross-conversation
  workspace browser were **not** preserved — the AI edits files via chat now;
  if Fable's new features need direct manual file editing back, that's a new,
  deliberate decision, not an oversight.
- Topbar is down to one view-toggle button (Stats) plus the VRAM chip, context
  bar, and settings — still worth a proper decluttering pass once Fable's new
  features land (see the final phase below), since new buttons are coming.

---

## Attempt all of these — ordered most → least complex

Every item here should genuinely be attempted, not triaged away for
difficulty. The ordering below is Sonnet's complexity read; re-verify it once
you're actually designing, and reorganize if your own judgment differs.

### 1. Live voice conversation (reactive orb)
**EPIC 5** in `FABLE-PLAN.md`, restored today with the user's new detail: the
orb reacts to *both* the AI talking and the user talking — two distinct live
audio-reactive states, not one — and the trigger button should be small and
unintrusive, not a permanent composer fixture. Piper (TTS) is already installed
and working (`/home/cranky/bin/piper-install/piper/piper`,
`/home/lewis/tts-voices/en_US-amy-medium.onnx`) but only wired for on-demand
per-message playback (`EXTRA-TTS-SONNET.md`) — the always-on live duplex loop
(STT + barge-in + turn-taking) is the real new work. Realtime turn-taking and
barge-in on local hardware is a genuine systems problem — likely the hardest
single item on this list. Read EPIC 5 in full before scoping.

### 2. Speculative tool calling
Predict which tool the model is about to call from partial streamed output,
start running it before generation finishes, discard if wrong. Genuinely
possible: `llama.js`'s `streamChatInner` already accumulates `tool_calls`
fragments incrementally (name and arguments arrive in pieces), so there's a
real signal to pattern-match against. Honest caveat to design around, not a
reason to skip: this technique earns the most when tool-call *network* latency
is the bottleneck. On this local single-GPU setup the model's own token
generation is usually the dominant cost, so the win is real but concentrated —
mainly `web_search`/`fetch_page` (real external latency), less so free/instant
tools (widgets, math). Design it, ship it, just calibrate expectations to
that shape of win rather than a flat "50% faster."

### 3. Semantic conversation search
"Find that old conversation about GPU memory even if I didn't use those exact
words." Needs embeddings — same infrastructure work already documented in
`MEMORY-RETRIEVAL-FABLE.md`: the router doesn't serve embeddings, no embedding
model is on disk yet, a dedicated `--embeddings` side-service needs standing
up. Correction to the user's original framing: **there is no ChromaDB
anywhere in this stack** — the existing memory plan deliberately recommends
brute-force cosine similarity in SQLite instead, specifically to avoid running
a whole extra database service on a single self-hosted box. Build semantic
search on that same embedding pipeline once it exists — sequence it right
after Memory (Epic 2), reusing the infrastructure rather than duplicating it.

### 4. Forgetting-curve memory decay (Ebbinghaus)
A scoring/ranking refinement on stored memories — relevance decays over time
unless a memory is referenced again, keeping the store lean. Real and doable,
but it's a refinement *inside* Epic 2's design (there's nothing to decay until
Memory exists) — build it as part of that epic, not standalone.

### 5. RAG (document knowledge base)
The user explicitly said to skip detailing this — it already has its own plan,
**EPIC 6 — Document RAG** in `FABLE-PLAN.md`, sharing the same embedding
dependency as items 3-4 above. Sequence: **Memory → embedding service exists →
RAG and Semantic Search both become straightforward extensions of the same
pipeline.**

### 6. PowerPoint / CSV export
Two different sizes bundled in one ask:
- **PowerPoint (.pptx)** — moderate: a deck-generation library (`pptxgenjs` on
  the Node side — pure JS, no native build step) plus a `generate_slides` tool
  turning a structured outline into a real downloadable file. This is also the
  actual answer to "Google Slides" above — a `.pptx` opens directly in Google
  Slides via upload, with no OAuth needed.
- **CSV** — small: a tool that takes structured data (the model already emits
  rows for the `table` widget) and offers it as a download.
No blockers on either half; least complex item in the "attempt all" list, but
still explicitly in scope — don't let its size make it fall off the plan.

### 7. Dynamic UI generation, extended
The user's own framing: "we already have that" (correct — 21 widget types, a
tool call renders a structured card) "but I want the model to have more
choice." Their own caveat is right: this needs a genuinely capable
coding/reasoning model, not a small chat model, to reliably compose novel
structured output instead of picking from the fixed widget menu. This is
**EPIC 3 — Generative UI** in `FABLE-PLAN.md`, specifically the
"model-authored components" feature — gate the "compose something custom"
tool behind a model-capability threshold, exactly as the user suggested.

### 8. GBNF grammar-constrained generation + Mirostat sampling
Both are native llama.cpp capabilities already (the diffusion CLI alone
exposes `-j/--json-schema` right now) — this is exposing existing capability
through DuckPond's own API and `SettingsPanel.svelte`, not building new
infrastructure. Smallest item on the list. Still worth Fable owning as part of
the same "make this genuinely impressive" push, since forcing valid structured
output and tunable sampling behavior are both real, visible quality wins.

---

## Final phase, after everything else ships: UI decluttering pass

Once Fable's features land, there will be a meaningfully different app — a
voice-mode trigger and reactive orb, possibly new export buttons (CSV/PPTX),
new settings sections (Mirostat, grammar, per-model tool choices), maybe a
semantic search bar. **Do this decluttering pass last, deliberately, with the
full new feature set in view** — not incrementally per feature. Goals:
- Reduce visual clutter across Topbar/composer/settings holistically, not
  patch by patch.
- Find real homes for anything that still feels bolted-on (this session
  already moved the dev-server preview from a standalone panel into
  `ChatFiles`, and cut Topbar down to one view button — continue that
  direction).
- The voice orb/button placement is explicitly called out by the user as
  needing to be unintrusive — this is the moment to get that right against
  the final feature set, not guess early and redo it later.

---

## For Fable

This is Sonnet's read, not gospel — reorganize freely, the goal is a plan
you'd actually commit to building. But the two firm constraints from the user
are: **attempt everything above** (nothing gets silently dropped for
difficulty) and **hardest-first ordering** as the attack plan. Google Slides
and adaptive model routing are the only two items actually out of scope right
now.
