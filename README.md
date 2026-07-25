# DuckPond 🦆

Self-hosted chat + agentic coding workbench for local LLMs (llama.cpp router on
:8081). Multi-user, dark-only, 32k-context-aware. Runs on :3000 behind the
Cloudflare tunnel; Open WebUI was moved (not removed) to :3001.

## Run
```bash
systemctl --user status duckpond.service     # prod on :3000 (serves web/dist)
cd web && npm run build                      # rebuild frontend after changes
systemctl --user restart duckpond.service
```
Dev mode: `cd server && npm run dev` (:8090) + `cd web && npm run dev` (:5199, proxies /api).

## Admin (works even when locked out — touches SQLite directly)
```bash
cd server
node scripts/admin.mjs create-user <name>    # add a friend (asks for password)
node scripts/admin.mjs set-password <name>
node scripts/admin.mjs unban <ip|user|all>   # clear login lockouts
node scripts/admin.mjs list-bans
node scripts/admin.mjs list-users
```
Owner can also add friends from the UI API: `POST /api/auth/users`.

## Remote providers & cost savings
Add any OpenAI-compatible provider (name + base URL + API key, e.g.
`https://nano-gpt.com/api/v1`) in the **Providers** panel. The catalog
auto-syncs from `/models` with context sizes + pricing, re-syncing lazily every
24h. Remote models appear in the picker grouped by provider with per-model
costs; remote ids (`r{providerId}:{model}`) flow through the same chat pipeline
as local ones (memory, search, widgets, compaction all work).

The cost saver runs automatically on remote turns, tuned for lossless savings:
- stable-prefix system prompts → provider prompt-cache discounts (cached
  tokens are priced at the cheaper rate and logged as savings)
- exact response cache → identical plain turns replay free
- auto-compaction when the prompt would blow the context budget
- cheap aux model (cheapest on the same provider) for auto-titles, follow-up
  chips, memory extraction, and compaction summaries

Every paid call lands in a ledger (actual vs baseline USD). The **Costs** panel
shows spend vs savings, a breakdown by technique, per-provider/per-model
tables, a 30-day chart, and recent events. Paid models never drive the
sandbox/agent tooling (local-only) and skip the GPU queue entirely.

## Layout
- `server/` — Fastify 5 + better-sqlite3 + argon2. Routes: auth, models, chat,
  stats, providers, costs.
- `web/` — Svelte 5 + Vite SPA. Built output served by the server.
- `notes/` — DESIGN.md (architecture), RESEARCH.md (2026-07 research digest),
  COMPACTION.md (context-compaction tradeoffs, spec §4 doc).
- `data/duckpond.db` — SQLite (gitignored).

## Status (2026-07-09)
Shipped: auth/lockouts/sessions, model picker + per-model settings + load/unload,
streaming chat (SSE, rAF-batched, block-memoized markdown), edit/branch/regenerate
message tree, live tok/s, context bar (exact counts), VRAM readout, stats API,
auto-titles, port swap.
Next: compaction engine + pinning UI polish (notes/COMPACTION.md), agentic coding
panel + podman sandbox (notes/RESEARCH.md "sandbox"), SearxNG search, image tab
(:8765 bridge), TTS, pixel-duck avatar states.
