# OPUS-IMAGE-TODO — finish the in-chat image generation feature

Fable built the image pipeline end-to-end (bridge live preview + Image studio,
both VERIFIED working) and half of the in-chat `generate_image` tool. Your job
is the remaining half: the chat.js handler branch + the chat UI, then verify.

## CRITICAL — read first

The non-workspace tool offering is deliberately DISABLED until you implement
step 1 (otherwise a generate_image call would fall into the agent-gate branch —
`gateCall = res.toolCalls[0]` fallback — and spawn a bogus project workspace).
Two `TODO(OPUS-IMAGE-TODO.md)` comments in chat.js mark the exact lines: after
step 1 is implemented, (a) offer `[START_PROJECT_TOOL, GENERATE_IMAGE_TOOL]`
when there is no workspace, and (b) include IMAGE_POLICY in withToolsPolicy for
non-workspace conversations too. Workspace conversations already offer the tool
via AGENT_TOOLS and execTool handles it — that path is live.

## Standing rules (do not violate)
- NO emoji icons in the UI — Lucide icons or pixel sprites (lib/pixel.js) only.
- Never touch the `cranky` account (user id 1). Test with `ducktest` /
  `duckpond-test-9182`. Owner APIs: insert a temp session row for user 1 via
  sqlite3, DELETE it when done.
- podman run/start from server code stays wrapped in `systemd-run --user
  --scope --collect` (sandbox.js) — do not touch.
- Rebuild UI: `cd /home/lewis/duckpond/web && npx vite build`.
  Deploy: `systemctl --user restart duckpond`. Health: `curl 127.0.0.1:3000/api/health`.
- Do NOT touch the image bridge (`/var/home/cranky/llama-local-models/image-backend/`)
  — bridge.py + generate_once.py already have live-preview support, deployed
  and verified (`GET :8765/v1/progress`, preview.png latent frames).

## What already works (don't redo)
- Bridge: POST /v1/images/generations accepts `tag` + `enhance:false`; GET
  /v1/progress returns {active, tag, phase, progress{step,steps,seq}, preview_b64}.
  Phases: starting/enhancing/unloading/generating + container-side
  loading/denoising/decoding/done. SDXL (Juggernaut, the default) streams real
  latent preview frames — verified 10 frames over a 14-step run. flux2 models
  are progress-only (packed latents; fine, leave it).
- server/src/imagegen.js: `generateViaBridge({userId, prompt, model, size,
  steps, n, negative, enhance, onProgress})` → saves PNGs to data/images/ +
  `images` table, returns {images:[{id,url}], enhanced, model_used}. onProgress
  gets {type:'progress',...} and {type:'preview', b64, seq}.
- routes/images.js: /api/images/models, /api/images (gallery), /api/images/:id/file,
  DELETE, POST /api/images/generate (SSE). All verified via curl as ducktest
  (images 1 and 2 in the DB are from those tests).
- Web: ImageStudio.svelte (studio view w/ live preview + gallery), lib/images.svelte.js,
  Topbar image button, App routing. Built cleanly; NOT yet browser-verified.
- agent.js: GENERATE_IMAGE_TOOL defined + exported, included in AGENT_TOOLS;
  execTool case 'generate_image' works in agent runs (emits {type:'image'} run
  events). chat.js: imports done, IMAGE_POLICY added to withToolsPolicy, tools
  param offers [START_PROJECT_TOOL, GENERATE_IMAGE_TOOL] when no workspace.

## Step 1 — chat.js: inline image branch (REQUIRED BEFORE RESTART)

In the POST /api/conversations/:id/chat handler, the tool-call handling is:

```js
if (toolsOn && res.toolCalls?.length) { ...agent run branch... }
```

Insert a NEW branch BEFORE it (so it wins) for pure image turns:

```js
if (toolsOn && res.toolCalls?.length
    && res.toolCalls.every((t) => t.function.name === 'generate_image')) {
```

