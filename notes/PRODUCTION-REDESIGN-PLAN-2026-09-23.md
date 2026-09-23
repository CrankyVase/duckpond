# Duckpond production redesign plan — 2026-09-23

Status: source audit and implementation plan. No runtime or model benchmark was run for this plan. The working tree already contains extensive uncommitted work; preserve it and implement in small, reviewable slices.

## Product target

Duckpond should feel like one calm application with three primary destinations: Chat, Agent, and Studio. Models and downloads are a fourth destination for setup and maintenance. Chat gives a polished answer and useful sources. Agent owns a project task until it has reached a verifiable outcome or a clear blocking condition. Studio owns durable media jobs. A browser connection only observes work; it never owns a task's lifetime.

Use the existing Svelte/Fastify/SQLite stack and the existing Podman workspace, model router, and media bridge. Keep Chat and Agent as distinct harnesses over shared model/provider, auth, storage, and artifact services.

## Audit findings that drive the work

| Area | Current behavior | Gap |
| --- | --- | --- |
| Chat delivery | `POST /api/conversations/:id/chat` returns `202`; `GET .../live` reconnects by job ID with SSE and heartbeats. | `liveJobs.js` stores the job and partial output in process memory. A Node restart loses the active turn and stream snapshot. |
| Agent | `routes/agent.js` persists typed events and tool receipts, supports project files, shell, browser, search, compaction and Stop. | The model's first tool-free reply ends the run; a hard 80-step limit ends long tasks. Run control/approvals are in memory, and restart recovery marks old runs stale instead of resuming a checkpoint. |
| Documents | `docs.js` extracts PDF/text, chunks and retrieves; chat injects attached document text. | The Agent tool list has no scoped document search/read tools, and project/task attachments are not a durable part of its workflow. |
| Tools and widgets | Dozens of widget tools/components plus separate tool catalogs/policies. | Tool choice and UI are noisy for small models; many cards duplicate a normal sourced answer or markdown. Usage needs measuring before removal. |
| Models | Hub has Installed, Discover, Downloads, runtime notes, variant choice, and progress in one 2,243-line component. | Downloaded, complete, loadable, loaded and actually verified are still spread across several APIs/UI paths. Setup and repair need a single model state. |
| Media | Studio jobs persist in SQLite; Qwen-Image 2.1 presets, load/unload, progress and Q4 support exist. | Bridge generation is a synchronous request. After an origin/bridge restart, a correlation tag does not recover the result; jobs can need manual reconciliation. GPU queue is off by default. |
| UI | Sidebar has configurable pins, More, history, a small static duck mark; `Duck.svelte` has a richer existing animation system. | Too many equal-weight destinations and controls obscure the main work. The mascot is present but barely functions as product identity. |

## Delivery order

### 1. Durable job and transport foundation

Move Chat and Agent work behind one durable task API. `POST` validates and commits a job plus a client idempotency key, then returns `202 {jobId}` quickly. A server worker claims the job and writes ordered events, checkpoints, terminal result and artifacts to SQLite. `GET /jobs/:id` returns current state; `GET /jobs/:id/events?after=<eventId>` replays from an event cursor and tails through SSE. The client reconnects with the last event ID and falls back to short polling when a stream fails. Keep `text/event-stream`, flush an initial event, and send heartbeats; never couple worker cancellation to request close. Stop is an explicit durable command.

Use a worker lease and generation/fencing token so only the current owner can append state. On restart, resume from the last completed model/tool boundary. A tool invocation gets a receipt before dispatch; after a crash, reconcile its result or mark the effect unknown instead of replaying shell, file or remote actions blindly. Preserve user-visible partial output. This extends the existing `agent_events`, `toolJournal.js` and media job patterns instead of creating another unrelated stream system.

**Acceptance:** A task runs through browser close, refresh and Cloudflare stream interruption; a different device can open its progress; a Node restart resumes or truthfully reports the exact uncertain operation. Duplicate submit does not duplicate a task. Stop, approval and final results survive reconnect. No HTTP request needs to remain open for model or media completion.

### 2. Separate and strengthen the two harnesses

