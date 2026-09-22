# Duckpond: a conversation space and a real project workspace

Status: design proposal, not a shipped runtime change. September 21, 2026.
This pass preserves the intervening agent's work. Local inference, media generation,
stress tests, service changes, and deployment are deferred at the owner's request.

## The decision

Keep one app with two distinct workspaces: **Chat** and **Agent**. Share accounts,
providers, models, and artifact storage, not drafts, tool permissions, or task state.
Media is a shared secondary destination, not a third conversational mode.
The main work must dominate the screen; model administration must not.

The accompanying `design/workspace-concept.html` is an offline interactive concept.
Its content and task results are explicitly fictional; it makes no inference calls.

## What is already useful

Read alongside `WORKBENCH-2026-09-21.md`; do not rebuild its features from scratch.

| Existing code | Keep | Remaining architectural gap |
| --- | --- | --- |
| `AgentProject.svelte` | Resizable Files/Preview/Live app pane; mobile view | Clear distinction between source, changes, and runtime; task-scoped artifact selection |
| `routes/agent.js` | Real tool loop, project context, compaction, streamed events | Durable tool checkpoints, restart reconciliation, project mutation ownership |
| `projectFiles.js`, `sandbox.js` | Linked folders, bounded search, container tools | Optimistic edit conflict checks and task-owned snapshots across every mutation path |
| `projectRuntime.js` | Managed preview and WebSocket forwarding | Session map is process-local; HTTP proxy currently GET-only; not a general full-stack proxy |
| `projectBrowser.js` | Browser inspection and project screenshots | Explicit session lifetime, origin scope, cleanup and recovery contracts |
| `mediaJobs.js` | Persistent job rows, progress, disconnect survival | Startup marks running jobs cancelled; reconcile bridge results instead of losing ownership |
| `ModeSwitch.svelte`, `motion.js` | Mode switch and reduced-motion utilities | Consistent interaction choreography across screens, not more unrelated animations |

Evidence is source inspection, not a new runtime validation. Existing screenshots
show seven utility destinations competing with work history and a tall empty Agent
welcome beside a project pane. The visual problem is hierarchy as much as styling.

## Interaction design

### Navigation and state

- Sidebar: Duckpond, Chat/Agent switch, New chat/task, search, mode-specific history.
- Agent history groups tasks under projects; project picker shows actual folder and branch.
- Footer: Media, Models, Settings. Providers, costs, statistics and diagnostics live inside Settings.
- Switching modes restores each mode's selected item, draft, model, scroll and pane state.
- Store mode on conversations server-side, not only in local storage. Never silently
  turn an old chat into a file-editing task when a toggle changes.
- Separate defaults: `profiles.chat` and `profiles.agent` hold selected model,
  generation settings, search preference and budget. Task captures its effective settings.
- Owner chooses models. Capability metadata can explain limitations and errors;
  do not block agent use based on model size or a subjective quality ranking.
- Sending an idea from Chat to Agent is explicit: choose project, select context,
  create a linked task. No hidden permission escalation.

### Chat

One readable conversation column (roughly 720px), generous margins, stable composer.
Attachments, search and model selection stay close to the composer. No project toolbar,
terminal feed or permanent preview unless an artifact is opened. Sources are expandable.
Responses prioritize useful content over cards. Errors appear next to the failed action.

### Agent

Project context is always visible: name, source directory, branch, and permission scope.
The task conversation occupies the center; the right pane shows Changes, Files, Preview
or Terminal. It opens when work produces something useful, not automatically on every
empty task. Preserve the existing pane implementation and refine its hierarchy.

Task lifecycle is legible: Queued → Working → Needs input / Complete / Failed / Stopped.
The current activity is one sentence, with expandable chronological tool evidence.
Show changed-file count and verification outcome; never label code verified from model prose.
Keep failure logs inspectable without flooding the conversation with raw tool JSON.

