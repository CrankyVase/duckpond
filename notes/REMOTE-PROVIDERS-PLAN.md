# Plan: Remote Providers + Cost Savings (feat/remote-providers)

Goal: let DuckPond talk to paid/free **remote OpenAI-compatible providers**
(e.g. `https://nano-gpt.com/api/v1`) alongside the local llama.cpp router —
with automatic model discovery, provider grouping, per-model pricing, and an
automatic, near-lossless cost-savings pipeline plus a savings dashboard.
Inspired by OmniRoute (diegosouzapw/OmniRoute): cost-optimized routing,
response caching, prompt-prefix-cache friendliness, LiteLLM-style pricing
table, 24h model auto-sync, usage/cost accounting, fallback tiers.

## Model identity

Remote models get ids of the form `r<providerId>:<modelId>`
(e.g. `r1:claude-sonnet-4.5`). Local ids are untouched. Everywhere a
`model_id` is stored (conversations, model_settings, messages, usage) this
just works, because ids are opaque strings.

## DB (additive, like all duckpond migrations)

- `providers` — name, base_url, api_key (write-only over the API), enabled,
  kind ('openai'), last_sync_at / last_error / last_sync_count.
- `provider_models` — per-provider model catalog: model_id, context_length,
  max_output, price_in / price_out / price_cached_in (USD per 1M tokens),
  enabled, raw_json (the provider's own metadata), fetched_at.
  UNIQUE(provider_id, model_id).
- `usage_events` — per-request cost ledger: user, conv, model, provider,
  tokens in/out/cached, cost_usd, baseline_usd (what it would have cost at
  the reference price / without the saver), saved_usd, kind
  (chat | aux_title | aux_followup | aux_memory | aux_compact | cache_hit |
  compact_savings), cache_hit flag, created_at.
- `response_cache` — exact-match reply cache: hash(model+messages+params) →
  response text/thinking, token counts, hit counter, created_at.

## Server modules

1. `providers.js` — provider CRUD helpers; **model sync**: GET {base}/models
   with the key, normalize context/pricing from common shapes
   (OpenRouter-style `context_length` + `pricing.prompt/completion`,
   `context_window`, `max_tokens`, per-1M `pricing.input/output`), fall back
   to a built-in price table for well-known families (claude, gpt, gemini,
   deepseek, grok, llama, qwen, mistral…); connection test; 24h lazy re-sync.
   Also the **remote streaming client** — same shape as llama.js
   `streamChat` (SSE, tool_calls fragments, reasoning_content, usage incl.
   cached-token details), so the whole chat pipeline works unchanged.
2. `chatBackend.js` — dispatcher: `isRemoteId()`, `streamChatAny()`
   (local → llama.streamChat, remote → providers.streamRemote with param
   mapping: temperature/top_p pass through; top_k, repeat_penalty, mirostat,
   grammar, chat_template_kwargs are llama-only and dropped; max_tokens -1 →
   omitted/capped), `countTokensAny()` (llama input_tokens locally, chars/4
   estimate remotely), `auxModelFor()` (cheapest model for background jobs:
   a loaded local model = $0, else the cheapest enabled remote model).
3. `costs.js` — pricing lookup, cost math (cached tokens at the cached
   rate), baseline comparison, `recordEvent()`, aggregation queries for the
   dashboard.
4. `tokenSaver.js` — the always-on savings pipeline ("most lossless, most
   savings"):
   - **Exact response cache** for plain remote chat turns (no tools fired,
     no workspace, not constrained, not regenerate). Hit = replay the saved
     reply, $0 spent, full estimated cost logged as saved. Toggleable per
     provider (default on).
   - **Cache-friendly system-prompt ordering** for remote turns: volatile
     blocks (date, recalled memories, doc excerpts) go AFTER stable content
     so provider-side prompt caching (OpenAI automatic / Anthropic-style)
     keeps hitting — recorded via `usage` cached-token fields.
   - **Cheap aux routing**: auto-titles, follow-up chips, memory extraction
     and compaction summaries run on `auxModelFor()` instead of the paid
     chat model, each logged with the paid model's price as baseline.
   - **Auto max_tokens cap** for paid models (default 4096; user-adjustable
     per model profile) — runaway generations can't run up a bill.
   - **Auto-compaction**: when the estimated prompt exceeds ~80% of the
     model's context, compact older turns first (same compaction nodes as
     the manual feature), logged as compact_savings.
   - Deliberately NOT included (per request): lossy prompt-to-image or
     single-model gimmick codecs; only broadly-applicable techniques.
5. `routes/providers.js` — CRUD + `/sync` + `/test`; list is key-masked;
   writes owner-only (keys are pond-wide), reads open to authed users.
6. `routes/costs.js` — `/api/costs/summary`, `/api/costs/daily`,
   `/api/costs/events`, `/api/costs/models` for the dashboard.

## chat.js integration (minimal, surgical)

- All `streamChat` / `countInputTokens` calls → `streamChatAny` /
  `countTokensAny` (identical signatures).
- Remote turns skip the GPU queue, the router warm-up probe and VRAM reaper
  bookkeeping; `start_project` + workspace/agent tooling is disabled for
  remote models (inline tools — web search, widgets, memory, images — stay).
- Response-cache check before the first paid call; cache store after a
  clean plain-text reply.
- `recordUsage` → also writes a `usage_events` row with cost + savings.
- Aux calls (title / followups / memory) routed through `auxModelFor()` and
  logged with kind=aux_*.
- Auto-compaction + auto max_tokens + system-prompt ordering applied for
  remote turns.

## Web

- **ModelPicker**: grouped list — "On this machine" then one section per
  provider; remote rows show context size **and price ($/1M in · $/1M out)**,
  no VRAM eject; free/local models show `free`.
- **Providers panel** (new sidebar page): add provider (name + base URL +
  API key) → test → auto-import models with context + pricing; per-model
  enable + price override; sync-now; last-error display.
- **Costs dashboard** (new sidebar page): total spend, total saved, cache
  hits, tokens processed; savings by technique (cache / cheap-aux /
  compaction / provider prompt-cache discount); daily spend vs saved chart;
  per-model table; recent events.
- Router/App/Sidebar wiring for `/u/:id/providers` and `/u/:id/costs`.

## Stages (one commit each on this branch)

1. This plan.
2. DB tables (db.js).
3. providers.js + routes/providers.js + index.js wiring.
4. costs.js + chatBackend.js + routes/costs.js.
5. tokenSaver.js + routes/models.js remote catalog.
6. chat.js integration.
7. Web: ModelPicker grouping + cost display.
8. Web: Providers panel.
9. Web: Costs dashboard.
10. README + notes, PR to main.
