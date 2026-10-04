# DuckPond 🦆

Self-hosted chat + agentic coding workbench for local LLMs. Multi-user, dark theme, streaming-aware. Serves a Svelte 5 UI from a Fastify 5 backend with SQLite persistence.

Current deployment: Fedora hosts the website and authoritative files; Windows
MR_PC runs chat and Qwen Image 2.1 photos. See [Windows worker setup](bridge/README.md).
Fedora model execution is disabled. Audio/video models and a Windows embedding
worker are not configured.

## Quick start

```bash
systemctl --user status duckpond.service     # prod on :3000
systemctl --user restart duckpond.service     # after updates
```

Updates use `./deploy.sh`. The restored setup has no active auto-deploy timer.
The script uses Node 24, waits for idle website and Windows workers, synchronizes
the Windows PowerShell wrappers, and restarts the Windows bridge when its source
changes. Downloaded model files never trigger a deployment.

## Features

- **Multi-user chat** — Fastify 5 + SSE streaming, per-user sessions, login lockouts
- **Chat harness** — validates offered tools, avoids duplicate tool actions,
  bounds repeated failures, preserves replies across reconnects, and accounts for
  reported usage across tool rounds. GitHub reads also work in normal chat
- **Model management** — load/unload, per-model settings, capability badges, curated catalogs
- **Remote providers** — connect external API endpoints alongside local models, cost tracking
- **Context saver** — tool-output compression, session dedup and filler removal before every
  turn, with code, paths and numbers protected byte-for-byte. On by default
- **Thinking mode** — reasoning translated to each provider's dialect, inline `<think>` tags
  split into a collapsible panel
- **Agentic coding** — visible task plans, source search, project instructions, bounded
  tool recovery, run replay and recorded verification activity. Choose **Edit files
  only** in the workbench to disable command execution, browser checks, media
  generation and GitHub publishing for that conversation; **Edit & verify** keeps
  the existing permission policy for execution in the podman sandbox
- **Tool permissions** — risk-tiered approval for every tool the model calls, plus an
  activity log of what ran unattended
- **GitHub** — read repos, pull one into the workspace, commit, push and open pull requests
  (each with your approval)
- **Image generation** — in-chat image gen via diffusion bridge (Qwen-Image 2.1, with Fast/Balanced/Quality/Custom presets and ETA projections)
- **Markdown rendering** — block-memoized, rAF-batched, with mermaid diagrams, LaTeX, code blocks
- **Speech** — optional integrations; not configured in this chat/photo deployment
- **Duck mascot** — 32×32 pixel duck with 44+ animations, moods, pet interactions

## Layout

```
server/      — Fastify 5 backend (auth, chat, models, stats, providers, costs)
web/         — Svelte 5 + Vite SPA (served as static dist/ from server)
notes/       — DESIGN.md (architecture), RESEARCH.md, BACKLOG.md, COMPACTION.md
data/        — SQLite database (gitignored)
models/      — Fedora model library and Hugging Face cache (gitignored)
bridge/      — Windows workers, Fedora CPU helper, router adapter, cache ledger
deploy.sh    — idle-aware update script
```

## Configuration

Server environment variables:
- `HOST` — bind address (default `0.0.0.0`)
- `PORT` — listen port (default `3000`)
- `DIFFUSION_CLI` — path to diffusion binary
- `DIFFUSION_MODE` — diffusion backend mode
- `DUCKPOND_DB` — SQLite database path
- `HF_HOME` — current cache: `/home/cranky/duckpond/models/huggingface`
- `LLAMA_ROUTER_INI` — current registry: `/home/cranky/duckpond/bridge/models.ini`
- `LLAMA_URL` — chat adapter: Windows models + Fedora 700M helper, `http://127.0.0.1:8081`
- `IMAGE_BRIDGE_URL` — Windows photo adapter: `http://127.0.0.1:8765`
- `INFERENCE_HARDWARE_URL` — Windows stats: `http://127.0.0.1:8081/bridge/hardware`
- `EMBED_ENABLED=0` — semantic embeddings disabled until a Windows worker exists

The live database is `data/duckpond-live-restored.db`; saved images remain under
`server/data/images`. The service sets these production values explicitly.
`DIFFUSION_CLI=/usr/bin/false` blocks the legacy local diffusion CLI.

## Admin

```bash
cd server
/home/cranky/bin/node24 scripts/admin.mjs create-user <name>    # add a friend
/home/cranky/bin/node24 scripts/admin.mjs set-password <name>
/home/cranky/bin/node24 scripts/admin.mjs unban <ip|user|all>   # clear login lockouts
/home/cranky/bin/node24 scripts/admin.mjs list-bans
/home/cranky/bin/node24 scripts/admin.mjs list-users
```

The admin CLI selects the restored live database when it exists. An explicit
`DUCKPOND_DB` overrides that selection for isolated development/testing.

## Development

```bash
cd server && npm run dev     # dev server on :8090 with --watch
cd server && npm test        # context saver + reasoning suites
cd web && npm run dev        # Vite dev on :5199, proxies /api
cd web && npm run build      # the real gate before deploying
```

The running version and its git commit are in the sidebar footer and at
`GET /api/version` — check the sha there against the box when a deploy looks
like it didn't take.

## Tech stack

- **Backend**: Node.js 24, Fastify 5, better-sqlite3, argon2
- **Frontend**: Svelte 5, Vite 6, Lucide icons, marked, mermaid, Maplibre
- **LLM runtime**: Windows llama.cpp Vulkan behind the Fedora adapter on :8081
- **Deploy**: systemd user services, idle-aware update script
