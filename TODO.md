# DuckPond release checklist

Updated 2026-09-23. This is the actionable checklist for the production redesign. The older [`.todo`](.todo) and [Model Hub notes](todo.md) retain historical decisions and completed work; their remaining open tasks are included here. Work is staged in `codex/production-redesign`, not deployed. Check a box only after the behavior is implemented and observed.

## 0. Release and source control

- [ ] Review the staged worktree against the live `main` checkout; separate pre-existing user edits from this redesign before committing.
- [ ] Confirm GitHub `origin/main` has not advanced, create a reviewable checkpoint commit, and push the redesign branch to GitHub.
- [ ] Keep pushing cohesive reviewed checkpoints to GitHub as work continues. Update `main` periodically only after the build/release review and a rollback commit are ready; record each commit and deployment state.
- [ ] Keep the live auto-deploy source untouched until the release gate. Merge or fast-forward into `main` and deploy in a controlled window, then verify rollback can restore the previous version.
- [ ] Keep credentials and the local Cloudflare notes outside commits and logs.

## 1. UI foundation and flat visual system

- [x] Rebuild the sidebar around DuckPond, Chat/Agent, New, searchable mode-specific history, Studio, Models, Settings, and optional pages under More. Preserve keyboard focus and mobile drawer behavior.
- [x] Make the duck visible in the brand and welcome surface; preserve reduced-motion and hidden-tab pauses.
- [x] Remove built-in CSS gradient backgrounds, loading shimmers, weather colors, login backgrounds, voice orb effects, and gradient theme choices. Ignore old saved custom CSS that contains a gradient.
- [ ] Review every desktop, tablet and phone screen for spacing, contrast, tap targets, overflow, keyboard traversal, and screen reader labels. Inspect Sidebar, Chat, Agent project pane, Studio, Models, Settings, login and invite.
- [ ] Review animated duck states during idle, loading, tool work, success, error and Stop. Keep the brand mark still; use motion in the welcome area only where it conveys state.
- [ ] Remove obsolete Theme Studio scene and background controls/code left after the flat-color migration; migrate old saved themes and document the flat-color rule.
- [ ] Complete Speech Lab interaction and accessibility review if that feature is re-enabled.

## 2. Floating hardware monitor

Implementation staged: authenticated metrics endpoint and a movable, resizable, per-user customizable panel. Keep the checks open until real AMD sensors, phone placement, keyboard movement, stale readings and concurrent Studio/Agent use are observed.

- [ ] Add an authenticated server metrics endpoint with one documented sample shape and timestamps. Include CPU usage, load and temperature; RAM used/available/total; swap; GPU utilization, dedicated VRAM used/total, temperature and device name; SSD used/free/total and read/write activity. Add fan speed, GPU power and SSD temperature when a sensor is available. Mark absent sensors unavailable rather than zero.
- [ ] Keep binary memory units labeled GiB and disk units labeled accurately. Distinguish dedicated VRAM, shared GPU memory, and system RAM; avoid counting shared memory twice. Support the installed AMD ROCm/Vulkan hardware and expose other vendors through adapters.
- [ ] Build a small movable, resizable panel with a drag handle, close/minimize control, viewport clamping, keyboard-accessible placement alternative, and a phone layout that does not cover the composer or Stop control. Persist visibility, size and position per user.
- [ ] Let each user show/hide and reorder readings, choose compact or expanded layout, choose refresh interval, set warning thresholds, and reset defaults. Explain each metric and its units in plain language.
- [ ] Poll only while visible, stop on hidden tab, bound history and server work, reconnect after server restart, and render stale timestamps distinctly. Unsloth's floating panel polls every 5 seconds and uses RAM/VRAM bars with unknown values; use that interaction as a reference, then include the requested CPU, temperature and SSD readings. [Unsloth source](https://github.com/unslothai/unsloth/blob/main/studio/frontend/src/components/floating-monitor.tsx).
- [ ] Verify the monitor alongside Chat, Agent approval cards, model downloads, Studio generation and small viewports. Avoid Unsloth's reported overlap with run settings. [Unsloth issue](https://github.com/unslothai/unsloth/issues/6988).

## 3. Server-owned Chat and Agent work

- [x] Commit the Chat user message and linked job before returning `202`; persist a bounded progress snapshot and expose a short job-status request. Reconcile interrupted jobs on restart without duplicating the prompt.
- [x] Let the browser reattach to a server-owned SSE feed, and poll the saved job status if SSE repeatedly drops. Keep proxy interruption separate from explicit Stop.
- [x] Replace Agent's default 80-step terminal cap with renewable work windows. Add a completion recheck and repeated-tool loop guard.
- [x] Add scoped document list/search/read tools and a default-off sequential analysis subagent capability. Keep subagent concurrency at zero by default on this machine.
- [ ] Verify Chat and Agent submission idempotency after a lost POST response and after refresh. Client keys, database uniqueness, and duplicate responses are staged in the redesign branch.
- [ ] Finish chat-tied Agent recovery after Node restart. Safe run checkpoints and Stop intent are staged, but a resumed run must also settle its original Chat job and final conversation message. Keep uncertain tool effects for manual reconciliation.
- [ ] Make Chat and Agent event replay durable across restart, with ordered cursors, bounded retention, and a second-device timeline. Agent events persist; Chat has a process-local event ring and durable folded snapshot.
- [ ] Complete the Agent plan state and UI. Objective, file changes, command evidence and failures are staged; constraints, checklist steps, current step and remaining work still need a reliable update path.
- [ ] Audit timeouts across Fastify, local runtime, model router, provider, browser, media bridge and Cloudflare. Expose legitimate resource ceilings and recovery paths; make command cancellation reliable.
- [x] Resolve inconsistent remote output defaults in `llama.js` and `chatBackend.js`. Both paths now share a 4096-token default unless the caller sets `max_tokens`.
- [ ] Verify per-model maximum reply tokens in Settings with local and remote models. The control and server validation are staged; 0 keeps the automatic default.
- [ ] Reproduce history/tree disappearance and partial-answer behavior through model errors, refresh, tab close, process exit and reconnect. Recovery edits are staged; these scenarios have not been run.

