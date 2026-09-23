#!/usr/bin/env python3
"""Local OpenAI-compatible media generation bridge for DuckPond.

Runs under Unsloth Studio's own venv (torch+ROCm+diffusers+transformers
already installed and GPU-verified there — see ~/.unsloth/studio/unsloth_studio),
so there's no separate container or dependency set to maintain. Models are
discovered straight out of the shared HF cache (HF_HOME) that `hf download`
(DuckPond's Model Hub), the llama router, and Unsloth Studio all already
write to. Complete supported models are selectable; incomplete downloads and
architectures requiring another adapter are listed with a reason.

Contract (matches server/src/imagegen.js in the duckpond repo):
  GET  /health                     -> {ok, models:{id:{ready,kind}}, default_model}
  GET  /v1/progress?since=N        -> current job's progress
  POST /v1/images/generations      -> blocks until done, {data:[{b64_json}], ...}
  POST /v1/videos/generations      -> blocks until done, {data:[{b64_json}] , ...}
  POST /v1/audio/generations       -> blocks until done, {data:[{b64_json}] , ...}
  POST /v1/audio/speech            -> blocks until done, {data:[{b64_json}] , ...}
"""
import base64
import io
import inspect
import gc
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import torch
import numpy as np

# Native speech support is optional. Diffusion and MusicGen do not depend
# on Studio's private image/video modules remaining import-compatible.
try:
    from studio.backend.core.inference.native_audio import (
        NativeAudioBackend,
        native_audio_type_from_local_path,
    )
    UNSLOTH = True
except Exception as _e:
    print(f"[bridge] unsloth modules unavailable ({_e}) — using built-in heuristics")
    UNSLOTH = False