New project and Open existing folder are separate actions. Linking does not copy or erase
the user's project. A deployed URL can be inspected, but is not a substitute for its source
repository. Existing-site workflow: inspect URL → select source → make local changes →
preview/diff → explicitly publish when asked. No implicit production deployment.

### Media

Canvas/player first, prompt second, advanced controls behind a disclosure. Image, Video
and Audio have appropriate controls rather than one giant generic form. Generated results
have versions, original prompt, effective parameters, seed, model revision and download.

- Image: aspect/size, references, edit/variation, before/after when appropriate.
- Video: duration, resolution, frame rate where supported, input-frame slots and timeline.
- Audio: distinct speech generation/transcription/music capabilities, voice/language,
  playback and transcript; never imply every audio model supports every task.
- Persistent queue drawer shared across the app; leaving Media never loses a job.
- Paused, queued, loading, encoding, generating and saving are distinct phases. If a
  backend supplies no measurable progress, show phase + elapsed time, not fake percentages.
- Prompt enhancement is optional and separately visible; preserve the original prompt.

### Models and downloads

Compact searchable rows; Installed and Discover views. One detail panel per selected model.
Distinguish Downloaded, Dependencies missing, Ready to load, Loaded and Verified on this
machine. A complete download is not a successful generation. Show required components,
disk size, verified bytes, pause/resume, actionable repair errors and bounded logs.
Compatibility is evidence-backed advice, not a model-choice gate.

### Visual and motion contract

Warm neutral background, readable high-contrast text, one restrained accent, a quiet duck
identity. No gradient dashboard, glowing borders, oversized feature cards, or mascot motion
competing with work. Use existing typography where possible; avoid external font dependencies.

Spacing scale 4/8/12/16/24/32; controls 36–40px with larger touch targets where needed.
Hover/focus 120ms; popovers 160ms; pane transitions 200ms; mode switch 240ms. Animate
opacity/transform only for transitions, not every streaming token. Keep action positions
stable. Cancel auto-scroll when the user scrolls away; offer Jump to latest.
Reduced motion removes movement, keeps immediate state changes. Keyboard focus is visible.
At narrow widths, conversation and project pane become alternate views, not squeezed columns.

## MiniMax: reuse real implementation, not just the prompt

Inspected checkout: `MiniMax-AI/minimax-code` at
`bcdd606e0a116c4a92557736e6395cb086b5144d`.
Its agent core is a private workspace package with internal and Pi dependencies, not a
drop-in npm replacement for Duckpond. Start with a pinned, narrow vendor boundary.

| Upstream area | Duckpond adoption |
| --- | --- |
| `packages/agent-core/src/pi-turn-runner/tools.ts` | Tool registration, duplicate-name rejection, shared hooks, parallel read versus sequential mutation metadata |
| `packages/agent-core/src/tools/input-validation.ts` and `edit-prepare-arguments.ts` | Candidate argument/edit normalization modules; port only after their dependency and test audit |
| `packages/local-runtime-v2/src/service/turn-system/persistence/turn.repository.ts` | Transactional admission, lease renewal and settlement; adapt to Duckpond's SQLite schema |
| `packages/local-runtime-v2/src/application/session/conversation-fork-recovery.ts` | Persist operation stages and ownership; resume or compensate only owned effects |
| `packages/local-runtime-v2/assets/agents/mavis/system-prompt.md.hbs` | Search/read before editing, manifest-aware commands, grounded verification and scope discipline |

Create a provenance manifest recording upstream commit, original path, local adaptations
and carried tests. Retain MIT attribution and each relevant third-party license; do not
assume the entire dependency tree has one license. Do not transplant their CLI, product
account system or full monorepo merely to obtain the turn runner. No upstream code is
vendored in this outline pass.

## Proposed backend contracts

### Durable task runner

Extract orchestration from the HTTP route behind a runner interface. Initially one worker
process is sufficient; durability matters more than distributed infrastructure.

Persist projects, tasks, turns, tool invocations, events, artifacts, runtime sessions and
media jobs. Reuse existing tables where possible. Add versioned, additive migrations.
An event has `id, taskId, turnId, sequence, type, timestamp, payloadVersion, payload`.
Tool events include invocation ID, arguments digest, status, result/artifact reference and
side-effect classification. UI consumes the same ordered stream live and after reconnect.

