#!/usr/bin/env python3
"""Local OpenAI-compatible image generation bridge for DuckPond.

Runs under Unsloth Studio's own venv (torch+ROCm+diffusers already
installed and GPU-verified there — see ~/.unsloth/studio/unsloth_studio),
so there's no separate container or dependency set to maintain. Models are
discovered straight out of the shared HF cache (HF_HOME) that `hf download`
(DuckPond's Model Hub), the llama router, and Unsloth Studio all already
write to — download a diffusers-format or single-file image checkpoint
through the Hub's Image tab and it shows up here with no extra wiring.

Contract (matches server/src/imagegen.js in the duckpond repo):
  GET  /health                     -> {ok, models:{id:{ready,kind}}, default_model}
  GET  /v1/progress?since=N        -> current job's progress
  POST /v1/images/generations      -> blocks until done, {data:[{b64_json}], ...}
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

_loaded = {"id": None, "pipe": None}


class JobCancelled(Exception):
    pass


# ---------------------------------------------------------------- discovery
def discover_models():
    """Scan HF_HOME for anything that looks like a text-to-image checkpoint.
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
            if "Pipeline" in cls and "Image" in cls or cls.endswith("XLPipeline") or "Diffusion" in cls:
                models[model_id] = {"ready": True, "kind": "diffusers", "path": str(snap)}
            continue
        top_level_safetensors = [f for f in snap.glob("*.safetensors") if f.stat().st_size > 500_000_000]
        if top_level_safetensors:
            models[model_id] = {"ready": True, "kind": "single_file", "path": str(top_level_safetensors[0])}
    return models


def resolve_model(requested):
    models = discover_models()
    if not models:
        raise RuntimeError("no image models downloaded yet — grab one from Model Hub > Image tab")
    if requested and requested != "auto" and requested in models:
        return requested, models[requested]
    if DEFAULT_MODEL and DEFAULT_MODEL in models:
        return DEFAULT_MODEL, models[DEFAULT_MODEL]
    first_id = next(iter(models))
    return first_id, models[first_id]


def load_pipeline(model_id, info):
    if _loaded["id"] == model_id and _loaded["pipe"] is not None:
        return _loaded["pipe"]
    from diffusers import AutoPipelineForText2Image

    if _loaded["pipe"] is not None:
        del _loaded["pipe"]
        _loaded["pipe"] = None
        if DEVICE == "cuda":
            torch.cuda.empty_cache()

    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
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
    return pipe


# ------------------------------------------------------------------- job
def run_job(body, tag):
    prompt = body["prompt"]
    model_req = body.get("model") or "auto"
    size = body.get("size", "1024x1024")
    w, h = (int(x) for x in size.lower().split("x"))
    n = max(1, min(4, int(body.get("n", 1))))
    steps = int(body.get("steps") or 25)
    negative = body.get("negative_prompt") or None
    seed = body.get("seed")

    model_id, info = resolve_model(model_req)
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

    images_b64 = []
    for i in range(n):
        if tag in CANCEL_TAGS:
            raise JobCancelled(tag)
        with STATE_LOCK:
            STATE.update(phase="generating", image=i + 1, n=n, step=0, steps=steps)
        result = pipe(
            prompt=prompt, negative_prompt=negative,
            num_inference_steps=steps, width=w, height=h,
            generator=generator,
            callback_on_step_end=on_step,
        )
        img = result.images[0]
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        images_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        with STATE_LOCK:
            STATE.update(phase="image_done")

    return {
        "data": [{"b64_json": b} for b in images_b64],
        "prompt_enhanced": None,
        "model_used": model_id,
        "steps_used": steps,
        "steps_requested": steps,
        "steps_capped": False,
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

        if parsed.path != "/v1/images/generations":
            return self._json(404, {"error": "not found"})

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