## 4. Chat and coding quality

- [x] Offer only requested useful visual outputs in Chat: chart, table, diagram, slides or CSV. Keep old widget renderers for historical messages.
- [x] Offer direct memory tools only when the user explicitly asks to remember, correct or forget. Keep automatic memory extraction separate.
- [ ] Inventory old widget use; remove dormant novelty tool schemas, builders and Settings toggles after confirming historical messages still render through a fallback.
- [ ] Consolidate model-facing schema, UI label, risk level and executor into one tool registry. Provide small, task-specific tool sets to local models.
- [ ] Tune Qwen3.8-27B on the installed RX 9070 XT/61 GiB RAM machine: choose a feasible quant, measured context and output reserve, thinking mode, sampling, tool schema length and compaction thresholds. Do not assume the published maximum context fits locally.
- [ ] Run a small coding suite with bug fix, multi-file app, failed-command recovery, document use, browser inspection, partial reconnect and task completion. Score actual files/evidence, not just prose.
- [ ] Keep Chat's sourced-answer harness separate from Agent's inspect → plan → act → verify → assess loop. Audit source links, hallucinated tool results and overlong research defaults.
- [ ] Scope Autonomous coding to the chosen project and audit local edits/commands. Keep pushes, publishing, external writes, credential access and dangerous shell commands on separate approval paths.
- [ ] Finish linked-project browser observations, screenshot delivery to the model and UI, preview errors, nested paths, root-relative assets, bundlers, workers and route-based apps.
- [ ] Benchmark equal-context inference latency, attention/batching, prompt caching, allocation and transfer before changing runtime defaults.

## 5. Models and downloads

Implementation staged: file lists, license, free storage, rough GGUF memory planning, partial-cache visibility and post-download snapshot checks. Estimates and unusual repository layouts still need real-model review.

- [x] Rework Model Hub's Installed, Discover and Downloads layout, model metadata, readiness wording and mobile hierarchy. Accept exact pasted Hugging Face repository IDs/URLs.
- [ ] Verify one server-side installation state for each variant: missing, partial, downloading, downloaded, dependencies missing, ready to load, loaded, and verified by a real task. State mapping is staged; real model checks remain.
- [ ] Show exact files, companion encoders/VAEs, license, disk cost, runtime compatibility, measured or clearly estimated RAM/VRAM, and the next repair action.
- [ ] Verify restart recovery, checksum/required-file checks, cancel, retry, duplicate transfer avoidance and partial GGUF handling with real model metadata.
- [ ] Show Use in Chat or Open Studio only when the selected variant has a compatible runtime path; verify load/unload and a real generation before a verified badge.
- [ ] Calibrate the displayed tokens-per-second estimate with measured local runs; keep estimates visibly labeled until then.

## 6. Studio and image lifecycle

Implementation staged: repeatable background load/unload actions, bridge unload guard, cancellation reconciliation, and clear stale ETA. Real generation and VRAM release remain to be observed.

- [x] Show explicit Qwen load/unload controls and simpler Studio resource status. Warm loading starts in the background; generation returns a durable job ID.
- [x] Keep bridge-side result receipts by job tag, reconcile completed work after service restart, and safely requeue work that never reached the bridge.
- [ ] Reconcile an unknown bridge outcome after a crash during denoising without silently regenerating; show an explicit review/retry action. Keep completed artifacts and their seed, prompt, revision, quant and settings.
- [ ] Make load, unload and cancel idempotent and observable. Prevent unload during active generation, release GPU memory after idle/cancel, and verify text chat can use VRAM again.
- [ ] Use one admission policy for text and image jobs on the 16 GiB GPU. Show queue position, cold load phase, elapsed time and measured ETA instead of invented percentages.
- [ ] Compare full and Q4 Qwen-Image 2.1 load time, memory, output speed and quality on this hardware before selecting a default.
- [ ] Complete media adapters for GGUF image/video and conditioning image/video input. Verify real audio/video generation and playable output; finish supported voice/music controls and missing OmniVoice runtime.
- [ ] Verify legacy `/api/images/generate` clients use the returned job-status URL after the endpoint change.

## 7. Production gate

- [x] Run the frontend build and server/Python syntax checks in the isolated worktree. Build passes; unused CSS and large-chunk warnings remain for the bundle review below.
- [ ] Run authorized automated and real-device checks: desktop/phone, Cloudflare disconnect and reconnect, real local model coding, document access, image load/generate/unload, partial download, accessibility and bundle size.
- [ ] Fault-inject restart at model call, tool receipt, approval wait, bridge submit, artifact save and server deployment; verify no silent loss or duplicate side effects.
- [ ] Add bounded event/job retention, database backup/restore, per-user quotas, readiness diagnostics and structured failure logs. Pin the Podman coding image and media Python environment.
- [ ] Validate ownership on jobs, documents, media receipts, artifacts and previews; finish restricted-network map/embed review.
- [ ] Review worktree diff, prepare rollback, push a reviewed checkpoint to GitHub, update `main`, deploy in a controlled window, and record the observed service health.
