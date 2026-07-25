# DuckPond 🦆

Self-hosted chat + agentic coding workbench for local LLMs. Multi-user, dark theme, streaming-aware. Serves a Svelte 5 UI from a Fastify 5 backend with SQLite persistence.

## Quick start

```bash
systemctl --user status duckpond.service     # prod on :3000
systemctl --user restart duckpond.service     # after updates
```

Web UI auto-rebuilds and restarts on file changes (every 2 min via `duckpond-deploy.timer`) — or triggered by pushes to `origin/main`.

## Features

- **Multi-user chat** — Fastify 5 + SSE streaming, per-user sessions, login lockouts
- **Model management** — load/unload, per-model settings, model picker with provider grouping
- **Remote providers** — connect external API endpoints alongside local models, cost tracking
- **Agentic coding** — podman sandbox for code execution, run replay, search trace
- **Image generation** — in-chat image gen via diffusion bridge (FLUX, SDXL)
- **Markdown rendering** — block-memoized, rAF-batched, with mermaid diagrams, LaTeX, code blocks
- **Speech** — TTS via Piper, STT via whisper.cpp
- **Duck mascot** — 32×32 pixel duck with 44+ animations, moods, pet interactions

## Layout

```
server/      — Fastify 5 backend (auth, chat, models, stats, providers, costs)
web/         — Svelte 5 + Vite SPA (served as static dist/ from server)
notes/       — DESIGN.md (architecture), RESEARCH.md, BACKLOG.md, COMPACTION.md
data/        — SQLite database (gitignored)
deploy.sh    — auto-deploy script (run by duckpond-deploy.timer)
```

## Configuration

Server environment variables:
- `HOST` — bind address (default `0.0.0.0`)
- `PORT` — listen port (default `3000`)
- `DIFFUSION_CLI` — path to diffusion binary
- `DIFFUSION_MODE` — diffusion backend mode
- `DUCKPOND_DB` — SQLite database path

## Admin

```bash
cd server
node scripts/admin.mjs create-user <name>    # add a friend
node scripts/admin.mjs set-password <name>
node scripts/admin.mjs unban <ip|user|all>   # clear login lockouts
node scripts/admin.mjs list-bans
node scripts/admin.mjs list-users
```

## Development

```bash
cd server && npm run dev     # dev server on :8090 with --watch
cd web && npm run dev        # Vite dev on :5199, proxies /api
```

## Tech stack

- **Backend**: Node.js 22, Fastify 5, better-sqlite3, argon2
- **Frontend**: Svelte 5, Vite 6, Lucide icons, marked, mermaid, Maplibre
- **LLM router**: llama.cpp server (router mode on :8081)
- **Deploy**: systemd user services, auto-deploy timer
