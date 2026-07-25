# NEXT STEPS — Remote Providers & Cost Saver (handoff doc)

> Written 2026-07-26. This file is the continuation point for the remote-providers
> + cost-savings feature. If a session runs out of quota mid-work, start here.
> Everything below is already pushed to GitHub — no work exists only on an agent's
> scratch disk.

## 0. Golden workflow rule (from the user)

**Push every file to GitHub immediately after it is created or edited.**
Commit to the working branch (currently `feat/remote-providers`) as version-history
log entries (`stage X/10: …`), one commit per file or per small logical unit.
Merge to `main` only when a stage is complete and verified — the production site
deploys from `main` (auto-deploy timer + `deploy.sh`, or manual
`cd web && npm run build && systemctl --user restart duckpond.service`).

## 1. Current state: SHIPPED ✅

All 10 stages are merged to `main`:

| PR | Content | Merge commit |
|---|---|---|
| #4 | Server: stages 1–6 (providers, costs engine, token saver, dispatcher, chat refactor) | `adaad08` |
| #6 | Hotfix: wildcard route startup crash (issue #5) | `83d272a` |
| #7 | Web UI: stages 7–9 + README resolution | `9530f3f` |

Known-good rollback points: before the feature = PR #3 merge (`921e640a5`);
server-only with hotfix = `83d272a`.

## 2. First-run verification checklist (do this next)

1. Pull main, rebuild: `cd web && npm run build && systemctl --user restart duckpond.service`
   (or wait for the deploy timer).
2. Open the app → Sidebar → **Providers** (new tile). Glance at the sidebar layout —
   the pages row is now a 2×2 tile grid with the owner "Control" link on its own
   full-width row (intended change, just confirm it looks right).
3. Add a provider: name optional, base URL e.g. `https://nano-gpt.com/api/v1`, API key.
   Use **Test connection** first, then **Add provider** — it verifies, inserts, and
   auto-syncs the catalog ("N models imported").
4. Open the model picker: models should be grouped **Local** + one group per provider,
   each remote model showing context size and per-1M-token pricing.
5. Chat with a remote model. Then open **Costs & savings**: spend/saved hero cards,
   savings-by-technique bars, 30-day chart, recent events should populate.
6. Send the exact same plain message twice → second turn should be a free cache replay
   (`cache_hit` event, full price counted as saved).
7. Long conversation → when prompt pressure exceeds the context budget, an
   auto-compaction notice appears and a `compact_savings` event is logged.

## 3. Architecture map

### Server (`server/src/`)
- `providers.js` — provider CRUD helpers, OpenAI-compatible streaming client
  (`streamRemote`), catalog sync (`syncProviderModels`, lazy 24h `syncStaleProviders`),
  response-cache helpers (`cacheKey/cacheLookup/cacheStore`), `isRemoteId/parseRemoteId/resolveRemote`.
- `costs.js` — pricing (`costFor`, `priceRemoteTurn`, `auxBaselineCost`), ledger
  (`recordEvent`), dashboard queries (`costsSummary/costsDaily/costsEvents`),
  `modelRowForRemoteId`.
- `tokenSaver.js` — `orderSystemForPrefixCache` (volatile date/memory block moved to
  END of system message for remote), `promptPressure` (chars/4 estimate vs ctx budget),
  `cacheEligible`.
- `chatBackend.js` — `auxModelFor` (cheapest enabled model on same provider, else local).
- `llama.js` — dispatcher: `streamChat`/`countInputTokens` route `r{id}:{model}` ids to
  the provider; llama-only params stripped; remote `max_tokens` capped at 4096.