HF_HOME = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface")))
HUB_DIR = HF_HOME / "hub"
DEFAULT_MODEL = os.environ.get("IMAGE_DEFAULT_MODEL", "")
PORT = int(os.environ.get("IMAGE_BRIDGE_PORT", "8765"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"  # ROCm surfaces as "cuda" in torch

GEN_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
STATE = {"tag": None, "active": False, "phase": None, "step": None, "steps": None,
         "image": None, "n": None, "enhanced_prompt": None,
         "started_at": None, "eta_seconds": None, "elapsed": None,
         "preview_b64": None, "preview_seq": 0}
CANCEL_TAGS = set()  # tags a client has asked to stop — checked between denoise steps
PENDING_TAGS = set()  # requests admitted by HTTP but waiting for GEN_LOCK
RESULT_DIR = Path(os.environ.get("IMAGE_BRIDGE_RESULT_DIR", str(HF_HOME / "duckpond-bridge-results")))
RESULT_TAG = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MODEL_OPERATION = None
STALL_LIMIT_SECONDS = 300.0
STALL_EXIT_SECONDS = float(os.environ.get("IMAGE_STALL_EXIT_SECONDS", "600"))
CPU_MODELS = set(filter(None, os.environ.get("IMAGE_CPU_MODELS", "").split(",")))
_STALL_LOGGED = set()


def touch_progress(**kwargs):
    with STATE_LOCK:
        STATE.update(kwargs)
        if kwargs:
            STATE["last_progress_at"] = time.monotonic()
            STATE["stalled"] = False
        now = time.time()
        tick = time.monotonic()
        if kwargs.get("active") is True or kwargs.get("phase") == "generating":
            STATE.update(_last_step=None, _step_at=None, _step_durations=[])
        if kwargs.get("phase") == "denoising" and kwargs.get("step") is not None:
            step = kwargs["step"]
            previous, at = STATE.get("_last_step"), STATE.get("_step_at")
            if previous is not None and step > previous and at is not None:
                durations = STATE.get("_step_durations", [])
                STATE["_step_durations"] = (durations + [(tick - at) / (step - previous)])[-6:]
            if previous != step:
                STATE.update(_last_step=step, _step_at=tick)
        started = STATE.get("started_at")
        STATE["elapsed"] = max(0, now - started) if started else None
        STATE["eta_seconds"] = None
        durations = STATE.get("_step_durations", [])
        step, steps = STATE.get("step"), STATE.get("steps")
        if STATE.get("phase") == "denoising" and len(durations) >= 2 and step and steps:
            # Exclude loading, text encoding and the first (warm-up) step.
            # Only show an estimate after two measured sampling intervals.
            rate = sum(durations) / len(durations)
            remaining = max(0, steps - step)
            STATE["eta_seconds"] = max(0, rate * remaining - (tick - STATE["_step_at"]))


_loaded = {"id": None, "pipe": None, "kind": None}


class JobCancelled(Exception):
    pass


def _result_path(tag):
    if not isinstance(tag, str) or not RESULT_TAG.fullmatch(tag):
        return None
    return RESULT_DIR / f"{tag}.json"


def _save_result(tag, result):
    """Keep a finished result until Duckpond confirms it is in the library."""
    path = _result_path(tag)
    if path is None:
        return
    RESULT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = RESULT_DIR / f".{tag}.{threading.get_ident()}.partial"
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(result, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _prune_results():
    if not RESULT_DIR.is_dir():
        return
    cutoff = time.time() - 7 * 86400
    for path in RESULT_DIR.glob("*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- discovery
def _heuristic_task(cls):
    """Fallback classifier when Unsloth modules are unavailable."""
    lower = (cls or "").lower()
    if "video" in lower or "ltx" in lower or "wan" in lower or "cogvideo" in lower or "hunyuan" in lower or "mochi" in lower or "allegro" in lower:
        return "video"
    if "audio" in lower or "music" in lower or "stableaudio" in lower or "audioldm" in lower:
        return "audio"
    return "image"


def discover_models():
    # Discovery is metadata-only: health checks never import model code or
    # download weights. A config.json alone is not a completed model.
    from media_catalog import scan_models
    models = scan_models(HUB_DIR, native_available=UNSLOTH)
    import diffusers
    for model_id, info in models.items():
        if info['ready'] and info['kind'] == 'diffusers' and getattr(diffusers, info.get('class', ''), None) is None:
            info.update(ready=False, reason=f"Install a Diffusers version with {info.get('class')}")
        if info['ready'] and info['kind'] == 'native_audio':
            try:
                _tts_config(model_id, info)
            except RuntimeError as e:
                info.update(ready=False, reason=str(e))
    from comfy_media import catalog
    models.update(catalog())
    return models


def resolve_model(requested, task=None):
    from media_catalog import select_model
    return select_model(discover_models(), requested, task or "image", DEFAULT_MODEL)


# Single NativeAudioBackend for all TTS requests — one resident model at a
# time, same as the diffusers pipe above. Grows lazily on first TTS call so
# image/video-only hosts never pay the transformers import cost.
_tts = {"backend": None}

def _tts_backend():
    if not UNSLOTH:
        raise RuntimeError("native TTS needs Unsloth modules (import failed at boot)")
    if _tts["backend"] is None:
        _tts["backend"] = NativeAudioBackend()
    return _tts["backend"]


def _tts_config(model_id, info):
    """Minimal config object NativeAudioBackend.load_model expects
    (.identifier/.audio_type/.path). audio_type resolved from the local
    snapshot when the repo id isn't in the curated list."""
    from types import SimpleNamespace
    audio_type = None
    if UNSLOTH:
        try:
            audio_type = native_audio_type_from_local_path(str(info.get("path", "")))
        except Exception:
            audio_type = None
    if not audio_type:
        raise RuntimeError(f"could not determine TTS architecture for {model_id}")
    return SimpleNamespace(identifier=model_id, audio_type=audio_type, path=str(info.get("path", "")))


def release_models(except_id=None):
    backend = _tts.get("backend")
    active_tts = getattr(backend, "active_model_name", None)
    if _loaded["id"] in (None, except_id) and active_tts in (None, except_id):
        return
    if _loaded["id"] != except_id:
        _loaded.update(id=None, pipe=None, kind=None)
    if backend and getattr(backend, "active_model_name", None) not in (None, except_id):
        backend.unload_model(backend.active_model_name)
    gc.collect()
    if DEVICE == "cuda":
        torch.cuda.empty_cache()


def _dir_bytes(path):
    """Rough on-disk weight size of a model directory (0 if missing)."""
    root = Path(path)
    if not root.is_dir():
        return 0
    total = 0
    for pattern in ("*.safetensors", "*.bin", "*.gguf", "*.pt", "*.pth"):
        for f in root.rglob(pattern):
            try:
                total += f.stat().st_size
            except OSError:
                pass
    return total


def _mem_available_bytes():
    """MemAvailable from /proc/meminfo in bytes, or None if unparseable."""
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _find_q21_base():
    root = HUB_DIR / 'models--Qwen--Qwen-Image-2.1' / 'snapshots'
    if not root.is_dir():
        return None
    cands = sorted([p for p in root.iterdir() if (p / 'model_index.json').is_file()],
                   key=lambda p: p.stat().st_mtime, reverse=True)
    return str(cands[0]) if cands else None


def load_qwen21_quant(model_id, info):
    release_models(model_id)
    import torch
    from diffusers import QwenImage21Pipeline, QwenImage21Transformer2DModel
    base = _find_q21_base()
    if not base:
        raise RuntimeError('Qwen/Qwen-Image-2.1 must stay downloaded — this quant borrows its text encoder and VAE')
    device = 'cpu' if model_id in CPU_MODELS else DEVICE
    dtype = torch.float32
    if device == 'cpu' and os.environ.get('IMAGE_CPU_DTYPE') == 'bfloat16':
        dtype = torch.bfloat16
    elif device == 'cuda':
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    touch_progress(device=device, phase='loading')
    try:
        from diffusers import GGUFQuantizationConfig
        transformer = QwenImage21Transformer2DModel.from_single_file(
            info['path'], quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
            config=base, subfolder='transformer', torch_dtype=torch.bfloat16)
    except Exception as e:
        raise RuntimeError(f'Qwen-Image-2.1 GGUF would not load ({e}); use the full Qwen/Qwen-Image-2.1 instead')
    pipe = QwenImage21Pipeline.from_pretrained(base, transformer=transformer, torch_dtype=dtype,
                                               local_files_only=True, low_cpu_mem_usage=True)
    if device == 'cuda':
        pipe.transformer.to('cuda')
        pipe.vae.to('cuda')
        if hasattr(pipe.vae, 'enable_tiling'):
            pipe.vae.enable_tiling()
        from diffusers.hooks import apply_group_offloading
        apply_group_offloading(pipe.text_encoder, onload_device=torch.device('cuda'),
                               offload_device=torch.device('cpu'),
                               offload_type='leaf_level', num_blocks_per_group=1, use_stream=True)
    else:
        pipe.to('cpu')
        if hasattr(pipe, 'enable_vae_tiling'):
            pipe.enable_vae_tiling()
    _loaded.update(id=model_id, pipe=pipe, kind='image', device=device)
    return pipe


def load_pipeline(model_id, info):
    if _loaded["id"] == model_id and _loaded["pipe"] is not None:
        return _loaded["pipe"]
    if info.get('kind') == 'qwen21_gguf':
        return load_qwen21_quant(model_id, info)
    release_models(model_id)
    import diffusers
    # No AutoPipelineForText2Audio exists in several supported diffusers
    # versions. Resolve the declared class for each task independently.
    pipe_cls = getattr(diffusers, info.get("class", ""), None)
    if pipe_cls is None:
        raise RuntimeError(f"Pipeline {info.get('class')} is unavailable; update the media runtime")
    need = _dir_bytes(info["path"])
    available = _mem_available_bytes()
    if need > 0 and available is not None and need > available * 0.9:
        print(f"[bridge] memory estimate: {model_id} weights={need/1024**3:.1f} GiB available={available/1024**3:.1f} GiB; proceeding with memory-mapped loading", flush=True)
    device = "cpu" if model_id in CPU_MODELS else DEVICE
    dtype = torch.float32
    if device == "cpu" and os.environ.get("IMAGE_CPU_DTYPE") == "bfloat16":
        dtype = torch.bfloat16
    elif device == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    touch_progress(device=device, phase="loading")
    if info["kind"] != "diffusers":
        raise RuntimeError("This checkpoint needs a dedicated loader; choose a complete Diffusers repository")
    pipe = pipe_cls.from_pretrained(info["path"], torch_dtype=dtype, local_files_only=True, low_cpu_mem_usage=True)
    # Preserve image size, steps, and LLM context. Offload only on a GPU;
    # CPU hosts never enter Accelerate's GPU offload path.
    if device == "cuda":
        if info.get('class') == 'QwenImage21Pipeline':
            # Its encoder alone exceeds a 16 GB card in BF16. Offload layers,
            # not whole components, so the default local setup can load it.
            from diffusers.hooks import apply_group_offloading
            options = dict(onload_device=torch.device("cuda"), offload_device=torch.device("cpu"),
                           offload_type="block_level", num_blocks_per_group=2, use_stream=False)
            # Qwen3-VL nests its layer lists under model.language_model and
            # model.visual. Treating the entire encoder as one group exceeds
            # 16 GiB before the first denoising step.
            apply_group_offloading(pipe.text_encoder,
                                   onload_device=torch.device("cuda"), offload_device=torch.device("cpu"),
                                   offload_type="leaf_level", use_stream=False)
            pipe.transformer.enable_group_offload(
                **{**options, "num_blocks_per_group": 1, "use_stream": True},
                low_cpu_mem_usage=True, record_stream=True,
            )
            pipe.vae.enable_group_offload(**options)
            if hasattr(pipe.vae, 'enable_tiling'):
                # The stock 256px tiles leave visible vertical/horizontal
                # bands even at 512px. Decode small edits as one tile and
                # use wider tiles with overlap for larger canvases.
                pipe.vae.enable_tiling(tile_sample_min_height=512, tile_sample_min_width=512,
                                       tile_sample_stride_height=448, tile_sample_stride_width=448)
        else:
            pipe.enable_model_cpu_offload()
    else:
        pipe.to(device)
        if hasattr(pipe, "enable_vae_tiling"):
            pipe.enable_vae_tiling()
    _loaded.update(id=model_id, pipe=pipe, kind=info["task"], device=device)
    return pipe


def call_pipeline(pipe, kwargs):
    from media_catalog import pipeline_kwargs
    with torch.inference_mode():
        return pipe(**pipeline_kwargs(pipe, kwargs))


def decode_reference_images(body):
    """Turn optional images_b64 into PIL images. None means text-only."""
    raw = body.get("images_b64")
    if not raw:
        return None
    if isinstance(raw, str):
        raw = [raw]
    from PIL import Image
    images = []
    for item in raw:
        data = base64.b64decode(item, validate=True)
        if len(data) > 12 * 1024 * 1024:
            raise ValueError("Each reference photo must be under 12 MB")
        image = Image.open(io.BytesIO(data))
        image.load()
        widest = max(image.size)
        if widest > 2048:
            scale = 2048 / widest
            image = image.resize((max(8, int(image.width * scale) // 8 * 8),
                                  max(8, int(image.height * scale) // 8 * 8)), Image.Resampling.LANCZOS)
        from image_safety import require_safe_image
        require_safe_image(image, label='reference photo')
        images.append(image)
    return images


def seed_generator(seed):
    # Sequential / model CPU offload builds latents on the host. A CUDA
    # generator then fails or silently places noise on the wrong device.
    device = "cpu" if DEVICE == "cuda" else DEVICE
    return torch.Generator(device=device).manual_seed(int(seed))


def encode_audio(audio, sample_rate):
    import soundfile as sf
    if hasattr(audio, "detach"):
        audio = audio.detach().float().cpu().numpy()
    audio = np.asarray(audio)
    # Diffusers/MusicGen use [channels, samples]; soundfile uses the reverse.
    if audio.ndim == 2 and audio.shape[0] <= 8:
        audio = audio.T
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def audio_sample_rate(pipe):
    for component in (getattr(pipe, "vocoder", None), getattr(pipe, "vae", None), pipe):
        cfg = getattr(component, "config", None)
        for obj in (component, cfg):
            for key in ("sampling_rate", "sample_rate"):
                value = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
                if value:
                    return int(value)
    raise RuntimeError("Audio model does not declare a sample rate; refusing to save at the wrong pitch")


def audiocpp_backend():
    requested = (os.environ.get("AUDIOCPP_BACKEND") or "").strip().lower()
    if requested in ("hip", "vulkan", "cpu", "cuda"):
        return requested
    return "hip" if shutil.which("hipcc") or Path("/opt/rocm").exists() or Path("/usr/lib64/rocm").exists() else "cpu"


def run_minimax_music3_job(body, tag, model_id, info):
    from media_catalog import audiocpp_cli
    cli = audiocpp_cli()
    if not cli:
        raise ValueError("MiniMax Music 3 GGUF needs audiocpp_cli")
    duration = float(body.get("audio_duration") or 30)
    if duration < 10 or duration > 300:
        raise ValueError("MiniMax Music 3 max length must be between 10 and 300 seconds")
    steps = int(body.get("steps") or 30)
    lyrics = (body.get("lyrics") or "").strip()
    prompt = body["prompt"].strip()
    if not prompt:
        raise ValueError("Describe the song (style, instruments, vocal) in the prompt")
    backend = audiocpp_backend()
    data = []
    with tempfile.TemporaryDirectory(prefix="duckpond-music3-") as tmp:
        for i in range(int(body.get("n") or 1)):
            if tag in CANCEL_TAGS:
                raise JobCancelled(tag)
            touch_progress(phase="generating", image=i + 1, n=int(body.get("n") or 1), step=0, steps=steps)
            out = str(Path(tmp) / f"song-{i}.wav")
            cmd = [
                cli, "--task", "gen", "--family", "minimax_music3",
                "--model", info["path"], "--backend", backend,
                "--text", prompt,
                "--duration-seconds", str(int(duration)),
                "--num-inference-steps", str(steps),
                "--threads", "8",
                "--out", out,
            ]
            if lyrics:
                cmd += ["--lyrics", lyrics]
            if body.get("seed") is not None:
                cmd += ["--seed", str(int(body["seed"]) + i)]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            log = []
            try:
                while True:
                    if tag in CANCEL_TAGS:
                        proc.terminate()
                        try:
                            proc.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                        raise JobCancelled(tag)
                    line = proc.stdout.readline() if proc.stdout else ""
                    if line:
                        log.append(line)
                        # Best-effort step scrape; elapsed/ETA still work without it.
                        for token in line.replace(",", " ").split():
                            if token.isdigit() and 0 < int(token) <= steps:
                                touch_progress(phase="generating", step=int(token), steps=steps)
                    if proc.poll() is not None:
                        rest = proc.stdout.read() if proc.stdout else ""
                        if rest:
                            log.append(rest)
                        break
                    time.sleep(0.2)
            finally:
                if proc.poll() is None:
                    proc.kill()
            if proc.returncode != 0 or not Path(out).is_file():
                detail = "".join(log)[-1500:] or f"exit {proc.returncode}"
                raise RuntimeError(f"MiniMax Music 3 failed: {detail}")
            wav = Path(out).read_bytes()
            data.append({"b64_json": base64.b64encode(wav).decode("ascii")})
            touch_progress(phase="image_done", step=steps, steps=steps)
    return {"data": data, "model_used": model_id, "task": "audio", "sample_rate": 44100}


def run_musicgen_job(body, tag, model_id, info):
    duration = float(body.get("audio_duration") or 10)
    if duration > 30:
        raise ValueError("MusicGen supports up to 30 seconds per generation")
    from transformers import AutoProcessor, MusicgenForConditionalGeneration, StoppingCriteria, StoppingCriteriaList
    if _loaded["id"] != model_id:
        release_models(model_id)
        processor = AutoProcessor.from_pretrained(info["path"], local_files_only=True)
        model = MusicgenForConditionalGeneration.from_pretrained(info["path"], local_files_only=True).to(DEVICE).eval()
        _loaded.update(id=model_id, pipe=(processor, model), kind="audio")
    processor, model = _loaded["pipe"]
    rate = int(model.config.audio_encoder.sampling_rate)
    frame_rate = float(model.config.audio_encoder.frame_rate)
    class Cancel(StoppingCriteria):
        def __call__(self, input_ids, scores, **kwargs):
            if tag in CANCEL_TAGS:
                raise JobCancelled(tag)
            return False
    inputs = processor(text=[body["prompt"]], padding=True, return_tensors="pt").to(DEVICE)
    data = []
    # Seeded RNG is scoped so one request does not change later random jobs.
    with torch.random.fork_rng(devices=[torch.cuda.current_device()] if DEVICE == "cuda" else []):
        if body.get("seed") is not None:
            torch.manual_seed(int(body["seed"]))
        for i in range(int(body.get("n", 1))):
            touch_progress(phase="generating", image=i + 1, n=int(body.get("n", 1)), step=0, steps=1)
            with torch.inference_mode():
                audio = model.generate(**inputs, do_sample=True, max_new_tokens=int(duration * frame_rate),
                                       stopping_criteria=StoppingCriteriaList([Cancel()]))
            touch_progress(phase="image_done", step=1, steps=1)
            data.append({"b64_json": encode_audio(audio[0], rate)})
    return {"data": data, "model_used": model_id, "task": "audio", "sample_rate": rate}


def _patch_qwen_tts_transformers():
    """qwen-tts 0.1 still uses @check_model_inputs() from Transformers 4."""
    import transformers.utils.generic as generic
    if getattr(generic.check_model_inputs, "_duckpond_compat", False):
        return
    original = generic.check_model_inputs
    def check_model_inputs(func=None, **_kwargs):
        if func is None:
            return lambda wrapped: original(wrapped)
        return original(func)
    check_model_inputs._duckpond_compat = True
    generic.check_model_inputs = check_model_inputs


def run_qwen3_tts_job(body, tag, model_id, info):
    _patch_qwen_tts_transformers()
    from qwen_tts import Qwen3TTSModel
    from qwen_tts.core.models.configuration_qwen3_tts import Qwen3TTSTalkerConfig
    if not getattr(Qwen3TTSTalkerConfig.__init__, "_duckpond_pad", False):
        _talker_init = Qwen3TTSTalkerConfig.__init__
        def _init(self, *args, **kwargs):
            _talker_init(self, *args, **kwargs)
            if getattr(self, "pad_token_id", None) is None:
                self.pad_token_id = getattr(self, "tts_pad_token_id", None) or 151671
            if getattr(self, "bos_token_id", None) is None:
                self.bos_token_id = getattr(self, "tts_bos_token_id", None)
            if getattr(self, "eos_token_id", None) is None:
                self.eos_token_id = getattr(self, "tts_eos_token_id", None)
        _init._duckpond_pad = True
        Qwen3TTSTalkerConfig.__init__ = _init
    if _loaded["id"] != model_id:
        release_models(model_id)
        kwargs = dict(local_files_only=True, device_map=DEVICE,
                      dtype=torch.bfloat16 if DEVICE == "cuda" else torch.float32)
        try:
            model = Qwen3TTSModel.from_pretrained(info["path"], attn_implementation="sdpa", **kwargs)
        except Exception:
            model = Qwen3TTSModel.from_pretrained(info["path"], **kwargs)
        _loaded.update(id=model_id, pipe=model, kind="tts")
    model = _loaded["pipe"]
    speaker = (body.get("speaker") or info.get("default_speaker") or "Ryan").strip()
    language = (body.get("language") or "Auto").strip() or "Auto"
    instruct = (body.get("instruct") or "").strip() or None
    data = []
    with torch.random.fork_rng(devices=[torch.cuda.current_device()] if DEVICE == "cuda" else []):
        if body.get("seed") is not None:
            torch.manual_seed(int(body["seed"]))
        for i in range(int(body.get("n") or 1)):
            if tag in CANCEL_TAGS:
                raise JobCancelled(tag)
            touch_progress(phase="generating", image=i + 1, n=int(body.get("n") or 1), step=0, steps=1)
            gen = {}
            if instruct:
                gen["instruct"] = instruct
            wavs, rate = model.generate_custom_voice(
                text=body["prompt"], language=language, speaker=speaker, **gen)
            touch_progress(phase="image_done", step=1, steps=1)
            data.append({"b64_json": encode_audio(wavs[0], int(rate))})
    return {"data": data, "model_used": model_id, "task": "tts", "sample_rate": int(rate)}


def run_omnivoice_job(body, tag, model_id, info):
    from omnivoice import OmniVoice
    import tempfile
    # A transcript avoids a hidden ASR download and a second resident model.
    reference = body.get("ref_audio_b64")
    if reference and not str(body.get("ref_text") or "").strip():
        raise ValueError("Add the reference clip transcript to clone this voice")
    if _loaded["id"] != model_id:
        release_models(model_id)
        model = OmniVoice.from_pretrained(info["path"], device_map=DEVICE,
                                         dtype=torch.float32 if DEVICE == "cpu" else torch.float16,
                                         local_files_only=True)
        _loaded.update(id=model_id, pipe=model, kind="tts")
    model = _loaded["pipe"]
    data = []
    with tempfile.TemporaryDirectory(prefix="duckpond-voice-") as tmp:
        kwargs = {"text": body["prompt"]}
        if reference:
            import soundfile as sf
            raw = base64.b64decode(reference, validate=True)
            if len(raw) > 10 * 1024 * 1024:
                raise ValueError("Reference clip must be under 10 MB")
            audio, rate = sf.read(io.BytesIO(raw))
            if not 1 <= len(audio) / rate <= 30:
                raise ValueError("Reference clip must be 1–30 seconds long")
            path = str(Path(tmp) / "reference.wav")
            sf.write(path, audio, rate)
            kwargs.update(ref_audio=path, ref_text=body["ref_text"])
        with torch.random.fork_rng(devices=[torch.cuda.current_device()] if DEVICE == "cuda" else []):
            if body.get("seed") is not None:
                torch.manual_seed(int(body["seed"]))
            for i in range(int(body.get("n", 1))):
                if tag in CANCEL_TAGS:
                    raise JobCancelled(tag)
                touch_progress(phase="generating", image=i + 1, n=int(body.get("n", 1)), step=0, steps=1)
                with torch.inference_mode():
                    audio = model.generate(**kwargs)
                if tag in CANCEL_TAGS:
                    raise JobCancelled(tag)
                touch_progress(phase="image_done", step=1, steps=1)
                data.append({"b64_json": encode_audio(audio[0], 24000)})
    return {"data": data, "model_used": model_id, "task": "tts", "sample_rate": 24000}


# ------------------------------------------------------------------- job
def _encode_video_mp4(buf, frames, fps):
    """Encode generated frames (list[PIL.Image] | np.ndarray[T,H,W,C]) to mp4.
    Prefers PyAV (already in the Unsloth venv); falls back to imageio if the
    venv ever changes."""
    import av
    pil_frames = []
    for f in frames:
        if isinstance(f, np.ndarray):
            from PIL import Image
            f = Image.fromarray(f.astype("uint8"))
        pil_frames.append(f)
    w, h = pil_frames[0].size
    # h264 needs even dimensions
    if w % 2 or h % 2:
        w, h = w - (w % 2), h - (h % 2)
        pil_frames = [f.resize((w, h)) for f in pil_frames]
    container = av.open(buf, mode="w", format="mp4")
    stream = container.add_stream("h264", rate=fps)
    stream.width, stream.height, stream.pix_fmt = w, h, "yuv420p"
    for f in pil_frames:
        for packet in stream.encode(av.VideoFrame.from_image(f)):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def _callback_kwargs(pipe, on_step):
    """Per-pipeline step-callback kwargs — newer diffusers pipelines take
    callback_on_step_end, older ones (AudioLDM2, some video) only the legacy
    callback/callback_steps pair, and a few take neither."""
    import inspect
    params = inspect.signature(pipe.__call__).parameters
    if "callback_on_step_end" in params:
        return {"callback_on_step_end": on_step}
    if "callback" in params:
        return {"callback": on_step, "callback_steps": 1}
    return {}


def _qwen_sample(pipe, latents, width, height):
    sample = pipe._unpack_latents(latents.detach(), height, width, pipe.vae_scale_factor)
    sample = sample.to(pipe.vae.dtype)
    config = pipe.vae.config
    if getattr(config, 'latents_mean', None) is not None:
        mean = torch.as_tensor(config.latents_mean, device=sample.device, dtype=sample.dtype).view(1, -1, 1, 1, 1)
        std = torch.as_tensor(config.latents_std, device=sample.device, dtype=sample.dtype).view(1, -1, 1, 1, 1)
        sample = sample * std + mean
    return sample


def _decode_qwen_sample(pipe, sample):
    picture = pipe.vae.decode(sample, return_dict=False)[0]
    if picture.ndim == 5:
        picture = picture[:, :, 0]
    return pipe.image_processor.postprocess(picture, output_type='pil')[0].convert('RGB')


def encode_step_preview(pipe, latents, width, height):
    """Decode at native latent resolution; resize only the completed RGB image."""
    if not hasattr(pipe, '_unpack_latents') or not hasattr(pipe, 'vae'):
        return None
    with torch.inference_mode():
        image = _decode_qwen_sample(pipe, _qwen_sample(pipe, latents, width, height))
        image.thumbnail((512, 512))
        from image_safety import require_safe_image
        require_safe_image(image, threshold=0.85)
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=82, optimize=False)
        return base64.b64encode(buffer.getvalue()).decode('ascii')


def _seam_weights(length, stride, tile):
    """Select overlap bands from the primary tiled decode with soft edges."""
    overlap = tile - stride
    weights = np.zeros(length, dtype=np.float32)
    if overlap <= 0:
        return weights
    feather = min(16, overlap // 4)
    for edge in range(stride, length, stride):
        lo = max(0, edge - feather)
        hi = min(length, edge + overlap + feather)
        pos = np.arange(lo, hi)
        band = np.minimum((pos - (edge - feather)) / max(1, feather),
                          ((edge + overlap + feather) - pos) / max(1, feather))
        weights[lo:hi] = np.maximum(weights[lo:hi], np.clip(band, 0, 1))
    return weights


def _repair_qwen_seams(base, shifted, vae):
    """Take color from a second tile alignment only where the first has seams."""
    from PIL import Image
    width, height = base.size
    wx = _seam_weights(width, vae.tile_sample_stride_width, vae.tile_sample_min_width)
    wy = _seam_weights(height, vae.tile_sample_stride_height, vae.tile_sample_min_height)
    weight = np.maximum(wx[None, :], wy[:, None])[:, :, None]
    if not np.any(weight):
        return base
    original = np.asarray(base.convert('YCbCr'), dtype=np.float32)
    alternate = np.asarray(shifted.convert('YCbCr'), dtype=np.float32)
    original[:, :, 1:] += weight * (alternate[:, :, 1:] - original[:, :, 1:])
    corrected = Image.fromarray(np.clip(original, 0, 255).astype(np.uint8), 'YCbCr').convert('RGB')
    rgb = np.asarray(base, dtype=np.float32)
    rgb += weight * (np.asarray(corrected, dtype=np.float32) - rgb)
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), 'RGB')


def decode_qwen_final(pipe, latents, width, height):
    """Decode full resolution and soften color seams without blurring detail."""
    with torch.inference_mode():
        sample = _qwen_sample(pipe, latents, width, height)
        base = _decode_qwen_sample(pipe, sample)
        if (not getattr(pipe.vae, 'use_tiling', False)
                or (width <= pipe.vae.tile_sample_min_width and height <= pipe.vae.tile_sample_min_height)
                or max(width, height) > 1024):
            return base
        try:
            # Six latent cells shift the tile grid by 96 output pixels. The
            # second grid is clean across the first grid's 64px overlap bands.
            shifted_sample = torch.nn.functional.pad(sample, (6, 2, 6, 2, 0, 0), mode='replicate')
            shifted = _decode_qwen_sample(pipe, shifted_sample)
            offset = 6 * pipe.vae_scale_factor
            shifted = shifted.crop((offset, offset, offset + width, offset + height))
            return _repair_qwen_seams(base, shifted, pipe.vae)
        except Exception as exc:
            print(f'[bridge] seam correction skipped: {exc}', flush=True)
            if DEVICE == 'cuda':
                torch.cuda.empty_cache()
            return base


def run_job(body, tag):
    from media_catalog import validate_request
    validate_request(body)
    prompt = body["prompt"]
    model_req = body.get("model") or "auto"
    task = body.get("task", "image")  # image | video | audio
    size = body.get("size", "1024x1024")
    w, h = (int(x) for x in size.lower().split("x")) if "x" in size.lower() else (1024, 1024)
    n = max(1, min(4, int(body.get("n", 1))))
    seed = body.get("seed")
    # video-specific
    num_frames = int(body.get("num_frames") or 25)
    fps = int(body.get("fps") or 8)
    # audio-specific
    audio_duration = float(body.get("audio_duration") or 10.0)

    model_id, info = resolve_model(model_req, task=task)
    steps = int(body.get("steps") or info.get("default_steps") or 25)
    try:
        true_cfg = float(body.get("true_cfg_scale") or 1.0)
    except (TypeError, ValueError):
        raise ValueError("Invalid true_cfg_scale")
    if not 1.0 <= true_cfg <= 6.0:
        raise ValueError("true_cfg_scale must be between 1.0 and 6.0")
    negative = body.get("negative_prompt") or None
    use_cfg = true_cfg > 1.0
    images = decode_reference_images(body)
    preview_every = int(body.get('preview_every') or 0) if task == 'image' else 0
    if preview_every not in (0, 1, 2, 4, 8):
        raise ValueError('preview_every must be 0, 1, 2, 4, or 8')
    output_format = str(body.get('output_format') or 'png').lower() if task == 'image' else 'png'
    if output_format not in ('png', 'webp'):
        raise ValueError('output_format must be png or webp')
    if info.get("needs_image") and not images:
        raise ValueError("Add a reference photo for this model")
    if info.get("kind") == "comfy":
        from comfy_media import generate
        release_models()
        def progress(phase, step=None, steps=None):
            touch_progress(phase=phase, step=step, steps=steps)
        try:
            return generate(body, tag, lambda: tag in CANCEL_TAGS, progress, images)
        except InterruptedError as exc:
            raise JobCancelled(tag) from exc

    # Native TTS (Higgs/MOSS via Unsloth's NativeAudioBackend) doesn't go
    # through diffusers at all — text in, wav bytes out, one blocking call.
    if info.get("kind") == "musicgen":
        return run_musicgen_job(body, tag, model_id, info)
    if info.get("kind") == "minimax_music3":
        return run_minimax_music3_job(body, tag, model_id, info)
    if info.get("kind") == "omnivoice":
        return run_omnivoice_job(body, tag, model_id, info)
    if info.get("kind") == "qwen3_tts":
        return run_qwen3_tts_job(body, tag, model_id, info)
    if body.get("ref_audio_b64"):
        raise ValueError("This runtime does not support reference-audio cloning for the selected model")
    if info.get("kind") == "native_audio":
        return run_tts_job(body, tag, model_id, info)

    pipe = load_pipeline(model_id, info)

    # Multiple Qwen variations run sequentially to fit 16 GB cards. Encode
    # the same text once instead of streaming the large Qwen3-VL encoder from
    # system RAM for every variation. Condition images need their own masks.
    shared_embeds = None
    if task == 'image' and n > 1 and not images and info.get('class') == 'QwenImage21Pipeline':
        with torch.inference_mode():
            positive, positive_mask, _ = pipe.encode_prompt(prompt=prompt)
            shared_embeds = {'prompt_embeds': positive, 'prompt_embeds_mask': positive_mask}
            if use_cfg and negative:
                neg, neg_mask, _ = pipe.encode_prompt(prompt=negative)
                shared_embeds.update(negative_prompt_embeds=neg, negative_prompt_embeds_mask=neg_mask)

    generator = None
    if seed is not None:
        generator = seed_generator(seed)

    def on_step(*args):
        # callback_on_step_end(pipe, i, t, kwargs) — 4 args;
        # legacy callback(step, timestep, latents) — 3 args
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        step = args[1] if len(args) == 4 else args[0]
        touch_progress(phase="denoising", step=step + 1, steps=steps)
        if task == 'image' and preview_every and len(args) == 4 and ((step + 1) % preview_every == 0 or step + 1 == steps):
            latents = args[-1].get('latents') if isinstance(args[-1], dict) else None
            if latents is not None:
                try:
                    preview = encode_step_preview(pipe, latents, w, h)
                    if preview:
                        with STATE_LOCK:
                            STATE['preview_b64'] = preview
                            STATE['preview_seq'] += 1
                except ValueError as exc:
                    raise exc
                except Exception as exc:
                    print(f'[bridge] preview decode skipped: {exc}', flush=True)
        return args[-1] if len(args) == 4 else None

    results_b64 = []
    for i in range(n):
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        touch_progress(phase="generating", image=i + 1, n=n, step=0, steps=steps, preview_b64=None)

        kwargs = dict(prompt=prompt, num_inference_steps=steps,
                      generator=generator, **_callback_kwargs(pipe, on_step))
        if shared_embeds:
            kwargs['prompt'] = None
            kwargs.update(shared_embeds)
        if preview_every and 'callback_on_step_end' in kwargs:
            kwargs['callback_on_step_end_tensor_inputs'] = ['latents']
        if use_cfg and negative and not shared_embeds:
            kwargs["negative_prompt"] = negative
        if task == "image":
            try:
                _params = inspect.signature(pipe.__call__).parameters
            except (TypeError, ValueError):
                _params = {}
            if "true_cfg_scale" in _params:
                kwargs["true_cfg_scale"] = true_cfg
            if info.get('class') == 'QwenImage21Pipeline':
                kwargs['output_type'] = 'latent'
        if images:
            kwargs["image"] = images if len(images) > 1 else images[0]
            if info.get('class') == 'QwenImage21Pipeline':
                # Qwen uses this for both its vision encoder and reference VAE.
                # 512 loses details needed for faithful photo edits; match the
                # chosen canvas up to the pipeline's 1024px default instead.
                reference_budget = 1024 if len(images) == 1 else 768 if len(images) == 2 else 512
                kwargs['output_resolution'] = min(reference_budget, max(w, h))
                touch_progress(phase='encoding_reference', image=i + 1, n=n)
        if task == "audio":
            params = inspect.signature(pipe.__call__).parameters
            duration_key = "audio_end_in_s" if "audio_end_in_s" in params else "audio_length_in_s"
            kwargs[duration_key] = audio_duration
            result = call_pipeline(pipe, kwargs)
            results_b64.append(encode_audio(result.audios[0], audio_sample_rate(pipe)))
        elif task == "video":
            result = call_pipeline(pipe, dict(kwargs, num_frames=num_frames, width=w, height=h))
            frames = result.frames[0]
            buf = io.BytesIO()
            _encode_video_mp4(buf, frames, fps)
            results_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        else:
            result = call_pipeline(pipe, dict(kwargs, width=w, height=h))
            buf = io.BytesIO()
            image = decode_qwen_final(pipe, result.images, w, h) if info.get('class') == 'QwenImage21Pipeline' else result.images[0]
            from image_safety import require_safe_image
            require_safe_image(image)
            image.save(buf, format=output_format.upper(), **({'quality': 95, 'method': 4} if output_format == 'webp' else {}))
            results_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)

        touch_progress(phase="image_done")

    return {
        "data": [{"b64_json": b} for b in results_b64],
        "prompt_enhanced": None,
        "model_used": model_id,
        "steps_used": steps,
        "steps_requested": steps,
        "steps_capped": False,
        "task": task,
        "output_format": output_format if task == 'image' else None,
    }


def run_tts_job(body, tag, model_id, info):
    """Native synthesis only. Reference cloning uses the OmniVoice adapter;
    this runtime's generate_audio_response contract has no reference input.
    """
    import threading as _th
    text = body["prompt"]
    temperature = float(body.get("temperature") or 0.6)
    top_p = float(body.get("top_p") or 0.95)
    top_k = int(body.get("top_k") or 50)
    seed = body.get("seed")
    seed = int(seed) if seed is not None else None

    release_models(model_id)
    backend = _tts_backend()
    touch_progress(phase="starting", step=None, steps=None, image=None, n=None)
    if tag in CANCEL_TAGS:
        raise JobCancelled(tag)
    touch_progress(phase="generating", step=0, steps=1)

    cancel_event = _th.Event()
    finished = _th.Event()
    # bridge cancel tags are global; poll into the backend's cancel event
    def _watch():
        while not finished.wait(0.3):
            if tag in CANCEL_TAGS:
                cancel_event.set()
                return
            with STATE_LOCK:
                if not STATE.get("active"):
                    return
    _th.Thread(target=_watch, daemon=True).start()

    cfg = _tts_config(model_id, info)
    try:
        if getattr(backend, "active_model_name", None) != model_id:
            backend.load_model(cfg, trust_remote_code=True)
        with torch.inference_mode():
            wav_bytes, sample_rate = backend.generate_audio_response(
                text, temperature=temperature, top_p=top_p, top_k=top_k,
                max_new_tokens=int(body.get("max_new_tokens") or 2048),
                cancel_event=cancel_event, instructions=body.get("instructions"), seed=seed,
            )
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
    finally:
        finished.set()
    touch_progress(phase="image_done", step=1, steps=1)
    return {
        "data": [{"b64_json": base64.b64encode(wav_bytes).decode("ascii")}],
        "prompt_enhanced": None,
        "model_used": model_id,
        "steps_used": 0,
        "steps_requested": 0,
        "steps_capped": False,
        "task": "tts",
        "sample_rate": sample_rate,
    }


# ------------------------------------------------------------------ server
class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/v1/results":
            tag = parse_qs(parsed.query).get("tag", [None])[0]
            path = _result_path(tag)
            if path is None:
                return self._json(400, {"error": "valid tag required"})
            try:
                return self._json(200, json.loads(path.read_text(encoding="utf-8")))
            except FileNotFoundError:
                with STATE_LOCK:
                    active = (STATE.get("active") and STATE.get("tag") == tag) or tag in PENDING_TAGS
                return self._json(202 if active else 404, {"active": bool(active)})
            except (OSError, ValueError) as exc:
                return self._json(500, {"error": f"Could not read saved result: {exc}"})
        if parsed.path == "/health":
            models = discover_models()
            for model_id, info in models.items():
                info["loaded"] = model_id == _loaded["id"] or model_id == getattr(_tts.get("backend"), "active_model_name", None)
                info["device"] = "cpu" if model_id in CPU_MODELS else DEVICE
            operation = MODEL_OPERATION
            if operation and operation.get("type") == "error" and models.get(operation.get("model"), {}).get("loaded"):
                operation = None
            return self._json(200, {"ok": True, "models": models, "default_model": DEFAULT_MODEL or "auto",
                                    "model_operation": operation})
        if parsed.path == "/v1/progress":
            try:
                since = int(parse_qs(parsed.query).get('since', ['0'])[0])
            except (ValueError, TypeError):
                since = 0
            if STATE.get("active"):
                touch_progress()
            with STATE_LOCK:
                snap = dict(STATE)
                last_at = snap.get("last_progress_at")
                stall_seconds = (time.monotonic() - last_at) if last_at is not None else None
                if snap.get("active") and stall_seconds is not None and stall_seconds > STALL_LIMIT_SECONDS:
                    STATE["stalled"] = True
                    snap["stalled"] = True
                    tag = snap.get("tag")
                    if tag and tag not in _STALL_LOGGED:
                        _STALL_LOGGED.add(tag)
                        print(f"[bridge] JOB STALLED tag={tag} no progress for {int(stall_seconds)}s phase={snap.get('phase')} step={snap.get('step')}/{snap.get('steps')} — cancel cannot reach a wedged native call; restart image-gen-bridge-8765.service to clear the queue", flush=True)
            progress = {k: snap.get(k) for k in ("phase", "step", "steps", "image", "n", "eta_seconds", "elapsed")}
            return self._json(200, {
                "tag": snap.get("tag"), "active": snap.get("active", False),
                "phase": snap.get("phase"), "progress": progress,
                "enhanced_prompt": snap.get("enhanced_prompt"),
                "eta_seconds": snap.get("eta_seconds"),
                "elapsed": snap.get("elapsed"),
                "stalled": snap.get("stalled", False),
                "stall_seconds": stall_seconds,
                "preview_seq": snap.get('preview_seq', 0),
                "preview_b64": snap.get('preview_b64') if snap.get('preview_seq', 0) > since else None,
            })
        self._json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length", 0))
        if length < 0 or length > 48 * 1024 * 1024:
            return self._json(413, {"error": "Request too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "JSON object required"})

        if parsed.path == "/v1/results/ack":
            path = _result_path(body.get("tag"))
            if path is None:
                return self._json(400, {"error": "valid tag required"})
            path.unlink(missing_ok=True)
            return self._json(200, {"ok": True})

        if parsed.path == "/v1/models/unload":
            if not GEN_LOCK.acquire(blocking=False):
                return self._json(409, {"error": "Generation is active. Stop it and wait for it to finish before unloading."})
            try:
                requested = body.get("model")
                if not isinstance(requested, str) or not requested:
                    return self._json(400, {"error": "model required"})
                from comfy_media import MODEL as comfy_model
                if requested == comfy_model:
                    return self._json(400, {"error": "This model is managed by the separate video runtime"})
                if _loaded["id"] == requested:
                    _loaded.update(id=None, pipe=None, kind=None, device=None)
                backend = _tts.get("backend")
                if getattr(backend, "active_model_name", None) == requested:
                    backend.unload_model(requested)
                gc.collect()
                if DEVICE == "cuda":
                    torch.cuda.empty_cache()
                return self._json(200, {"ok": True, "model": requested, "loaded": False})
            finally:
                GEN_LOCK.release()

        if parsed.path == "/v1/models/warm":
            global MODEL_OPERATION
            try:
                model_id, info = resolve_model(body.get("model") or "auto", task="image")
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            if info.get("class") != "QwenImage21Pipeline":
                return self._json(400, {"error": "Image prewarming currently supports Qwen-Image 2.1"})
            with GEN_LOCK:
                try:
                    MODEL_OPERATION = {"type": "loading", "model": model_id}
                    load_pipeline(model_id, info)
                    MODEL_OPERATION = {"type": "ready", "model": model_id}
                    return self._json(200, {"ok": True, "model": model_id})
                except Exception as exc:
                    traceback.print_exc()
                    MODEL_OPERATION = {"type": "error", "model": model_id, "message": str(exc)}
                    return self._json(500, {"error": str(exc)})

        if parsed.path in {f"{path}/cancel" for path in ("/v1/images/generations", "/v1/videos/generations", "/v1/audio/generations", "/v1/audio/speech")}:
            tag = body.get("tag")
            if tag:
                CANCEL_TAGS.add(tag)
            return self._json(200, {"ok": True})

        if parsed.path not in ("/v1/images/generations", "/v1/videos/generations", "/v1/audio/generations", "/v1/audio/speech"):
            return self._json(404, {"error": "not found"})

        task_map = {
            "/v1/images/generations": "image",
            "/v1/videos/generations": "video",
            "/v1/audio/generations": "audio",
            "/v1/audio/speech": "tts",
        }
        body["task"] = task_map.get(parsed.path, "image")

        tag = body.get("tag") or os.urandom(16).hex()
        if not isinstance(tag, str) or not RESULT_TAG.fullmatch(tag):
            return self._json(400, {"error": "valid tag required"})
        with STATE_LOCK:
            PENDING_TAGS.add(tag)

        def _stall_watchdog(stop_event):
            # Per-job self-exit guard: if the job holds GEN_LOCK but progress
            # freezes (uninterruptible disk sleep during a huge model load),
            # hard-exit so systemd's Restart=always reclaims RAM and the queue.
            while not stop_event.wait(15):
                with STATE_LOCK:
                    active = STATE.get("active")
                    last_at = STATE.get("last_progress_at")
                    wedged_tag = STATE.get("tag")
                if active and last_at is not None:
                    silent = time.monotonic() - last_at
                    if silent > STALL_EXIT_SECONDS:
                        print(f"[bridge] JOB WEDGED tag={wedged_tag} no progress for {int(silent)}s — exiting so systemd restarts the bridge (reclaims RAM, clears the queue); the client sees a connection error and can retry", flush=True)
                        sys.stdout.flush()
                        os._exit(75)

        with GEN_LOCK:
            stall_stop = threading.Event()
            threading.Thread(target=_stall_watchdog, args=(stall_stop,), name="stall-watchdog", daemon=True).start()
            try:
                touch_progress(tag=tag, active=True, phase="starting", step=None, steps=None,
                               preview_b64=None, preview_seq=0,
                               image=None, n=None, started_at=time.time())
                result = run_job(body, tag)
                _save_result(tag, result)
                _prune_results()
                return self._json(200, result)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except JobCancelled:
                # Cancellation should release the Qwen weights and ROCm cache,
                # rather than leaving the entire engine resident until restart.
                release_models()
                return self._json(499, {"error": "cancelled"})
            except Exception as e:
                traceback.print_exc()
                return self._json(500, {"error": str(e)})
            finally:
                stall_stop.set()
                CANCEL_TAGS.discard(tag)
                _STALL_LOGGED.discard(tag)
                with STATE_LOCK:
                    PENDING_TAGS.discard(tag)
                touch_progress(active=False)

    def log_message(self, fmt, *args):
        print(f"[bridge] {self.address_string()} {fmt % args}")


def main():
    print(f"[bridge] device={DEVICE} hf_home={HF_HOME} port={PORT}")
    print(f"[bridge] discovered models: {list(discover_models().keys())}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
