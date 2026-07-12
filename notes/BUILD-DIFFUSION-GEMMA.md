# Build handoff: llama.cpp with diffusion-gemma support (for Sonnet)

**Goal:** produce a `llama-diffusion-cli` (and ideally `llama-server`) binary that
can load `diffusiongemma-26B-A4B-it-Q4_K_M.gguf`, so DuckPond's already-wired
in-chat diffusion path (see below) can actually run the user's model.

This is a **grind-tier build task — run it as Sonnet in its own focused session**
(not a background worker: standing rule = no parallel agents). It's a from-source
GPU compile off an UNMERGED draft PR, so expect to babysit build errors.

## Why this is needed
- The user's model is `diffusiongemma-26B-A4B-it` (unsloth GGUF at
  `/home/lewis/llm-models/llama.cpp-models/unsloth/diffusiongemma-26B-A4B-it-GGUF/diffusiongemma-26B-A4B-it-Q4_K_M.gguf`, 16 GB, valid GGUF, complete).
- Every installed binary (b9625-vulkan, b9966-vulkan) rejects it:
  `unknown model architecture: 'diffusion-gemma'`.
- Support exists ONLY in draft PR **ggml-org/llama.cpp#24423** ("DiffusionGemma
  support"), which is NOT merged as of 2026-07. So no official release binary
  works — it must be compiled from that PR branch.

## The new architecture uses DIFFERENT flags than old LLaDA/Dream diffusion
PR #24423 adds `LLM_ARCH_DIFFUSION_GEMMA` with an Entropy-Bound (EB) decoder +
self-conditioning. Flags per the PR (NOT the old `--diffusion-steps` /
`--diffusion-algorithm` set):
- `-cnv` (conversation/chat mode), `-n 2048` (tokens)
- `--diffusion-visual` (real-time canvas display — the "watch it denoise" bit)
- `--diffusion-eb-max-steps` (default ~48)
- `--diffusion-eb-t-max` / `--diffusion-eb-t-min` (temperature schedule)
- `-ngl N`. **Do NOT pass `--no-warmup`** — invalid on these builds.
Confirm the exact final flag names from `llama-diffusion-cli --help` on YOUR
freshly built binary; the PR was still changing.

## Environment (Bazzite / atomic Fedora — build in a container)
Host is missing `glslc`, Vulkan headers, `ninja`. Host HAS: git, cmake
(~/.local/bin), gcc/g++, make, `hipcc` (ROCm), `vulkaninfo`.
Build inside a distrobox so you get full dev packages without touching the host:

```bash
distrobox create --name llamabuild --image fedora:41
distrobox enter llamabuild
# inside the box:
sudo dnf install -y git cmake ninja-build gcc-c++ \
     glslc vulkan-loader-devel vulkan-headers   # Vulkan path
# OR ROCm path: sudo dnf install -y rocm-hip-devel rocm-comgr-devel hipblas-devel
```

**Backend choice:** the existing prebuilts are Vulkan (`radv`), which is the
proven-working path on this AMD GPU (GPU0 ≈ 16 GB VRAM). Prefer **Vulkan**
unless it fails; ROCm/HIP is the fallback (`hipcc` is present, GPU is gfx-
whatever — check `rocminfo`).

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
git fetch origin pull/24423/head:diffgemma
git checkout diffgemma
cmake -B build -DGGML_VULKAN=ON -DLLAMA_CURL=OFF   # or -DGGML_HIP=ON for ROCm
cmake --build build --config Release -j --target llama-diffusion-cli llama-server
```

## Where to put the result + how DuckPond finds it
- Drop the built tree at `/home/cranky/bin/llama-prebuilt/<buildtag>-vulkan/`
  matching the existing layout.
- DuckPond's diffusion module reads the binary path from env **`DIFFUSION_CLI`**
  (default currently points at b9966). Update the duckpond systemd unit's
  `Environment=DIFFUSION_CLI=...` to the new binary, OR symlink the new binary
  over the default path. Model dir is env `DIFFUSION_MODELS_DIR` (see
  `server/src/diffusiongen.js`).

## Smoke test before handing back (THE crux)
The one thing DuckPond's integration depends on and could NOT be verified without
a loadable model: **does `--diffusion-visual` emit progressive frames to a PIPE
(not just a real tty)?** Test:
```bash
llama-diffusion-cli -m <gemma.gguf> -p "Write one sentence about ducks." \
  -n 48 --diffusion-visual -ngl 20 -cnv > /tmp/out.raw 2> /tmp/err.log
# then check /tmp/out.raw for repeated terminal-clear escapes (ESC[2J / ESC[H):
python3 - <<'PY'
import re; d=open('/tmp/out.raw','rb').read().decode('utf8','replace')
print("clear escapes:", len(re.findall(r'\x1b\[2J|\x1b\[H',d)), "bytes:", len(d))
PY
```
- **Many clear escapes → frames DO stream to a pipe.** DuckPond's
  `diffusiongen.js` CLEAR-splitting parser works as-is. Done.
- **Zero/one → it needs a real pty.** Then DuckPond must wrap the spawn in
  `script -qec '<cmd>' /dev/null`. Tell whoever wires it (or edit
  `diffusiongen.js`'s spawn accordingly — there's a `USE_PTY` note there).

## What's already done on the DuckPond side (don't redo)
- `server/src/diffusiongen.js` — model scan + `generateDiffusion({...,onFrame})`
  callback API (spawn/ANSI-parse/throttle/kill/abort). Binary + model dir are
  env-configurable. Flag set may need a tweak to the EB flags above once the
  real binary exists — there's a `DIFFUSION_ARGS` builder to adjust.
- `chat.js` branches to diffusion when the selected model is a diffusion model
  (detected by `isDiffusionModel()`), streams `diffusion_step` SSE frames.
- Frontend renders the live denoising text inline in the chat thread.
- The old standalone diffusion tab was removed.
So once a working binary is in place + the smoke test passes (adjusting pty/flags
if needed), diffusiongemma should light up in the normal model picker and denoise
inline with no further app work.