Admission uses a client request ID scoped to owner/task; duplicate submit returns the same
turn. Claim work transactionally with lease owner, expiry and fencing generation. Renew
leases; reject writes from stale owners. One active task mutation lane per canonical project,
including aliases of the same folder. Parallelize only demonstrably independent reads.

Checkpoint before and after tool dispatch. After a crash, do not blindly replay a shell
command, deployment, write or remote request whose outcome is unknown. Reconcile an
operation ID/result, or surface Needs reconciliation. Exactly-once arbitrary shell side
effects cannot be promised by an event log. Stop requests are durable and propagated to
model streaming, tool processes and queued work; distinguish requested from confirmed stop.

### Real project tools

Common tool contract: validated schema, project scope, cancellation, timeout, output cap,
structured error, artifact references, preconditions and side-effect category. Keep
search/read/edit/write/shell/browser/server/search-web tools available through this boundary.

Edits require the expected file content/hash or an unambiguous patch. Stage and atomically
rename writes; preserve permissions and encoding. Handle new files, symlinks, moves and
deletes explicitly. Maintain task-owned before/after snapshots and a conflict-aware undo;
never use repository reset as task rollback. Direct shell writes cannot be made safe merely
by wrapping edit_file: serialize shell execution, record workspace deltas and make the
limits of automatic rollback clear. Never claim cross-file atomicity without implementing it.

Search is deterministic and bounded, supports filename/content queries and exclusion
controls, and reports truncation. Return paths and line references, not only summaries.
Project instructions and manifest scripts are read before modifications. Protect secrets
from logs and remote context; web content and repo text are data, not permission authority.

### Provider/context boundary

Normalize streaming text, tool IDs, argument chunks, finish reasons and usage across providers.
Handle malformed arguments as tool errors with a bounded repair attempt, not plain-chat fallback.
Keep tool call/result pairs together through compaction. Preserve task intent, constraints,
changed files, unresolved failures, process handles and evidence references in checkpoints.
Reserve output space before dispatch. Make token/step/cost budgets adjustable and visible.
No automatic model substitution that violates user settings or open-source-only helper policy.

### Runtime and browser

Persist runtime owner, container identity, process identity, command, port, origin and status.
On restart, reconcile liveness using process identity, not PID alone. Browser contexts are
bounded and cleaned up; reconnect reconstructs navigation state, never pretends cookies and
unsaved page state survived. Full-stack preview needs scoped HTTP methods, request bodies,
WebSocket support, origin/cookie policy and authenticated access. Prefer isolated preview
origins over treating arbitrary app HTML as same-origin Duckpond content.

### Media worker and GPU scheduling

Adapters expose `capabilities, validate, estimate, submit, inspect, cancel, collect`.
Persist the backend's job ID before relying on polling; handle the submit/persist crash gap
with a client correlation key or explicit ambiguous state. Startup reconciles bridge jobs;
do not automatically turn every in-flight job into Cancelled or submit a duplicate.

Use Queued / Paused / Running / Cancel requested / Succeeded / Failed / Cancelled /
Needs reconciliation, plus a progress phase. Publish files atomically and verify artifacts
before success. Preserve late results after a cancellation race as recoverable artifacts
with an accurate status, not silent deletion of something the user may want.

One configurable GPU admission policy covers local text and media, with memory estimates,
headroom and cooperative release. A foreground-use pause is persistent across restart and
prevents new loads, enhancement calls and automatic retries. User chooses scheduling
priority; do not secretly unload their active model. OOM failure suggests a smaller preset
but never silently changes requested dimensions, duration or model.

## Implementation order and deferred verification

