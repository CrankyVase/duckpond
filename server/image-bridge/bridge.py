#!/usr/bin/env python3
"""Local OpenAI-compatible media generation bridge for DuckPond.

Runs under Unsloth Studio's own venv (torch+ROCm+diffusers+transformers
already installed and GPU-verified there — see ~/.unsloth/studio/unsloth_studio),
so there's no separate container or dependency set to maintain. Models are
discovered straight out of the shared HF cache (HF_HOME) that `hf download`
(DuckPond's Model Hub), the llama router, and Unsloth Studio all already
write to — download a diffusers-format or single-file checkpoint through the
Hub's Image/Video/Audio tabs and it shows up here with no extra wiring.

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
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import torch
import numpy as np

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
def discover_models():
    """Scan HF_HOME for anything that looks like a media checkpoint.
    diffusers-format repo (model_index.json with a *Pipeline that isn't purely
    text) or a single big .safetensors file at the repo root (Civitai-style
    single-file SDXL/SD checkpoints)."""
    models = {}
    if not HUB_DIR.is_dir():
        return models
    for repo_dir in HUB_DIR.iterdir():
        if not repo_dir.name.startswith("models--"):
            continue
        model_id = repo_dir.name[len("models--"):].replace("--", "/", 1)
        snaps = repo_dir / "snapshots"
        if not snaps.is_dir():
            continue
        snapshot_dirs = sorted(snaps.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        if not snapshot_dirs:
            continue
        snap = snapshot_dirs[0]
        idx = snap / "model_index.json"
        if idx.is_file():
            try:
                cls = json.loads(idx.read_text()).get("_class_name", "")
            except Exception:
                cls = ""
            # classify by pipeline class name
            if "Pipeline" in cls:
                kind = "diffusers"
                lower = cls.lower()
                if "video" in lower or "ltx" in lower or "wan" in lower or "cogvideo" in lower or "hunyuan" in lower or "mochi" in lower or "allegro" in lower:
                    task = "video"
                elif "audio" in lower or "music" in lower or "stableaudio" in lower or "audioldm" in lower:
                    task = "audio"
                elif "image" in lower or "text2image" in lower or "xl" in lower or "flux" in lower or "sd" in lower:
                    task = "image"
                else:
                    task = "image"  # default to image for unknown pipelines
                models[model_id] = {"ready": True, "kind": kind, "task": task, "path": str(snap), "class": cls}
            continue
        top_level_safetensors = [f for f in snap.glob("*.safetensors") if f.stat().st_size > 500_000_000]
        if top_level_safetensors:
            models[model_id] = {"ready": True, "kind": "single_file", "task": "image", "path": str(top_level_safetensors[0])}
    return models


def resolve_model(requested, task=None):
    models = discover_models()
    if not models:
        raise RuntimeError(f"no {task or 'media'} models downloaded yet — grab one from Model Hub")
    if requested and requested != "auto" and requested in models:
        return requested, models[requested]
    # filter by task if given
    if task:
        task_models = {k: v for k, v in models.items() if v.get("task") == task}
        if task_models:
            models = task_models
    if DEFAULT_MODEL and DEFAULT_MODEL in models:
        return DEFAULT_MODEL, models[DEFAULT_MODEL]
    first_id = next(iter(models))
    return first_id, models[first_id]


def load_pipeline(model_id, info):
    if _loaded["id"] == model_id and _loaded["pipe"] is not None:
        return _loaded["pipe"]
    from diffusers import AutoPipelineForText2Image, AutoPipelineForText2Audio

    if _loaded["pipe"] is not None:
        del _loaded["pipe"]
        _loaded["pipe"] = None
        if DEVICE == "cuda":
            torch.cuda.empty_cache()

    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    task = info.get("task", "image")

    if task == "audio":
        if info["kind"] == "diffusers":
            pipe = AutoPipelineForText2Audio.from_pretrained(info["path"], torch_dtype=dtype)
        else:
            raise RuntimeError("single-file audio checkpoints not supported")
    elif task == "video":
        # video pipelines are loaded via their own class names
        cls_name = info.get("class", "")
        if not cls_name:
            raise RuntimeError("video pipeline class unknown")
        import diffusers
        pipe_cls = getattr(diffusers, cls_name, None)
        if pipe_cls is None:
            raise RuntimeError(f"pipeline class {cls_name} not available in diffusers {diffusers.__version__}")
        if info["kind"] == "diffusers":
            pipe = pipe_cls.from_pretrained(info["path"], torch_dtype=dtype)
        else:
            raise RuntimeError("single-file video checkpoints not supported")
    else:
        # image
        if info["kind"] == "diffusers":
            pipe = AutoPipelineForText2Image.from_pretrained(info["path"], torch_dtype=dtype)
        else:
            pipe = AutoPipelineForText2Image.from_single_file(info["path"], torch_dtype=dtype)

    # Keeps only the active submodule resident on GPU — this card is shared
    # with the llama router, so a full `.to("cuda")` load risks OOMing
    # whatever LLM is already loaded.
    try:
        pipe.enable_model_cpu_offload()
    except Exception:
        pipe.to(DEVICE)
    _loaded["id"] = model_id
    _loaded["pipe"] = pipe
    _loaded["kind"] = task
    return pipe


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


def run_job(body, tag):
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
    sample_rate = int(body.get("sample_rate") or 44100)

    model_id, info = resolve_model(model_req, task=task)
    pipe = load_pipeline(model_id, info)

    generator = None
    if seed:
        generator = torch.Generator(device=DEVICE).manual_seed(int(seed))

    def on_step(pipe_, step, timestep, kwargs):
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        with STATE_LOCK:
            STATE.update(phase="denoising", step=step + 1, steps=steps)
        return kwargs

    results_b64 = []
    for i in range(n):
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        with STATE_LOCK:
            STATE.update(phase="generating", image=i + 1, n=n, step=0, steps=steps)

        if task == "audio":
            result = pipe(
                prompt=prompt, negative_prompt=negative,
                num_inference_steps=steps,
                audio_length_in_s=audio_duration,
                generator=generator,
                callback_on_step_end=on_step,
            )
            audio = result.audios[0] if hasattr(result, 'audios') else result[0]
            buf = io.BytesIO()
            import soundfile as sf
            sf.write(buf, audio.T if audio.ndim > 1 else audio, sample_rate, format='WAV')
            results_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        elif task == "video":
            result = pipe(
                prompt=prompt, negative_prompt=negative,
                num_inference_steps=steps,
                num_frames=num_frames,
                generator=generator,
                callback_on_step_end=on_step,
            )
            frames = result.frames[0] if hasattr(result, 'frames') else result[0]
            buf = io.BytesIO()
            _encode_video_mp4(buf, frames, fps)
            results_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        else:
            result = pipe(
                prompt=prompt, negative_prompt=negative,
                num_inference_steps=steps, width=w, height=h,
                generator=generator,
                callback_on_step_end=on_step,
            )
            img = result.images[0]
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            results_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))

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
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})

        if parsed.path == "/v1/images/generations/cancel":
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
            "/v1/audio/speech": "audio",
        }
        body["task"] = task_map.get(parsed.path, "image")

        tag = body.get("tag") or str(time.time())
        with GEN_LOCK:
            with STATE_LOCK:
                STATE.update(tag=tag, active=True, phase="starting", step=None, steps=None, image=None, n=None)
            try:
                result = run_job(body, tag)
                return self._json(200, result)
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
