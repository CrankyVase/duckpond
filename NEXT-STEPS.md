# NEXT STEPS — handoff doc

> Continuation point for DuckPond feature work. Stages 1–13 were the
> remote-providers + cost-saver program (see §9 for that history). Stages 14–19
> are the agentic-coding program: model curation, thinking mode, context
> compression, tool permissions, GitHub, and the UI for all of it.
> **Stage 20 = Model Hub 2 + Media Studio** — see `notes/HUB-2.md` for the
> full handoff (download manager, media bridge, MediaPanel, search-bar removal).

## 0. Golden workflow rule (from the user)

**Push every file to GitHub immediately after it is created or edited.**
Commit to the working branch as version-history log entries (`stage X: …`),
one commit per file or per small logical unit. Merge to `main` only when a
stage is complete and verified — the production site deploys from `main`
(auto-deploy timer + `deploy.sh`). **Since 2026-08-31: push to `main` as
soon as a feature lands, even if the feature isn't "finished" — the user
wants to watch progress live.**

## 1. Current state: SHIPPED ✅

Stages 1–13 (remote providers + cost saver), 14–19 (agentic coding), and
stage 20 (Model Hub 2 + media studio — see `notes/HUB-2.md` for that
program's full handoff).

| Stage | Content |
|---|---|
| 14 | Model catalog curation — a pasted API key no longer floods the picker |
| 15 | Context saver — OmniRoute's compression engines, baked in |
| 16 | Thinking mode that actually works — dialects + inline `<think>` splitting |
| 17 | Tool permissions — risk tiers, approval for every tool, audit log |
| 18 | GitHub — read, pull, branch, commit/push, open PR |
| 19 | UI for all of it + version stamp |
| 20 | Model Hub 2 — search bars removed (password-autofill), multi-job download manager, image/video/audio bridge, Media Studio (`notes/HUB-2.md`) |

## 2. Verification checklist after deploying

1. **Version** — the sidebar footer shows `DuckPond v0.3.0 "agentic" <sha>`.
   The sha must match `git rev-parse --short HEAD` on the box. If it doesn't,
   the deploy didn't take.
2. **Curation** — Providers → a provider → Models. Search, capability chips,
   and the status filter should all narrow the list. "Pick for me" should
   enable ~8 sensible models. Bulk "Turn off" should not touch favourites.
3. **New key** — add a provider. It defaults to `curated`: the whole catalog
   imports but only the auto-picked shortlist is on. The picker should stay
   short.
4. **Thinking** — pick a reasoning model, ask something hard. Reasoning must
   land in the collapsible thinking panel, never as raw `<think>` tags in the
   reply. Try a gateway model (OpenRouter/nano-gpt) — that path used to be
   silently broken.
5. **Context saver** — have a long agentic conversation with tool output. A
   `Context saver: −N tokens` notice should appear, and Costs & savings should
   show a `context_saved` row.
6. **Permissions** — Settings → "What the model may do". On `balanced`, ask the
   model to run `ls` (should just run) and `npm install express` (should show
   an approval card). The activity log should fill in.
7. **GitHub** — Settings → GitHub, paste a fine-grained PAT with Contents +
   Pull requests read/write. Then: "pull CrankyVase/duckpond into the workspace
   and tell me what's in server/src". Then ask for a change on a new branch —
   the commit must show an approval card, and committing to `main` must be
   refused outright.
8. **Screenshots** — only works if the sandbox image has chromium. Without it
   the tool returns a clear error instead of failing oddly.

## 3. Architecture map — what stages 14–19 added

### `server/src/contextsaver.js` (stage 15)
Five compression engines, dependency-free, `npm test`-covered:
`protectSpans`/`restoreSpans` (code, URLs, paths, hashes, numbers lifted out
before any lossy pass — SINGLE-pass alternation, because a sequential loop
would nest sentinels and corrupt the restore), `compressToolOutput` (RTK-style:
ANSI, CR redraws, repeated lines, installer noise, head/tail window),
`dedupeSession`, `compressProse` (phrase-level filler only — NOT caveman
grammar stripping, which `notes/COMPACTION.md` already rejected),
`trimToHeadroom` (relevance-ranked), and `saveContext` to orchestrate.
Wired in `routes/chatPost.js` before `orderSystemForPrefixCache`, for local
turns too. Level lives in `model_settings.context_saver` (`auto` default).

**Gotcha:** the seam left by a headroom trim rides in the LEADING system
message. Never insert a mid-thread system turn — qwen chat templates reject it,
which is why `buildPrompt` hoists all system content into one message.

### `server/src/reasoning.js` (stage 16)
`reasoningDialect(provider, modelId)` → `openai | anthropic | openrouter |
google | qwen | llama | always`. The gateway's envelope beats the upstream
model (OpenRouter normalises everything onto its own `reasoning` object).
`reasoningParams()` emits the right shape per dialect and nothing at all when
the catalog says the model can't reason.

**Gotcha:** `chat_template_kwargs` is on BOTH remote strip lists (`llama.js`
`LLAMA_ONLY_PARAMS`, `chatBackend.js` `LLAMA_ONLY`). Remote qwen models
therefore use Qwen3's `/think` and `/no_think` prompt switches instead, returned
as `_soft` and applied to the last user message by `chatPost`. Don't "fix" this
by removing the strip — a gateway 400 is not retryable, so the turn would die.

`makeThinkSplitter()` is a streaming state machine that pulls inline
`<think>…</think>` out of `content`, holding back partial tags across chunk
boundaries. Wired into both `providers.streamRemote` and `llama.streamChatInner`.

### `server/src/permissions.js` (stage 17)
Risk tiers `read | write | exec | external`; modes `open | balanced | careful |
readonly` (default `balanced`) in `users.tool_policy`. `decideTool()` escalates
dangerous shell shapes past the mode and de-escalates read-only ones.
`gateToolCall()` in `routes/agent.js` wraps EVERY tool now — the old
`NEEDS_APPROVAL` regex list covered `run_command` only. `capabilityManifest()`
puts the actual per-bucket tool names into the system prompt.
`tool_audit` table = the activity log.

### `server/src/github.js` (stage 18)
Dependency-free REST over fetch. `commitFiles` builds blobs → tree → commit →
ref move so N files land atomically. Two rules that are enforced in code, not
just in the prompt: no commit to a default branch, and `pullIntoWorkspace` uses
the tree API so no credential ever enters the sandbox. `github_commit` accepts
`workspace_path` so a file the model just wrote isn't re-serialised through the
model to be committed.

### DB (auto-migrated in `db.js`)
`provider_models` + `hidden`/`favorite`/`caps_json`/`label`/`note`;
`providers` + `import_mode`; `users` + `tool_policy`; new `tool_audit` and
`github_accounts`.

## 4. Known limitations / next up

- **Screenshots need chromium in the sandbox image.** `nikolaik/python-nodejs`
  doesn't ship it. Either bake a new image or add an approved install step.
- **`safePath` is lexical, not `realpath`.** A symlink created inside
  `/workspace` by `run_command` pointing at `/etc` would be followed by
  `readWsFile`/`writeWsFile`. Worth closing now that a permission layer implies
  a boundary.
- **`assertQuota` is still not called on agent write paths** — `write_file` can
  exceed the 15 GiB user cap.
- **`cache_hit` SSE event is emitted but unhandled** in `Chat.svelte` and
  `applyLiveEvent`, so a free cache replay shows no indicator and won't replay
  on reattach.
- **Capability sniffing is heuristic.** Every flag is editable per model via
  `PATCH /api/providers/:id/models {caps}`; the UI exposes favourite/hide but
  not yet per-flag editing.
- **No per-user provider keys** — provider keys stay global/owner-managed.
  GitHub tokens ARE per user.
- **`usage_events` and `tool_audit` grow unbounded** — add a prune job if it
  ever matters.
- Per-model "pin aux model" override is still a small `providers.aux_model`
  column + select away.

## 5. Test plan for future changes

1. `node --input-type=module --check` every server file touched.
2. `cd server && npm test` — contextsaver + reasoning suites (79 assertions).
3. **Boot the server** for route changes; lint alone missed issue #5. Use a
   scratch DB: `DUCKPOND_DB=/tmp/x.db PORT=3999 node src/index.js`, then curl
   the new paths (401 = registered, 404 = missing).
4. `cd web && npm run build` — the real gate for the frontend.
5. Merge → rebuild web → restart → smoke-test chat with a local AND a remote
   model.

## 6. If something breaks

- Server won't boot → `journalctl --user -u duckpond -n 100`; route-syntax
  crashes name the file:line (issue #5; find-my-way wildcards only at path end).
- Deploy looks stale → compare the sidebar sha against `git rev-parse --short HEAD`.
- Provider sync fails → the provider card shows `last_error`; the catalog keeps
  the last good sync and models stay usable.
- Context saver suspected of mangling something → set the model's
  `context_saver` to `off` in Settings; it's a single switch and everything
  downstream is unchanged.
- Model won't stop asking permission → Settings → "What the model may do";
  `open` runs everything unattended except genuinely dangerous shell shapes.

## 7. History: stages 1–13 (remote providers + cost saver)

| PR | Content | Merge commit |
|---|---|---|
| #4 | Server: stages 1–6 (providers, costs engine, token saver, dispatcher) | `adaad08` |
| #6 | Hotfix: wildcard route startup crash (issue #5) | `83d272a` |
| #7 | Web UI: stages 7–9 | `9530f3f` |
| #9 | Stage 12: fallback chains, free-only import, provider presets | `ccba8c1` |
| #11 | Stage 13: per-provider monthly spend caps + 80% alerts | `68cd1fa` |

Savers from that program, all still active: provider prompt caching (system
prompt reordered for a stable prefix), exact response cache, auto-compaction,
cheap aux routing, fallback chains, monthly spend caps. Stage 15's context
saver runs BEFORE all of them, so the expensive LLM compaction often never
fires at all.