In that branch (no run, no workspace):
1. Build `followup = [...promptMessages, { role:'assistant', content: res.content ?? '', tool_calls: res.toolCalls }]`.
2. For each call (cap at 2): parse args (`JSON.parse` in try/catch — on bad
   JSON the tool result is an ERROR string asking to retry, same style as
   agent.js). With a good `args.prompt`:
   - `send({ type:'image_job', prompt: args.prompt })`
   - `await generateViaBridge({ userId: req.user.id, prompt: args.prompt,
     size: args.size ?? '1024x1024', onProgress: (ev) => send(ev.type === 'preview'
       ? { type:'image_preview', b64: ev.b64 }
       : { type:'image_progress', phase: ev.phase, step: ev.step, steps: ev.steps }) })`
   - collect markdown: `mdImgs.push(r.images.map((im) => `![generated image](${im.url})`).join('\n\n'))`
   - `send({ type:'image_done' })`, then also
     `send({ type:'delta', text: '\n\n' + md + '\n\n' })` so the image pops
     into the live streaming view immediately.
   - tool result: "Image generated and already shown to the user. Reply with
     one or two short sentences about it — no links, don't repeat the prompt."
   - on generateViaBridge error: `send({type:'image_done'})` + tool result
     `ERROR: image generation failed: <msg>. Tell the user.`
   - push `{ role:'tool', tool_call_id: call.id, content: toolResult }` to followup.
3. Second `streamChat` on `followup` with plain `params` (NO tools) + same
   onDelta/abortSignal → short commentary. Wrap in try/catch: if it throws but
   an image was made, don't fail the turn.
4. Compose the saved message: `text = [res.content?.trim(), mdImgs.join('\n\n'),
   fin.content?.trim()].filter(Boolean).join('\n\n')` and update
   reasoning/timings/usage from `fin` when present. Execution then falls
   through to the existing insertMessage/done flow — DO NOT duplicate it.

Notes: markdown.js uses marked with no sanitizer → `![](/api/images/N/file)`
renders as `<img>` in Message.svelte already. Aborts: generateViaBridge cannot
cancel a bridge job; if the user hits stop, let the loop finish and save
(never-lose-work). The bridge unloads/reloads LLMs around a job — the followup
chat call just triggers a normal model reload, expected to be slow.

## Step 2 — Chat.svelte: live image block while streaming

In the chat SSE event handler add:
- `image_job` → `app.streaming.image = { prompt: ev.prompt, phase:'starting', step:null, steps:null, preview:null }`
- `image_progress` → update phase/step/steps on that object
- `image_preview` → `app.streaming.image.preview = 'data:image/png;base64,' + ev.b64`
- `image_done` → `app.streaming.image = null`
Also clear it in the finally/cleanup path.

Render inside the streaming assistant message (near where the RunFeed live
block goes): a card with the preview `<img>` (width ~320px, rounded, bordered)
or a shimmer placeholder, plus a mono caption — phase text, or
`step X/Y` when steps are present. Match RunFeed's `.live` styling. Phase
labels: starting→'starting…', queued→'waiting for the GPU…',
enhancing→'polishing the prompt…', unloading→'clearing VRAM…',
loading→'loading the image model…', generating→'generating…',
denoising→step counter, decoding→'decoding…'.

## Step 3 — RunFeed.svelte: render agent-run image events

Add an `{:else if e.type === 'image'}` block rendering
`<img src={e.url} alt={e.prompt}>` (max-width ~340px, rounded, bordered,
clickable link to the url). This covers generate_image inside project runs.

## Step 4 — build, deploy, verify (as ducktest, CDP on :9223 or curl)

1. `node --check` all touched server files; `npx vite build` clean; restart.
2. Image studio in browser: /→ Images button in topbar → generate with model
   `RunDiffusion--Juggernaut-XL-v9`, 768x768, 14 steps, enhance OFF (faster) →
   live latent preview appears and sharpens, progress bar moves, final image
   lands + gallery updates. Zero console exceptions.
3. In-chat: new conversation (default model), "make me a picture of a duck
   wearing a wizard hat" → model announces + calls generate_image → live
   preview card in the message → final message shows the image inline +
   a short comment. Refresh: image still in the message (markdown).
4. Chat restraint: "what is a diffusion model?" → plain answer, no tool call.
5. Gallery: both images from (2)+(3) appear in Images view; delete works.
6. Stop button mid-image-generation: chat may end early but the image must
   still appear in the gallery when the bridge finishes (server keeps saving).

Keep the messaging style of the codebase (comments explain constraints, not
narration). When done, update notes/MASTER-PORT-PLAN.md is NOT related — this
is DuckPond, don't touch ourcraft files.
