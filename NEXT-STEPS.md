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

Stages 1–13 are merged to `main`:

| PR | Content | Merge commit |
|---|---|---|
| #4 | Server: stages 1–6 (providers, costs engine, token saver, dispatcher, chat refactor) | `adaad08` |
| #6 | Hotfix: wildcard route startup crash (issue #5) | `83d272a` |
| #7 | Web UI: stages 7–9 + README resolution | `9530f3f` |
| #9 | Stage 12: fallback chains, free-only import mode, provider presets | `ccba8c1` |
| #11 | Stage 13: per-provider monthly spend caps + 80% alerts | `68cd1fa` |

**Stage 14 is on `claude/api-integration-desktop-access-8syred`, not yet merged.**
Price-limit slider (replaces free-only), provider quota probes, the OmniRoute
resilience + auto-routing port, owner-only desktop access, and the coding-panel
system-prompt block. See §9 for what it changed and §10 for what it did not.

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
  (`streamRemote`), catalog sync (`syncProviderModels`, lazy 24h `syncStaleProviders`,
  price-ceiling filter via `withinCeiling` — stage 14; `free_only` is now just a
  ceiling of 0), response-cache helpers
  (`cacheKey/cacheLookup/cacheStore`), `isRemoteId/parseRemoteId/resolveRemote`,
  fallback-chain helpers (`isRetryableRemoteError`, `fallbackCandidates` — typed
  errors carry `.status`), `PROVIDER_PRESETS` (8 key-only starters).
- `costs.js` — pricing (`costFor`, `priceRemoteTurn`, `auxBaselineCost`), ledger
  (`recordEvent`), `providerMonthSpend` (per-provider calendar-month spend; backs
  the spend cap), dashboard queries (`costsSummary/costsDaily/costsEvents`),
  `modelRowForRemoteId`.
- `tokenSaver.js` — `orderSystemForPrefixCache` (volatile date/memory block moved to
  END of system message for remote), `promptPressure` (chars/4 estimate vs ctx budget),
  `cacheEligible`.
- `chatBackend.js` — `auxModelFor` (cheapest enabled model on same provider, else local).
- `llama.js` — dispatcher: `streamChat`/`countInputTokens` route `r{id}:{model}` ids to
  the provider; llama-only params stripped; remote `max_tokens` capped at 4096.
  `remoteCall` runs the fallback chain: up to 3 attempts, only before any content
  has streamed, only on retryable errors; hops reported via the optional `onEvent`
  callback (`{ type: 'fallback', from, to, reason }`).
- `routes/providers.js` — provider REST API (owner-only mutations): CRUD, test,
  sync, cache clear, per-model PATCH, `GET /api/providers/presets`, preset quick-add
  (`POST { preset, api_key }`), `fallback` + `free_only` PATCH fields.
- `routes/costs.js` — `/api/costs/summary|daily|events`.
- **Stage 14 additions:** `omniroute.js` (breaker/cooldown/lockout + `auto*`
  routing), `providerQuota.js` (per-provider credit adapters), `hostfs.js`
  (desktop allowlist + denylist + symlink-safe path resolution).
  New routes: `/api/routing/health|reset`, `/api/providers/:id/quota`,
  `/api/providers/settings`, `/api/desktop/config|browse|attach`.
  NB provider routing is `/api/routing/*` — `/api/router/health` already belongs
  to the local llama.cpp router probe in `routes/models.js`.
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
- `components/ProvidersPanel.svelte` — the settings UI (add/test/sync/toggles/catalog,
  price-limit slider, quota block) + `ProviderPresets.svelte` (key-only quick-add grid),
  `ProviderFallback.svelte` (fallback-chain chip editor) and `RoutingHealth.svelte`
  (breaker/latency dashboard + the "paid models may build projects" toggle).
- `components/DesktopAccess.svelte` — owner-only folder allowlist + directory
  picker, mounted in `SettingsPanel.svelte`.
- `components/CostsPanel.svelte` — savings dashboard.
- `components/Chat.svelte` — `notice` SSE events render as toasts (fallback hops,
  auto-compaction).
- Wiring: `lib/router.js` (`/u/:id/providers|costs` + legacy paths),
  `lib/state.svelte.js` (view values), `App.svelte`, `Sidebar.svelte`, `Topbar.svelte`.

### DB (auto-migrated in `db.js`)
`providers` (+ `fallback_json` chain, `free_only` import filter, `spend_cap_usd`
monthly cap, and stage 14: `price_ceiling`, `quota_json`, `quota_at`),
`provider_models` (catalog + pricing + per-model `enabled`, plus stage 14
`filtered_out` — set by the price ceiling, deliberately separate from `enabled`),
`response_cache` (exact-turn cache), `usage_events` (cost ledger:
cost/baseline/saved USD, kind, cache_hit), `workspaces.host_path` (stage 14:
non-null means the workspace IS that real host directory).

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
5. **Fallback chains** — a provider can name backup models (`fallback_json`); when a
   remote call dies before streaming with a retryable error, the turn transparently
   retries on the next model in the chain (toast + `fallback` ledger event). Edit
   the chain in the provider's catalog view.

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
  (prompts-to-images etc.), multi-user key pools/rate-limit routing. Fallback
  chains shipped in stage 12; per-provider monthly spend caps + 80% alerts
  shipped in stage 13.