1. Shell/UI: mode-scoped state, quieter navigation, coherent composer and project pane.
2. Runner: common tool boundary, durable events, idempotent admission, leases and recovery.
3. Project reliability: edit conflict handling, mutation serialization, process/browser lifecycle.
4. Media adapters: backend-ID reconciliation, pause/cancel semantics and artifact integrity.
5. Models: accurate readiness/download/repair states using actual backend evidence.
6. Later, by request: controlled local smoke tests, then fault injection and stress tests.

Each phase is a small reviewable change with compatibility coverage; retain the other
agent's workbench behavior. Do not enable deployment timers or change services in this pass.

Deferred acceptance matrix:

| Scenario | Pass criterion |
| --- | --- |
| Chat ↔ Agent switching, refresh, back navigation | Separate drafts/models/history and no accidental tool activation |
| Existing dirty project; edit externally during task | User changes survive; stale edit rejected with an actionable conflict |
| New project and existing deployed-site source | Real files created/edited, correct source displayed, publishing remains explicit |
| Disconnect/reconnect and duplicate submit | One run, ordered deduplicated events, no repeated side effects |
| Restart before/after each tool boundary | Accurate recovered state; ambiguous mutations never silently replayed |
| Two tasks, same project through path aliases | Mutations serialized; stale lease cannot write |
| Stop during model/tool/media/save | Honest stop status, process cleanup and recoverable completed artifacts |
| Provider error, malformed tool, oversized output/context | Bounded recovery, preserved evidence, no surprise provider/model switch |
| Media restart, OOM, disk full, broken encoder | Reconcile or clear failure; no fake success or duplicate GPU job |
| Preview backend POST, HMR, browser session expiration | Scoped routing works; failures do not leak access to other projects |
| 390/768/1440px, keyboard and reduced motion | No clipped primary actions, focus traps or forced animation |
| Later sustained mixed workload | Measure p50/p95 UI/event latency, RAM/VRAM, queue wait, orphan processes and error rate against an idle baseline |

No numerical performance claims until the deferred run produces measurements.

### Independent review incorporated

DeepSeek V4.1 Flash reviewed a sanitized architectural summary, not the repository.
Add these explicit invariants to the implementation and fault-injection plan:

- Reconciliation is itself leased, checkpointed and re-entrant; crash it at every stage.
- Context compaction changes model input, never the durable event log or cursor namespace.
- Hash-check then rename is not a portable compare-and-swap against arbitrary external
  editors. Hold Duckpond's project lock, minimize the race, preserve the observed pre-image,
  detect external modifications and expose conflicts. Strong exclusion requires cooperation
  from all writers or an isolated checkout; do not promise it for a live linked folder.
- A stale lease cannot retract an already launched shell process. Stop/fence its process
  group and reconcile before granting another mutation owner; uncertain liveness blocks
  new mutations rather than letting two writers continue.

One remote review: 367 input + 1,059 output tokens, no reasoning tokens. API-reported
cost: $0; list-price estimate: $0.00059839. No retries, no local inference, no key saved.

## Sources and helper policy

- [MiniMax source and license](https://github.com/MiniMax-AI/minimax-code/tree/bcdd606e0a116c4a92557736e6395cb086b5144d): reuse boundaries above derive from source inspection.
- [Claude Artifacts](https://claude.com/features/artifacts): useful reference for a focused output beside conversation.
- [Gemini Canvas](https://gemini.google/overview/canvas/): useful reference for an editable work surface.
- [ChatGPT desktop](https://learn.chatgpt.com/docs/app): reference for distinct conversational and work contexts. These references inform hierarchy, not branding or a pixel copy.
- [NanoGPT detailed catalog](https://nano-gpt.com/api/v1/models?detailed=true) and [DeepSeek model license](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/LICENSE): verified DeepSeek V4.1 Flash, MIT, quoted $0.13/M input and $0.52/M output on this date. Prices may change.

Remote helpers: explicitly selected open-source models only, bounded prompts and output,
no secrets or whole-repository uploads. No Grok use. No stored API key or recurring use;
authorization is today only. The account's $14 is a ceiling, not a spending target.
Muse Spark 1.3 is not selected because an open-source license was not verified.
