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
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

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
         "image": None, "n": None, "enhanced_prompt": None}
CANCEL_TAGS = set()  # tags a client has asked to stop — checked between denoise steps

_loaded = {"id": None, "pipe": None, "kind": None}


class JobCancelled(Exception):
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
                cfg = _tts_config(model_id, info)
                if cfg.audio_type == 'minimax_music3' and (DEVICE != 'cuda' or getattr(torch.version, 'hip', None)):
                    info.update(ready=False, reason='MiniMax Music 3 requires an NVIDIA CUDA GPU')
            except RuntimeError as e:
                info.update(ready=False, reason=str(e))
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


def load_pipeline(model_id, info):
    if _loaded["id"] == model_id and _loaded["pipe"] is not None:
        return _loaded["pipe"]
    release_models(model_id)
    import diffusers
    # No AutoPipelineForText2Audio exists in several supported diffusers
    # versions. Resolve the declared class for each task independently.
    pipe_cls = getattr(diffusers, info.get("class", ""), None)
    if pipe_cls is None:
        raise RuntimeError(f"Pipeline {info.get('class')} is unavailable; update the media runtime")
    dtype = torch.float32
    if DEVICE == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    if info["kind"] != "diffusers":
        raise RuntimeError("This checkpoint needs a dedicated loader; choose a complete Diffusers repository")
    pipe = pipe_cls.from_pretrained(info["path"], torch_dtype=dtype, local_files_only=True)
    # Preserve image size, steps, and LLM context. Offload only on a GPU;
    # CPU hosts never enter Accelerate's GPU offload path.
    if DEVICE == "cuda":
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(DEVICE)
    _loaded.update(id=model_id, pipe=pipe, kind=info["task"])
    return pipe


def call_pipeline(pipe, kwargs):
    from media_catalog import pipeline_kwargs
    with torch.inference_mode():
        return pipe(**pipeline_kwargs(pipe, kwargs))


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
            with STATE_LOCK:
                STATE.update(phase="generating", step=input_ids.shape[-1], steps=int(duration * frame_rate))
            return False
    inputs = processor(text=[body["prompt"]], padding=True, return_tensors="pt").to(DEVICE)
    data = []
    # Seeded RNG is scoped so one request does not change later random jobs.
    with torch.random.fork_rng(devices=[torch.cuda.current_device()] if DEVICE == "cuda" else []):
        if body.get("seed") is not None:
            torch.manual_seed(int(body["seed"]))
        for i in range(int(body.get("n", 1))):
            with STATE_LOCK:
                STATE.update(image=i + 1, n=int(body.get("n", 1)))
            with torch.inference_mode():
                audio = model.generate(**inputs, do_sample=True, max_new_tokens=int(duration * frame_rate),
                                       stopping_criteria=StoppingCriteriaList([Cancel()]))
            data.append({"b64_json": encode_audio(audio[0], rate)})
    return {"data": data, "model_used": model_id, "task": "audio", "sample_rate": rate}


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
                with STATE_LOCK:
                    STATE.update(phase="generating", image=i + 1, n=int(body.get("n", 1)))
                with torch.inference_mode():
                    audio = model.generate(**kwargs)
                if tag in CANCEL_TAGS:
                    raise JobCancelled(tag)
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