- `routes/providers.js` — provider REST API (owner-only mutations).
- `routes/costs.js` — `/api/costs/summary|daily|events`.
- `routes/models.js` — `/api/models` merges local + remote entries; remote ctx size
  seeds `modelSettings`; `PUT /api/models/*` handles slash-containing remote ids
  (find-my-way wildcard must be LAST path char — see issue #5).
- Chat pipeline split: `chatkit.js` (tree/prompt/tools/usage+cost recording),
  `chatpolicy.js` (turn policies + speculative tool calling), `chatflow.js`
  (turn flows: diffusion, inline search, follow-ups, auto-compact, agent, image),
  `routes/chatPost.js` (the streaming turn + saver pipeline), `routes/chat.js` (CRUD,
  live, stop, compact, context).

### Web (`web/src/`)
- `components/ModelPicker.svelte` — provider grouping + cost/context lines.
- `components/ProvidersPanel.svelte` — the settings UI (add/test/sync/toggles/catalog).
- `components/CostsPanel.svelte` — savings dashboard.
- Wiring: `lib/router.js` (`/u/:id/providers|costs` + legacy paths),
  `lib/state.svelte.js` (view values), `App.svelte`, `Sidebar.svelte`, `Topbar.svelte`.

### DB (auto-migrated in `db.js`)
`providers`, `provider_models` (catalog + pricing + per-model enable),
`response_cache` (exact-turn cache), `usage_events` (cost ledger: cost/baseline/saved
USD, kind, cache_hit).

## 4. How the saver works (all automatic, lossless)

1. **Provider prompt caching** — system prompt reordered for a stable byte-identical
   prefix; `cached_tokens` from the provider priced at the discounted rate; the
   discount is logged as savings (kind `chat`, baseline > cost).
2. **Exact response cache** — plain remote turns (no workspace/constrained/regenerate)
   hash ({provider, model, messages, params}); a hit replays the saved reply free and
   logs full price as saved (kind `cache_hit`). Per-provider toggle in the panel.
3. **Auto-compaction** — when `promptPressure` says the prompt exceeds the ctx budget,
   everything but the last 8 messages is summarized by the cheap aux model and spliced
   into the leading system message (in-memory only; DB tree untouched). Logged as
   `compact_savings` + `aux_compact`.
4. **Cheap aux routing** — auto-titles, follow-up chips, memory extraction, and
   compaction run on the cheapest model of the same provider; baseline = what the
   conversation's model would have charged (kinds `aux_title/aux_followup/aux_memory/aux_compact`).

Safety rails: paid models skip the GPU queue and warm-up probe, never drive the
sandbox/agent tooling (`start_project` disabled remotely, `wsRow` forced null),
remote `max_tokens` capped at 4096.

## 5. Known limitations / future polish (not bugs)

- Provider keys are **global** (shared across users; only owner can manage).
  Per-user keys would be a new table + picker filtering.
- `usage_events` grows unbounded — add a prune job if it ever matters.
- Response cache has no TTL/eviction — clear per-provider from the panel if needed.
- Aux model = cheapest on same provider; a per-provider "pin aux model" override
  would be a small `providers.aux_model` column + select in the panel.
- CostsPanel USD rule: amounts < $1 render with 4 decimals (spec-literal); if that
  looks noisy, change the threshold line in `CostsPanel.svelte` `usd()`.
- OmniRoute ideas deliberately NOT ported: per-model quirky compressors
  (prompts-to-images etc.), multi-user key pools/rate-limit routing. Candidate
  next ports: model fallback chains, per-model spend caps/alerts.
- Frontend was verified per-file with the Svelte 5 compiler; a full
  `npm run build` on the server is the real gate — run it before restarting prod.

## 6. If something breaks

- Server won't boot → check `journalctl --user -u duckpond -n 100`; route-syntax
  crashes name the file:line (that was issue #5; fixed pattern: `*` only at path end).
- Quick rollback: `git revert -m 1 9530f3f` (UI merge) or redeploy from `83d272a`.
- Provider sync fails → the provider card shows `last_error`; catalog keeps the last
  good sync; models stay usable.
- Remote turn fails mid-stream → the interrupted reply is parked in the tree like
  local turns ("say continue").

## 7. Continuing this work (paste into a new agent session)

> Repo `CrankyVase/duckpond` (public). Read `NEXT-STEPS.md` at the repo root first.
> The remote-providers + cost-saver feature is fully merged to main (PRs #4/#6/#7);
> verify the checklist in §2. Then pick items from §5. Rules: push every file to the
> branch immediately after writing it (commit per file, `stage X: …` messages), verify
> pushes byte-for-byte (curl the file back and prefix-compare), never merge to main
> until verified, and find-my-way wildcards only at path end. Branch:
> `feat/remote-providers` or cut a fresh one from main.

## 8. Test plan for future changes

1. `node --input-type=module --check` every server file touched.
2. Svelte 5 compiler parse for every component touched.
3. Boot test for route changes (register all paths against find-my-way, or actually
   boot the server) — lint alone missed issue #5.
4. curl the pushed file back and prefix-compare bytes before merging.
5. Merge → rebuild web → restart → smoke-test chat with both a local and a remote model.
