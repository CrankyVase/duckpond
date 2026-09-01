# Model Hub 2 + Media Studio — handoff doc (HUB-2)

> Covers the Unsloth-inspired Model Hub overhaul: search-bar removal,
> multi-job download manager, image/video/audio bridge, and the Media Studio.
> Build on top of NEXT-STEPS.md (stages 1–19). Prod deploys from `main`
> (auto-deploy timer, every 2 min, via `deploy.sh`).

## 0. Golden workflow rule (from the user)

**Push to `main` whenever new features land** — the live site auto-deploys
from `main` within ~2 min. Don't sit on unpushed work; "not finished" is fine,
the user would rather see progress live than wait.

## 1. Why search bars were removed

Password managers autofilled into every text input, including search fields.
Rather than fight autofill heuristics, ALL search bars were removed from:
Sidebar, ModelPicker, HubPanel, SettingsPanel, ProvidersPanel, ThemeStudio.
Replaced with curated chips/dropdowns/paste-repo rows. **Do not re-add free
text inputs** — if search is ever needed again, use a paste-into-model or
dropdown pattern the user approves first.

## 2. Download manager — `server/src/downloadManager.js`

Unsloth-style multi-job downloads. The `hf` CLI (v1.19.0) does the transfer;
we add orchestration around it:

- **Registry** keyed `repo::variant`. Multiple repos download concurrently;
  one repo = one job (variants collapse into the repo job).
- **Worker** = subprocess `hf download <repo> <variant>`; we do NOT parse its
  stdout for progress (unreliable) — instead **disk-scan progress**: poll the
  real size of `models--org--name` under `$HF_HOME/hub` every 2 s and diff
  against the manifest's expected size.
- **Claim/adopt**: a job already running (from a previous server boot) is
  adopted, not double-spawned.
- **Cancel**: SIGTERM → 5 s → SIGKILL watchdog. `huggingface_hub >= 1.18`
  removed byte-resume, so a cancelled job restarts from scratch.
- **Orphan reap on boot**: `reapOrphans()` in `index.js` kills any leftover
  `hf download` processes not owned by a live job.
- **State** persists in `$HF_HOME/.duckpond-downloads/` so the UI can show
  finished jobs across restarts.

Endpoints (all under `/api/hf`): `GET /downloads`, `GET /download/:id`,
`POST /download`, `POST /download/cancel/:id`, `POST /downloads/clear`.

**Gotcha:** the school network blocks huggingface.co — all HF API calls must
ride the server proxy, never the browser.

## 3. Media bridge — `server/image-bridge/bridge.py`

Runs as a systemd user service (`image-gen-bridge-8765.service`) under
**Unsloth Studio's own venv** (`~/.unsloth/studio/unsloth_studio/bin/python`)
so torch+ROCm+diffusers+transformers are shared, not duplicated. Listens on
`:8765`, OpenAI-ish contract:

- `GET /health` → discovered models + per-task classification
- `GET /v1/progress?since=N` → job progress
- `POST /v1/images/generations`, `/v1/videos/generations`,
  `/v1/audio/generations`, `/v1/audio/speech`

Models are **discovered straight out of the shared HF cache** (`HF_HOME`):
any repo with `model_index.json` whose `_class_name` ends in `Pipeline` is
classified image/video/audio by class name. Download through the Hub's
Image/Video/Audio tabs → it shows up in the bridge with zero wiring.

- **Video encode** goes through **PyAV** (`av` — already in the venv), NOT
  imageio (imageio/imageio-ffmpeg are now installed too and are a fallback
  path, but PyAV is primary — `_encode_video_mp4`).
- **Audio** writes WAV via `soundfile` (installed).
- One GPU → one job at a time (`GEN_LOCK`); cancel via `CANCEL_TAGS` checked
  between denoise steps.
- Node client is `server/src/imagegen.js` (`generateViaBridge`), routes in
  `server/src/routes/images.js` (SSE generate endpoint, media files land in
  `server/data/media/`, images in `server/data/images/`).

## 4. UI — Hub + Media Studio

- `web/src/lib/downloads.svelte.js` — shared Svelte 5 `$state` store, polls
  `/api/hf/downloads` every 1 s while jobs are active. Used by HubPanel.
- `web/src/components/HubPanel.svelte` — paste-repo row (no search box!),
  Discover/On Device tabs, capability chips, per-variant Download/Running/On
  device state buttons, stacked concurrent-job progress bar.
- `web/src/components/MediaPanel.svelte` — unified image/video/audio studio:
  task tabs, model picker per task (from bridge `/health`), prompt + size/
  steps/seed (image), frames/fps (video), duration (audio), SSE progress,
  result gallery with lightbox.
- Routing: `router.js` parses `/media`; `App.svelte` maps view `media` →
  MediaPanel. Sidebar has the Media nav item.

## 5. Verification status (as of this doc)

- `node --check` on all touched server files ✅
- `python -m py_compile image-bridge/bridge.py` ✅
- PyAV encode smoke test (24-frame mp4) ✅
- `cd web && npm run build` ✅
- Live site serving latest `main` sha (`GET /api/version`) ✅
- Bridge `/health` discovers cached models (FLUX.2-klein, SDXL, …) ✅
- **NOT yet tested end-to-end**: an actual video generation through the UI
  (diffusers video pipelines are heavy; first run downloads VAE/text-encoder
  subfolders if missing), audio generation, and voice/music paths.

## 6. Known limitations / next up

- Video pipelines (LTX/Wan/CogVideoX/…) need VRAM headroom — RX 9070 XT
  16 GB should run the small variants; add quantized/offload options if the
  big ones OOM.
- No i2v (image-to-video) yet — bridge task map has t2v only.
- Media Studio has no gallery persistence across page loads beyond the
  `images` table rows; consider a media tab in FilesPanel or dedicated store.
- `hf` CLI cancelled jobs restart from zero (upstream limitation).
- Voice cloning (SpeechT5/VITS/Bark) and MusicGen are wired in the bridge's
  task map but have no dedicated UI yet — extend MediaPanel's audio tab.

## 7. If something breaks

- Bridge dead → `systemctl --user status image-gen-bridge-8765` and
  `journalctl --user -u image-gen-bridge-8765 -n 100`.
- Downloads stuck → check `$HF_HOME/.duckpond-downloads/`, then
  `pgrep -af "hf download"`, then restart `duckpond.service` (reap runs on
  boot).
- Deploy stale → compare sidebar sha vs `git rev-parse --short HEAD`; timer
  fires every 2 min (`duckpond-deploy.timer`).
