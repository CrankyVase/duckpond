# DuckPond — Design Notes

Self-hosted chat + agentic coding workbench for local LLMs. Single box (Bazzite,
RX 9070 XT 16GB, ROCm 7.1.1 / Vulkan), multi-user (owner + friends), exposed only
via Cloudflare Tunnel. 32k context budget per model — context management is a
first-class feature.

## Existing infrastructure we build ON TOP OF (do not duplicate)

| Thing | Where | Notes |
|---|---|---|
| llama-server ROUTER mode | `127.0.0.1:8081` (`llama-router-8081.service`) | prebuilt b9625 Vulkan, `--models-preset <router-config>.ini`, `--models-max 1`, `--models-autoload`, `--sleep-idle-seconds 600` |
| Image-gen bridge (OpenAI-compatible) | `127.0.0.1:8765` (`image-gen-bridge-8765.service`) | diffusers in podman ROCm container; FLUX2-klein, Juggernaut-XL, Ideogram4; already handles unload-LLM→generate→reload-LLM VRAM juggling. One-shot today; step-preview streaming is a future add. |
| Open WebUI | `:3000` → moves to `:3001` | kept, not removed; Cloudflare tunnel ingress points at 3000 |
| Model GGUFs | `<models-dir>/` | presets defined in the router INI |

### Router API surface (verified against b9625-f05cf4676)
- `GET /v1/models` — list w/ per-model `status.value` (`loaded`/`unloaded`) + launch args
- `POST /models/load` / `POST /models/unload` — explicit hot-swap
- `POST /v1/chat/completions` (stream; `timings` in final chunk → tok/s)
- `POST /v1/chat/completions/input_tokens` — exact prompt token count (context bar)
- `GET /slots?model=X`, `GET /props`, `GET /health`
- VRAM: `rocm-smi --showmeminfo vram --json` (card0 = 17.1 GB total)

## Stack (researched 2026-07-09, see RESEARCH.md)
- **Server**: Node 22 + Fastify 5, better-sqlite3 (WAL), argon2id. Serves the built
  SPA + JSON API + SSE + one WebSocket (agent panel). Binds `127.0.0.1` ONLY —
  CF-Connecting-IP trust depends on it.
- **Web**: Svelte 5 (runes) + Vite SPA. No SSR. marked for markdown (block-split,
  memoized per block, only trailing open block re-parses). Tokens buffered outside
  reactivity, flushed once per rAF. CodeMirror 6 (not Monaco) for the code panel.
- **Transport**: SSE over `fetch` + ReadableStream (POST bodies + cookies work;
  passes Cloudflare Tunnel cleanly). WebSocket only for the sandbox event channel.

## Auth (spec §7, adapted — see RESEARCH.md "authsec")
fail2ban is the wrong shape behind a tunnel (origin sees only 127.0.0.1; firewall
bans block nothing). Equivalent protection, app-level:
- argon2id password hashes (OWASP defaults), roles: `owner` / `friend`.
- Server-side sessions in SQLite; 256-bit id in httpOnly+Secure+SameSite=Lax cookie.
- Login lockouts keyed on BOTH account and CF-Connecting-IP, exponential,
  auto-expiring (5 fails → 15 min, doubling, cap 24 h). Never permanent.
- Recovery: `node server/scripts/admin.mjs unban <ip|user>` — touches SQLite
  directly, works even if the web path is locked.
- Optional outer gate later: Cloudflare Access (free ≤50 users).

## Data model (SQLite)
Messages form a **tree** (`parent_id`) so edit/branch/regenerate are first-class:
editing a message creates a sibling; the conversation's `active_leaf_id` picks the
visible path (root→leaf). Nothing is ever destroyed. Compaction inserts a summary
node that *covers* a range of ancestors; covered originals stay in the DB and UI
(collapsed), excluded from the prompt.

## Context management
- Budget = model ctx (32k default). Exact usage via `input_tokens` endpoint.
- Compaction: LLM-summarization with the *resident* chat model (zero extra VRAM;
  rejected caveman-compression / LLMLingua — see COMPACTION.md). Trigger ~75%,
  keep system prompt + pinned + last N turns verbatim, summarize the rest into a
  structured note. Always visible in-thread, never silent.
- Pinned messages survive compaction.

## VRAM rule
One big model resident at a time (`--models-max 1` enforces for LLMs; image bridge
already unloads the LLM before generating). DuckPond orchestrates but never
violates this.

## Non-negotiables
- Agent writes ONLY inside its podman workspace. No real-filesystem edits, ever.
- App binds loopback only; the tunnel is the only ingress.
- Local models only; no paid APIs.

## Look & feel
Dark only. bg `#0d0d0f`, text `#e8e6e2`, greys for chrome, ONE muted accent
(duck-bill amber `#d9a05b`) used sparingly. Claude Code's agentic transparency ×
ChatGPT's clean thread × OpenRouter's model picker × Gemini's motion. The pixel
duck (§10) is the one splash of personality.
