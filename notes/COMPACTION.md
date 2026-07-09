# Context compaction — approach comparison (researched 2026-07-09)

Constraint: 32k budget, 16GB VRAM, ONE big model resident at a time
(llama-server router `--models-max 1`).

## Candidates

### 1. wilpel/caveman-compression — REJECTED
Lossy "semantic compression": strips articles/connectives/filler, keeps
facts/numbers. Backends: OpenAI-API LLM (40-58% reduction), local RoBERTa
(~500MB, 20-30%), rule-based spaCy (15-30%, <100ms).
- Dormant: last push 2025-12-03, no releases, **no license** (can't legally vendor).
- Telegraphic output garbles multi-turn dialogue — the model then imitates
  the broken register. Built for stuffing documents, not chat history.

### 2. rtk-ai/rtk — ADOPTED AS COMPLEMENT (not compaction)
Rust CLI proxy compressing dev-tool OUTPUT (git/pytest/docker) 60-90%,
rule-based, <10ms, no ML model. Very actively maintained (v0.43.0 Jun 2026).
- Doesn't touch chat history at all — it's eviction-at-the-source for tool
  output. We apply the same idea (rule-based truncation/dedup of sandbox
  command output) in the agent panel before output enters context.

### 3. microsoft/LLMLingua — REJECTED
Perplexity/classifier-based token dropping (up to 20x claimed). Needs its own
resident model: LLMLingua-2 encoder 0.4-1.5GB VRAM (or ~8GB for original) —
competes with the single-model 16GB budget; plus PyTorch-on-ROCm in a
container on an immutable host = a new failure mode. Last PyPI release
Apr 2024. Same telegraphic-output problem as #1.

### 4. LLM summarization with the resident model (Claude Code /compact style) — CHOSEN
- **Zero extra VRAM** — the chat model is already loaded; history is largely
  in the server's prompt cache, so the prefill is mostly free.
- Preserves semantics (structured summary: goals, decisions, open items, key
  facts/identifiers) instead of stripping grammar.
- Cost: one generation pass every so often (~30-90s worst case on a 27-31B,
  much less with cache hits) — triggered at ~75% of budget, before the wall.

## Implementation
- Keep verbatim: system prompt, pinned messages, last N (default 8) turns.
- Summarize older turns → summary message spliced into the thread, marked
  `role=compaction`, always VISIBLE in the UI ("Compacted 14 messages, ~9.1k
  → ~800 tokens") — never silent.
- Originals stay in SQLite (collapsed in UI, recoverable, searchable by the
  retrieval layer later).
- Manual "Compact now" button + automatic threshold trigger.
- Exact token accounting via router `POST /v1/chat/completions/input_tokens`.

## Caveats
- With `--models-max 1`, a compaction run occupies the slot; schedule
  opportunistically and stream a status indicator.
- A slept model (600s idle unload) loses prompt cache → first compaction after
  wake pays full prefill.
- Summarization is lossy too: mitigated by verbatim recent turns, pins, and
  full history retention for retrieval.