**Chat:** Keep a narrow tool set: document retrieval, web search/page reading when needed, image generation when asked, and explicit exports. Prefer a direct answer with citations. Keep chat memory and conversation compaction independent of project task state. Remove the automatic offer of decorative widget tools.

**Agent:** Persist the task objective, constraints, project identity, plan/checklist, model settings, tool transcript summary, changed files, known failures and verification evidence. Use a loop of inspect → plan → act → verify → assess. A tool-free message is a completion *candidate*: an explicit completion audit checks each requested outcome and evidence, then either finishes, continues with a specific next step, or pauses for genuine missing input. Replace the hard 80-step terminal failure with renewable time/token/step budgets, stuck-loop detection, and a visible resource ceiling. Compaction preserves tool call/result pairs and the task checkpoint.

Add `search_documents` and `read_document` tools scoped to the user's attached documents, plus citations by document/chunk. Project files remain available through `search_files`/`read_file`; show whether an answer came from an attachment or the workspace. Attachments can be linked to a task before it starts or while paused.

Build the provider adapter around structured tool IDs, parsed arguments, finish reasons, usage and retryable errors. For Qwen3.8-27B, test a suitable local quant and a realistic context size on this RX 9070 XT/61 GiB RAM machine instead of assuming the published 262k context fits in memory. Tune thinking/non-thinking, sampling, output reserve, tool schema size and compaction from measured runs. Use a small task suite: fix a bug, build a small app, recover from a failed command, use a document, verify browser output, and resume after interruption. Score task completion and actual evidence, not just fluent prose.

Add a subagent task schema and parent/child event relationship for later. Keep the dispatch capability disabled by default and concurrency at one on this machine; no subagent tool is offered to the model until explicitly enabled. This keeps the architecture ready without loading another model concurrently.

**Acceptance:** The agent completes a multi-step coding task and reports changed files plus verification; it continues after an early prose reply when work remains; it can read an attached PDF/text document; a repeated failed tool call yields a different approach or a clear blocker; a restart does not erase task progress. No subagent runs under the default configuration.

### 3. Consolidate tools and permission behavior

Use one registry for model schema, UI label, executor, risk class and result renderer. Give the model only tools relevant to its mode and current task. Keep core file/search/shell/browser/server tools in Agent. Retain Markdown, source links, images, file artifacts, tables/charts and Mermaid diagrams as useful output types. Retire model-callable weather, map, crypto, currency, dictionary, Wikipedia, YouTube, npm, Hacker News, news, countdown, QR, color palette and dashboard cards after checking actual usage. Historical `duckwidget` messages still render or get a stable fallback; removing a tool must not corrupt old conversations.

Make “full autonomy” an owner-selected Agent permission profile scoped to a project sandbox: local reads, edits, commands, dependency installation and verification may proceed unattended. Keep an audit trail and a working Stop control. Publishing, pushing, deploying, deleting outside the workspace and credential access require separate explicit scope. Treat web pages and repository text as data, not instructions. These boundaries let small models make progress without approval stalls while keeping side effects legible.

**Acceptance:** Tool lists are short and mode-specific; permissions shown in the UI match actual execution; old chats still open; every unattended write/command appears in a run timeline; shell output and errors remain inspectable.

### 4. Redesign the application shell and mascot

Make the sidebar visually quiet and useful: Duckpond/duck identity, Chat–Agent switch, primary New action, searchable mode-specific history or project tasks, then Studio, Models and Settings near the bottom. Move Stats, Costs, Providers, themes and diagnostics into Settings; do not give maintenance pages equal navigation weight. On desktop, show a readable main column and an optional project artifact pane. On phone, switch between conversation and artifact views instead of shrinking both. Use one typography and spacing system, restrained accent, visible focus, stable action positions and reduced-motion support.

Refine the existing pixel duck silhouette/palette and render it consistently as a brand mark and on welcome/empty/completion states. Use a few purposeful states (idle, working, success, error) tied to real job state. Keep motion subtle and pause it when hidden or reduced motion is requested. The existing animation library can remain an internal asset; the product does not need dozens of competing visible interactions.

