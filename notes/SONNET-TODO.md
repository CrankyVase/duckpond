# SONNET-TODO — finish the 2026-07-11 batch

Everything in this batch is ALREADY IMPLEMENTED and deployed (service restarted,
frontend rebuilt). Your job: fix ONE remaining bug, then run the verification
checklist. Do not redesign anything.

## Standing rules (do not violate)
- NO emoji icons anywhere in the UI — Lucide icons or pixel-art sprites (lib/pixel.js) only.
- Never touch the `cranky` account (user id 1) or its password. Test with
  `ducktest` / `duckpond-test-9182` (friend role). If you need owner APIs,
  insert a temp session row for user 1 into `sessions` via sqlite3 and DELETE it when done.
- Any `podman run`/`start` from server code must stay wrapped in
  `systemd-run --user --scope --collect` (see sandbox.js) — do not "simplify" that.
- Server binds via systemd unit; don't change HOST/ports.
- Rebuild UI: `cd web && npx vite build`. Deploy: `systemctl --user restart duckpond`.
  Health: `curl http://127.0.0.1:3000/api/health`.
- Headless Chrome CDP on :9223. Ready-made drivers in the repo owner's scratchpad
  are gone after session end — write your own tiny CDP script if needed, or test manually.

## THE BUG: long write_file tool calls get truncated

Symptom: agent runs 12 and 13 (see `agent_runs` / `agent_events` tables) both
died while streaming a large `index.html` into `write_file` arguments. After
~90–110s of streaming (~3.5–4.5k tokens at ~40 tok/s), the SSE stream from the
router ended cleanly, leaving `tool_calls[].function.arguments` as truncated,
unparseable JSON. The loop now feeds back "ERROR: arguments not valid JSON —
retry", but the model can never fit a big file under the cap, so runs fail.

Evidence gathered:
- No timeout in `server/src/llama.js` (plain undici fetch; bodyTimeout is
  300s of inactivity — stream was active, so not it).
- Router model ctx is 32768 (`--ctx-size`), prompt was only ~2–4k tokens, so
  it's not context exhaustion.
- `server/src/routes/chat.js` sends `max_tokens: -1` in `params` for every
  chat/agent call. PRIME SUSPECT: llama-server (router b9625) clamping
  `max_tokens: -1` to a ~4096 default (`n_predict`). 4096 tokens ≈ the
  observed cut points. `finishReason` IS captured by `streamChatInner` but
  never logged or stored, so we never saw it.

Fix plan:
1. In `server/src/routes/agent.js` `agentLoop`, include `finish_reason` in the
   stored `assistant` event, and log it. Same in chat.js for the first call.
2. Reproduce: as ducktest, new chat on `qwen3-coder-next-q4-k-m`, prompt
   "make me a tip calculator web page in a single html file". Watch
   `sqlite3 data/duckpond.db "SELECT type,substr(json,1,120) FROM agent_events WHERE run_id=(SELECT MAX(id) FROM agent_runs) ORDER BY id"`.
3. If finish_reason = 'length': stop sending `-1`; send an explicit large
   budget (e.g. `max_tokens: 16384` when tools are offered, and for plain chat
   either omit the field or use the same number). Check llama-server docs/behavior
   for `-1` semantics first — if `-1` is honored and the cut comes from
   somewhere else (router preset `--n-predict`, proxy), fix THAT instead.
4. Re-run the repro until a run completes end-to-end: PLAN.md diff + index.html
   diff + a run_command verification step + final summary, run status `done`.

## Verification checklist (all features are in; confirm they look/behave right)

1. **Stop mid-run**: start a project run, hit the stop button while it's
   writing. Expect: chat keeps a message with the run card attached (events
   preserved, card expanded), run status `stopped`, NOTHING vanishes. Refresh:
   still there (server saves an assistant message too — if you see a duplicate
   partial next to the server one after refresh, that's a known cosmetic issue;
   note it, don't fix unless trivial).
2. **Plain-chat restraint**: in the SAME conversation (workspace exists), ask
   "what's the difference between let and const? just explain" → expect a
   normal markdown answer, NO tool calls, message has no run card.
3. **Gate restraint**: fresh chat, "show me a quick example of a python list
   comprehension" → expect plain answer, no start_project call.
4. **Invite links UI**: as temp owner session in browser — Settings → Users &
   access → Create invite link (copies to clipboard), link row shows "7d left",
   revoke works. Open `/invite/<token>` in a private tab: form renders, short
   password rejected, good signup lands in the app signed in; reusing the link
   shows "already been used".
5. **Core prompt UI**: Settings → Core prompt section (owner only): edit, save,
   "Default" button restores stock text, "Customized." indicator toggles.
   Confirm it reaches the model: set core prompt to include a marker like
   "Always start your reply with QUACK:", send a chat, check the reply, then reset.
6. **Live kick**: already verified working; only re-test if you touch auth.
7. **Favicon**: tab icon is an animated pixel duck (paddling; laptop frames
   while a reply streams). Check `link[rel=icon]` href swaps between data URLs.
8. **Duck dabble**: on the Welcome screen the swimming duck occasionally tips
   tail-up for ~2s (dive1/dive2 frames).
9. **Chat file rail**: after a project run, the right-side PROJECT FILES rail
   lists PLAN.md + written files; peek overlay opens read-only.
10. `node --check` every touched server file; `npx vite build` must be clean;
    zero console exceptions in the browser during all of the above.

## What was shipped in this batch (context, don't redo)
- Live kick: global 401 → `dp:unauthorized` event → reload (web/src/lib/api.js, App.svelte).
- Never-lose-work: chat.js agent branch no longer throws on stop/error — it
  always inserts the assistant message with `run_id` and honest status text;
  client Chat.svelte `finally` attaches `run_id` to the local partial message.
- start_project gate: chat offers ONLY start_project until the conversation
  has a workspace; calling it creates the workspace (name slugified from the
  model's arg), writes PLAN.md from the `plan` arg, emits gate events AFTER
  subscribing (ordering matters — they must be visible live), rebuilds the
  transcript under ACTIVE_POLICY, then agentLoop runs with the full toolset.
- Policies: GATE_POLICY / ACTIVE_POLICY in chat.js; agent rules incl. "keep
  PLAN.md current".
- Core prompt: server/src/settings.js (DEFAULT_CORE_PROMPT + app_settings
  helpers), prepended in buildPrompt, GET/PUT /api/admin/settings, editor in
  SettingsPanel.
- Invites: `invites` table, POST/GET/DELETE /api/auth/invites (owner),
  GET/POST /api/auth/invite/:token (public, single-use burn with race
  re-check), Invite.svelte page routed by pathname in App.svelte.
- Hardening: truncated tool-arg JSON → explicit retry error (agent.js);
  write/read_file require `path`; createWorkspaceRow wipes stale host dirs
  (rowid reuse); chat SSE `send()` is dead-socket-safe; context-count and
  auto-title skipped when the client aborted.
- Duck: dive1/dive2 frames (pixel.js), occasional dabble in swim mood
  (Duck.svelte), animated favicon (lib/favicon.js, started in main.js).