- Frontend was verified per-file with the Svelte 5 compiler; a full
  `npm run build` on the server is the real gate — run it before restarting prod.

## 6. If something breaks

- Server won't boot → check `journalctl --user -u duckpond -n 100`; route-syntax
  crashes name the file:line (that was issue #5; fixed pattern: `*` only at path end).
- Quick rollback: `git revert -m 1 68cd1fa` (stage-13 merge) or redeploy from `ccba8c1`.
- Provider sync fails → the provider card shows `last_error`; catalog keeps the last
  good sync; models stay usable.
- Remote turn fails mid-stream → the interrupted reply is parked in the tree like
  local turns ("say continue").

## 7. Continuing this work (paste into a new agent session)

> Repo `CrankyVase/duckpond` (public). Read `NEXT-STEPS.md` at the repo root first.
> The remote-providers + cost-saver feature is fully merged to main (PRs
> #4/#6/#7/#9/#11, stages 1–13); verify the checklist in §2. Then pick items from §5. Rules: push every
> file to the branch immediately after writing it (commit per file, `stage X: …`
> messages), verify pushes byte-for-byte (curl the file back and prefix-compare),
> never merge to main until verified, and find-my-way wildcards only at path end.
> Branch: `feat/remote-providers` or cut a fresh one from main.
>
> Push discipline (learned the hard way): NEVER hand-reconstruct a file's content
> inside a push call from memory — dump the local verified file and copy it
> verbatim. A from-memory push once corrupted db.js (wrong DB path → the site
> would have looked data-wiped) and providers.js (CJS require in ESM). Very large
> files (30KB+) occasionally truncate mid-push — just retry the same verbatim push;
> always byte-verify afterwards.

## 8. Test plan for future changes

1. `node --input-type=module --check` every server file touched.
2. Svelte 5 compiler parse for every component touched.
3. Boot test for route changes (register all paths against find-my-way, or actually
   boot the server) — lint alone missed issue #5.
4. curl the pushed file back and prefix-compare bytes before merging.
5. Merge → rebuild web → restart → smoke-test chat with both a local and a remote model.

## 9. Stage 14 — API integration, quota, auto routing, desktop access

Branch `claude/api-integration-desktop-access-8syred`. Written 2026-07-30.

### 9.1 Why the free slider never worked (three separate bugs)

1. **Zero prices were thrown away.** `normalizeModelMeta`'s number parser
   required `n > 0`, so a provider reporting a price of exactly `0` — every
   OpenRouter `:free` variant, the whole OpenCode Zen free tier — was read as
   "nothing reported" and then handed a *guessed* price from the `KNOWN` table.
   `deepseek-r1:free` came out priced at $0.55/1M. Free-only import compared
   against `=== 0` and so could never match anything. Prices now keep a reported
   zero, and the meta carries `reported` (the provider told us) separately from
   `free` (both sides reported as 0). Half-reported models are deliberately not
   treated as free.
2. **Excluded models were never removed from the catalog.** The sync only ever
   upserted, so switching free-only on re-imported the free models but left
   every paid row in `provider_models` — still in the picker, still chargeable.
   Rows that fail the filter now get `filtered_out = 1` (flagged, not deleted,
   so hand-tuned prices survive). `filtered_out` is deliberately a different
   column from `enabled`, which is the user's own per-model toggle: a re-sync
   must never resurrect a model someone switched off by hand.
3. **The re-sync was fire-and-forget.** `PATCH /api/providers/:id` kicked the
   sync off in the background and replied immediately, so the panel re-rendered
   against the old catalog and the toggle looked inert. It now awaits the sync
   and returns the counts.

Free-only generalised to `providers.price_ceiling`: `NULL` = no limit, `0` =
free only, `n` = only models at or under $n per 1M tokens. `free_only` is kept
in lockstep for anything still reading it. The UI is a slider with discrete
stops (free · $0.10 … $50 · any price) because price decisions cluster under $5
and the top stop is "no limit", not a number.

Also fixed while in here: a reported price now *overwrites* the stored one
(`COALESCE` used to prefer the old value, so a model that went from free to
paid kept its stale `0` forever).

### 9.2 Quota (`providerQuota.js`)

Per-provider adapters returning one normalized shape:
- **OpenRouter** — `GET {base}/key`: `limit`, `limit_remaining`, `usage`,
  `usage_daily/weekly/monthly`, `is_free_tier`, `limit_reset`.
- **NanoGPT** — `POST {base without /v1}/check-balance` with `x-api-key`:
  `usdBalance` / `nanoBalance` (several spellings read).
- Everything else reports `unsupported` with an honest one-liner about where
  that provider's limits actually live, rather than an empty panel.

Cached 5 min in `providers.quota_json/quota_at`, invalidated when the key or
base URL changes, warmed in the background by `GET /api/providers`. Forced
re-probes are owner-only (a probe spends a request against the key).

### 9.3 OmniRoute port (`omniroute.js`)

From `diegosouzapw/OmniRoute` (MIT), cut to what this app lacked:
- **Three-layer resilience.** Provider circuit breaker (5 consecutive failures,
  half-open probes at 15/30/60s, auth failures trip instantly), per-key cooldown
  with exponential backoff that honours `Retry-After` plus jitter, and per-MODEL
  lockout so one rate-limited model no longer benches its whole provider. Wired
  into `llama.js remoteCall`, which also now measures time-to-first-token.
- **Auto routing.** `auto`, `auto/cheap`, `auto/free`, `auto/fast`,
  `auto/coding`, `auto/smart` appear in the picker as their own group and
  resolve per turn by scoring every candidate across all providers on price,
  measured latency, success rate, context and capability. `auto/cheap` sorts by
  actual price first — scoring alone let a $0.05 model beat a free one on a
  latency guess. Resolution happens at the top of the turn in `chatPost.js`, so
  pricing/cache/spend-caps all see the real model, and the client gets a
  `routed` SSE event naming the pick.
- A concrete model id now also falls back **across** providers, not just down
  its own provider's chain.

State is in-process and forgotten on restart, so a tripped breaker never
outlives a deploy that may have fixed the cause.

### 9.4 Desktop access (`hostfs.js`)

Real folders on the host, as workspaces. `workspaces.host_path` set means the
workspace *is* that directory; `wsRoot(ws)` is the single source of truth and
everything destructive checks `host_path` first. Rules:
- Owner only, every route and the tool.
- Allowlisted roots; `$HOME` and `/` are refused as too broad (they hold `.ssh`,
  browser profiles, keyrings). Defaults are the discovered project dirs.
- Credential denylist enforced *inside* the allowlist, in both `hostfs.js` and
  `agent.js safePath` (`.env`, `.ssh`, `*.pem`, `.aws`, `id_rsa`, …).
- Symlinks are realpath'd **before** the containment check, so a symlink parked
  in an allowed root can't reach outside it.
- Execution stays in podman with only that folder mounted at `/workspace`
  (`:z`, not `:Z` — `:Z` would relabel the user's files for exclusive
  container use).
- `destroyWorkspace` and `DELETE /api/files/workspaces/:id` **detach** a desktop
  workspace; they never `rm -rf` a real directory. The confirm dialog says so
  instead of claiming the action can't be undone.

Chat entry point is the `open_desktop_project` gate tool. There is no browse
tool: the allowed folders and their subdirectories go into the system prompt, so
the model always has real paths instead of guesses.

### 9.5 System prompt

`CODING_PANEL_POLICY` now describes the Files rail, the in-canvas preview and
the live diffs on every turn that has any project capability. Models had been
inventing this UI — offering localhost URLs, telling users to copy-paste code
into an editor, pasting whole files back after writing them.

Remote models may now drive project mode (`remote_agent` setting reverts it).
They are the strongest coders available, and cost is already bounded by the
per-provider monthly caps, the remote `max_tokens` cap and the agent step limit.

### 9.6 Verification

`node --input-type=module --check` on every server file, a real boot test
(which caught a duplicate `/api/router/health` — the local llama router already
owned that path, so provider routing lives at `/api/routing/*`), `npm run build`
for the web, and four scripted suites: pricing/ceiling against real OpenRouter
and per-1M payload shapes, a stub-provider sync proving the slider moves models
in and out, the breaker/cooldown/lockout/ranking behaviour, host-path
containment including symlink escapes, and 41 authenticated HTTP assertions
including that a non-owner is refused desktop access and the price slider.

Not verified: no live provider key was available, so the OpenRouter and NanoGPT
quota adapters are written from their docs and exercised only against the
normalizer — worth one real check per provider after deploy. Nothing was run
against a real podman host, so the desktop bind-mount (`:z` labelling in
particular) needs a smoke test on the box.

## 10. Stage 14 — deliberately not done

- **Host shell execution.** The agent runs commands in the sandbox with the
  folder mounted, never directly on the host. A host shell would turn a prompt
  injection in a README into arbitrary code execution as the user. The approval
  flow in `agent.js` (`requestApproval`) is the hook to build on if this is ever
  wanted; it would need a per-command approval channel for chat turns, not just
  agent runs.
- **OmniRoute's lossy compressors** (Caveman, LLMLingua-2, OmniGlyph, …). They
  change what the model actually sees; `tokenSaver.js` covers the lossless
  subset. Also skipped: OAuth/subscription providers, multi-user quota-share
  routing, TPROXY MITM, the 104-tool MCP surface.
- **Per-user provider keys.** Still global, owner-managed (was already §5).
- Desktop access is per-*install*, not per-conversation: any owner chat can open
  any allowed folder. A per-conversation opt-in would be a small addition if it
  ever feels too loose.
