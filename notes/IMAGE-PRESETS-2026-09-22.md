# Image presets, ETA projections, Qwen-Image-2.1-only — 2026-09-22

Owner asked for: (1) Fast/Balanced/Quality presets + Custom with ETA
projections on each, (2) Qwen-Image 2.1 only — drop the other image models,
(3) harness tuned for Qwen-Image 2.1 (quality + speed, GPU), (4) a quant if
one exists (Unsloth?), else GPU speedups, (5) a tiny model to improve prompts.

## What shipped

**Presets** (`server/src/mediaEta.js` — single source of truth, re-exported
from `imagegen.js` so `chatflow.js` / `routes/agent.js` keep working):
- Fast: 20 steps, CFG off — quick draft
- Balanced: 40 steps, CFG off — the official Qwen-Image 2.1 recipe
- Quality: 40 steps + true_cfg_scale 2.5 + soft negative
  ("blurry, deformed, low quality, watermark") — better text rendering and
  prompt adherence at ~1.9x cost per step
- Custom: free steps (1–80), free true-CFG (1–4 in UI, 1–6 at the API),
  free negative/seed. Size stays a separate framing decision, as before.

**ETA projections** — new `GET /api/media/estimates?size=&n=` returns
per-preset seconds. Calibration learns from real jobs: each finished image
generation records wall time into `app_settings.media_eta_stats`
(per-step-ms at 1024² + model-load-ms, EMA α=0.35, warm/cold aware).
Uncalibrated fallback: 2.6 s/step + 22 s load. Guided (CFG>1) jobs cost
1.9x per step; cost scales linearly with pixels and image count. Studio
shows `≈ 28s`-style labels on each preset chip; "estimates until the engine
has run a few images" until calibrated (≥2 samples).

**Qwen-only catalog** (`media_catalog.py:is_qwen21_image`): non-Qwen image
pipelines return None from `inspect_snapshot` — FLUX.2-klein, SDXL,
Ideogram, Krea safetensors no longer appear in the media catalog. Verified
against the real hub: image entries are now exactly Qwen/Qwen-Image-2.1
(ready diffusers) + abenzerps/Qwen-Image-2.1-GGUF (ready quant).
Video/audio/TTS untouched.

**Quant — yes, Unsloth-style GGUF, already on disk.** The 3.77 GB
`qwen-image-2.1-Q4_0.gguf` (abenzerps) classifies as new kind `qwen21_gguf`
(quant parsed from filename, Q8_0 preferred when several exist) and loads
via native diffusers `QwenImage21Transformer2DModel.from_single_file` +
`GGUFQuantizationConfig` over the full Qwen/Qwen-Image-2.1 snapshot (which
must stay downloaded — it lends the text encoder + VAE). Quant path keeps
the transformer fully GPU-resident and streams the 17.5 GB Qwen3-VL text
encoder via leaf-level group offload — that is the speed win on the 16 GB
9070 XT. (Unsloth also ships `unsloth/Qwen-Image-2.1-GGUF` Q2_K–Q8_0 and an
INT8 safetensors if a higher rung is ever wanted; Comfy-converted GGUFs may
not map into diffusers `from_single_file` — the loader raises a clear error
telling the user to fall back to the full repo.)
No Lightning/LCM/TeaCache exists for 2.1 (those are for the old 20B model);
40 steps at CFG 1.0 is the intended recipe, so presets follow it.

**Bridge run_job**: steps default to the model's catalog default (40 for
Qwen, was hardcoded 25); `true_cfg_scale` 1.0–6.0 validated and forwarded
only when the pipeline signature accepts it; `negative_prompt` forwarded
only when CFG is actually on (>1.0).

**Tiny prompt improver**: already existed (`promptEnhancer.js`, ≤2B router
model, best-effort). Upgraded the image guide to Qwen-Image-2.1's actual
taste (from the official PE-T2I rewriter): one 120–220-word English
paragraph, third-person "The image is a …", medium+style+subject opener,
positional frame walk, one lighting sentence, one closing summary, quoted
literal text preserved verbatim, no boosters/negations/ratio words.
MAX_TOKENS 300→500, sanitizer cap 1600 chars for image.

**UI** (`MediaPanel.svelte`): Fast/Balanced/Quality/Custom chips with live
ETA under each, True-CFG control (custom only), steps locked to the preset
unless Custom, estimates refetch on size/count change + after submit.
Settings: quality relabeled "Fast · quick draft / Balanced · recommended /
Quality · guided, slower"; image-model picker now lists image-task models
only. VRAM reclaim raised to 12 GiB for QwenImage21 (was blanket 6 GiB).

## Validation (all green, no services restarted by hand)
- `npm test` EXIT=0, zero FAIL (incl. new mediaEta 8/8, mediaJobs 4/4)
- `python3 -m unittest discover -s image-bridge/test`: 54 tests OK
- Real-hub dry run of `scan_models`: 3 image entries, Qwen ready ×2
- `vite build` passes; scratch-DB boot serves `/api/media/estimates` (401
  without auth = registered + guarded)
- Live GPU generation NOT run (bridge holds 11.2 GB resident; first Quality
  run will calibrate ETAs). Estimates will read high until 2+ jobs land.

## Notes for later
- `IMAGE_CPU_MODELS` is empty → Qwen runs on GPU (ROCm). If VRAM ever
  fights the LLM, the Q4_0 quant is the relief valve (3.8 GB transformer).
- 50 GB RAM / full-GPU budget noted: bridge cgroup is 40G max, fits.
- Next候補: Unsloth Q8_0/Q6_K_XL transformer for max quality; download via
  Hub, drop the .gguf next to the Q4_0 — catalog prefers Q8_0 automatically.