**Acceptance:** New users can find Chat, Agent, Studio and Models immediately; active task, model and Stop are always clear; common desktop/phone flows need no More-menu hunt; focus, text contrast and touch targets are usable.

### 5. Rebuild Models and download experience

Split `HubPanel.svelte` into Installed, Discover, Model detail and Download queue views backed by one server-side installation record. A compact row shows model name, task, variant, size, status and one primary action. The detail pane shows exact files/components, license, disk cost, measured or explicitly estimated RAM/VRAM need, backend compatibility, and steps to repair. Use explicit states: Not downloaded → Downloading → Downloaded → Dependencies missing/Ready to load → Loaded → Verified by a real task. A file's presence cannot become a green “works” badge by itself.

Make downloads resumable and identifiable across restarts, verify checksums/required companions, expose retry/cancel/logs, and avoid duplicate transfers. “Use in Chat” or “Open Studio” appears only when the chosen variant has a compatible runtime path. For image models, respect the existing owner decision to focus on Qwen-Image 2.1; do not add other image families as part of the redesign.

**Acceptance:** A partial GGUF, missing media encoder, unsupported runtime, interrupted download and successful load each produce the right distinct status and next action. The page is usable on phone and does not bury the download queue.

### 6. Harden image generation and resource control

Give the bridge a versioned model manifest and explicit load states (unavailable, installed, loading, warm, busy, unloading, error). Submit media work by stable job ID, persist the bridge-side result or an artifact pointer, and add inspect/cancel/result endpoints so Duckpond can reconcile after either service restarts. Publish completed files atomically. A load or unload request should be idempotent, expose actual memory/device state, refuse to evict a running job, and release tensors/cache on cancellation or idle according to an owner-visible policy.

Use a single admission policy for text and image work on the 16 GiB GPU. Make queue state, selected model, expected cold-load time, actual generation phase and elapsed time visible. Do not report fabricated percentages while loading. Preserve original and improved prompts, seed, model revision, quant, dimensions and settings with each result. Keep Fast/Balanced/Quality/Custom but calibrate estimates from real runs. Compare full and Q4 Qwen-Image 2.1 paths for load time, memory, speed and visual quality before choosing a default; avoid automatic quality downgrade.

**Acceptance:** A job survives tab close, service restart and a lost proxy connection; duplicate submit cannot generate twice; cancel/unload leaves the runtime healthy; a completed artifact remains in the gallery with reproducible settings; chat can run again after Studio releases the GPU.

### 7. Production gate

Add additive SQLite migrations, bounded event retention, backups, per-user quotas, health/readiness diagnostics, structured error logs and a deployment rollback path. Pin the Podman coding image and the media Python environment. Validate auth/ownership on jobs, artifacts and previews. Use isolated preview origins and reconcile managed server/browser lifetimes. Remove abandoned code and dependencies once feature usage and old-message compatibility are accounted for.

**Release gate:** End-to-end desktop/phone tasks with a real local model; Cloudflare reconnect; restart/fault injection at model call, tool dispatch, bridge submit and artifact save; recovery of partial downloads; one coding benchmark pass on the chosen Qwen quant; image load/generate/unload cycles; accessibility and bundle review. Deploy only after the current worktree is understood and each phase has a rollback point.

## Reference basis

- MiniMax Code's public CLI supports resumable sessions, headless execution, subagents, permissions and custom/local model limits: https://github.com/MiniMax-AI/minimax-code . Use its execution and context management as design references; no wholesale dependency is needed.
- Qwen's official model card lists Qwen3.8-27B's native context and suggested sampling; local usable context and coding performance still require measurement: https://huggingface.co/Qwen/Qwen3.8-27B .
- Cloudflare recommends polling for long HTTP processes; Tunnel streaming requires `Content-Type: text/event-stream`: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/ and https://developers.cloudflare.com/tunnel/troubleshooting/ .
- Existing Duckpond groundwork: `WORKSPACE-OUTLINE-2026-09-21.md`, `IMPLEMENTATION-2026-09-21.md`, `CPU-AND-HARNESS-2026-09-22.md`, `IMAGE-PRESETS-2026-09-22.md`.