def run_job(body, tag):
    from media_catalog import validate_request
    validate_request(body)
    prompt = body["prompt"]
    model_req = body.get("model") or "auto"
    task = body.get("task", "image")  # image | video | audio
    size = body.get("size", "1024x1024")
    w, h = (int(x) for x in size.lower().split("x")) if "x" in size.lower() else (1024, 1024)
    n = max(1, min(4, int(body.get("n", 1))))
    steps = int(body.get("steps") or 25)
    negative = body.get("negative_prompt") or None
    seed = body.get("seed")
    # video-specific
    num_frames = int(body.get("num_frames") or 25)
    fps = int(body.get("fps") or 8)
    # audio-specific
    audio_duration = float(body.get("audio_duration") or 10.0)

    model_id, info = resolve_model(model_req, task=task)

    # Native TTS (Higgs/MOSS via Unsloth's NativeAudioBackend) doesn't go
    # through diffusers at all — text in, wav bytes out, one blocking call.
    if info.get("kind") == "musicgen":
        return run_musicgen_job(body, tag, model_id, info)
    if info.get("kind") == "omnivoice":
        return run_omnivoice_job(body, tag, model_id, info)
    if body.get("ref_audio_b64"):
        raise ValueError("This runtime does not support reference-audio cloning for the selected model")
    if info.get("kind") == "native_audio":
        return run_tts_job(body, tag, model_id, info)

    pipe = load_pipeline(model_id, info)

    generator = None
    if seed is not None:
        generator = torch.Generator(device=DEVICE).manual_seed(int(seed))

    def on_step(*args):
        # callback_on_step_end(pipe, i, t, kwargs) — 4 args;
        # legacy callback(step, timestep, latents) — 3 args
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        step = args[1] if len(args) == 4 else args[0]
        with STATE_LOCK:
            STATE.update(phase="denoising", step=step + 1, steps=steps)
        return args[-1] if len(args) == 4 else None

    results_b64 = []
    for i in range(n):
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        with STATE_LOCK:
            STATE.update(phase="generating", image=i + 1, n=n, step=0, steps=steps)

        kwargs = dict(prompt=prompt, negative_prompt=negative, num_inference_steps=steps,
                      generator=generator, **_callback_kwargs(pipe, on_step))
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
            result.images[0].save(buf, format="PNG")
            results_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)

        with STATE_LOCK:
            STATE.update(phase="image_done")

    return {
        "data": [{"b64_json": b} for b in results_b64],
        "prompt_enhanced": None,
        "model_used": model_id,
        "steps_used": steps,
        "steps_requested": steps,
        "steps_capped": False,
        "task": task,
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
    with STATE_LOCK:
        STATE.update(phase="starting", step=None, steps=None, image=None, n=None)
    if tag in CANCEL_TAGS:
        raise JobCancelled(tag)
    with STATE_LOCK:
        STATE.update(phase="generating")

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
    with STATE_LOCK:
        STATE.update(phase="image_done")
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
        if parsed.path == "/health":
            models = discover_models()
            return self._json(200, {"ok": True, "models": models, "default_model": DEFAULT_MODEL or "auto"})
        if parsed.path == "/v1/progress":
            with STATE_LOCK:
                snap = dict(STATE)
            progress = {k: snap.get(k) for k in ("phase", "step", "steps", "image", "n")}
            return self._json(200, {
                "tag": snap.get("tag"), "active": snap.get("active", False),
                "phase": snap.get("phase"), "progress": progress,
                "enhanced_prompt": snap.get("enhanced_prompt"),
            })
        self._json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length", 0))
        if length < 0 or length > 16 * 1024 * 1024:
            return self._json(413, {"error": "Request too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "JSON object required"})

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

        tag = body.get("tag") or str(time.time())
        with GEN_LOCK:
            with STATE_LOCK:
                STATE.update(tag=tag, active=True, phase="starting", step=None, steps=None, image=None, n=None)
            try:
                result = run_job(body, tag)
                return self._json(200, result)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except JobCancelled:
                return self._json(499, {"error": "cancelled"})
            except Exception as e:
                traceback.print_exc()
                return self._json(500, {"error": str(e)})
            finally:
                CANCEL_TAGS.discard(tag)
                with STATE_LOCK:
                    STATE.update(active=False)

    def log_message(self, fmt, *args):
        print(f"[bridge] {self.address_string()} {fmt % args}")


def main():
    print(f"[bridge] device={DEVICE} hf_home={HF_HOME} port={PORT}")
    print(f"[bridge] discovered models: {list(discover_models().keys())}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
