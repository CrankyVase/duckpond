# Overnight self-tuning + dreaming — handoff for FABLE (big architecture)

Two related idle-GPU-time systems the user (Lewis) picked out of a brainstorm on
2026-07-15. Both run only when the GPU is otherwise idle (no chat in flight) and
must never contend with daytime use. Routed to Fable: training pipelines, eval-
before-promote gating, and re-visiting/correcting stored memories are all "get it
wrong and it's actively worse than doing nothing" territory.

Hardware reality: single AMD 9070XT (16GB VRAM), 64GB system RAM, one GPU to
serialize against (same constraint as the router). Both systems below are batch
jobs — they must fully release the GPU the moment a real chat request shows up.

---

## System A — Overnight QLoRA self-tuning

**Vision.** The duck's own resident model gets periodically fine-tuned on Lewis's
actual conversation history, so voice/knowledge adapt over time instead of being
re-injected via RAG every turn. Never promote a worse model — always compare
against the currently-served one before swapping.

**Pipeline**
1. **Trigger.** A schedule (e.g. cron-style, late night) checks: GPU idle,
   `DUCKPOND_GPU_QUEUE` not busy, enough new conversation turns since the last
   tune (threshold, e.g. 200+ new messages) to be worth a run. Otherwise skip
   silently — no wasted cycles on a quiet night.
2. **Dataset build.** Pull recent conversations (user+assistant turn pairs) from
   the DB, filter out short/low-signal turns, tool-call noise, and anything
   flagged sensitive. Format as instruction/response pairs matching the base
   model's chat template. Cap dataset size (this is personalization, not
   pretraining — a few hundred to low-thousands of examples is the target, not
   millions).
3. **Train.** QLoRA (4-bit base + LoRA adapter) on the small resident model
   (7-8B). 16GB VRAM is enough for QLoRA at this scale but tight — expect to
   need gradient checkpointing + small batch/grad-accum. This step needs a real
   training stack (transformers/peft/bitsandbytes or an equivalent llama.cpp-
   compatible LoRA trainer) — separate from the router's inference-only
   llama.cpp binary. Scope which toolchain is actually installable on this box
   before committing to a design (this is the first real unknown to resolve).
4. **Checkpoint.** Save the adapter (small — tens of MB, not a full model copy)
   with metadata: base model version, dataset window, training timestamp, loss
   curve summary.
5. **Eval-before-promote gate.** Run the new adapter against a fixed held-out
   eval set (a handful of representative prompts + the existing eval harness if
   one exists by then) and compare quality/regressions against the currently
   *served* adapter (or base model if none yet). Simple heuristic first pass:
   does the new adapter regress on any eval prompt vs. current? If yes, do NOT
   promote — keep serving the old one, log why, keep the checkpoint for
   inspection. This gate is the whole point of the feature; without it this is
   just "randomly degrade the model some nights."
6. **Promote.** Only on a pass: router config points at base+new-adapter next
   time it loads that model. Keep the last N adapters on disk for rollback.
7. **Visibility.** Settings/Stats surface: last tune date, promoted or skipped
   (and why), a way to force-rollback to base or an older adapter.

**Hard parts / why Fable.** The training toolchain question (what actually runs
QLoRA on ROCm/this GPU without a fight) is unresolved and needs real
investigation before design gets locked. The eval gate is genuinely hard to get
right — too strict and nothing ever promotes, too loose and quality silently
rots. Dataset curation (excluding tool noise, sensitive content, degenerate
short turns) needs judgment.

---

## System B — Idle-time "dreaming" memory consolidation

**Vision.** Extends `MEMORY-RETRIEVAL-FABLE.md`'s per-turn shallow extraction
with a slow overnight pass that re-reads whole conversations and does careful
entity/relation extraction *and* checks new extractions against existing
memories for contradictions ("last week: X, yesterday: not-X — which is
current?"), rather than writing once and never revisiting.

**Pipeline**
1. **Trigger.** Same idle/queue-empty check as System A; can share the same
   scheduler. Runs after System A or independently — no shared state needed
   between them beyond "don't run at the same time as each other or a chat."
2. **Re-read pass.** Walk conversations (or just the ones with new activity
   since the last dreaming run) with a capable-but-not-huge model, slower and
   more careful than the inline per-turn extractor: extract entities, relations,
   and durable facts with more context than a single turn gives it.
3. **Contradiction check.** For each new candidate memory, compare against
   existing stored memories (vector similarity to find related ones, then an
   LLM judge call: same fact reaffirmed / refined / contradicted / unrelated).
   On contradiction: mark the old memory superseded (don't silently delete —
   keep provenance), store the new one as current, log the transition.
4. **Entity graph maintenance.** Merge duplicate entities discovered across
   sessions (e.g. "the router project" and "duckpond" turning out to be the
   same project), update the relation graph incrementally.
5. **Visibility.** Settings → Memory should show supersession history per fact
   ("this used to say X, corrected on <date> because Y"), not just a flat list.

**Hard parts / why Fable.** Contradiction detection is a genuine judgment call
for an LLM judge to get right — false positives (flagging non-contradictions)
erode trust fast. Needs the embedding infra from `MEMORY-RETRIEVAL-FABLE.md`
already stood up first (this is a strict dependency, not parallelizable with
that work). Entity merging/dedup across sessions is an open-ended NLP problem
at small model scale.

---

## Shared scheduling concern (both systems)
Both need a single "idle GPU batch job" scheduler/lock so they never run
concurrently with each other or with chat — likely one new small service or a
guarded cron entry that checks the existing GPU queue/busy state
(`DUCKPOND_GPU_QUEUE`) before starting, and yields immediately if a chat request
arrives mid-job (checkpoint and resume next night rather than blocking the
user). This scheduler is infrastructure both epics share — build it once.
