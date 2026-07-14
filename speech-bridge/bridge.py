#!/usr/bin/env python3
"""DuckPond speech bridge — voice cloning + voice design TTS on :8766.

Engine: k2-fsa OmniVoice (0.6B, zero-shot cloning from a 3-10s reference,
attribute-based voice design, [laughter]-style non-verbal tags).

Device policy (measured on this box):
- voice DESIGN (instruct, no reference) is near-realtime on CPU (RTF ~0.8)
  → served by a resident CPU copy of the model.
- voice CLONING (reference-conditioned) is RTF ~4-5 on CPU → runs on the GPU
  when it can: check free VRAM, evict the router's LLM if needed (it reloads
  itself on the next chat request — --models-autoload), load fp16, synth,
  free. Falls back to CPU when ROCm isn't available in this runtime.

Voice registry: VOICES_DIR/<id>/meta.json (+ ref.wav for cloned voices;
designed voices store an `instruct` string instead). DuckPond's server is
the only client; auth lives on the DuckPond side.
"""
import io
import json
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response

MODEL_DIR = Path("/home/lewis/speech-models/OmniVoice")
VOICES_DIR = Path("/home/lewis/speech-models/voices")
ROUTER_URL = "http://127.0.0.1:8081"
SAMPLE_RATE = 24000
MAX_TEXT = 4000
# Reference length drives inference cost hard (measured: 9s ref = 13.4s synth,
# 4s ref = 9.9s for the same sentence on 24 CPU threads). 6s balances cloning
# quality against render time.
MAX_REF_SECONDS = 6

VOICES_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="DuckPond speech bridge")

_cpu_model = None
_load_err = None
_lock = threading.Lock()  # one synth at a time; also guards model loads


def _import_stack():
    import torch  # noqa: PLC0415
    from omnivoice import OmniVoice  # noqa: PLC0415
    return torch, OmniVoice


def get_cpu_model():
    global _cpu_model, _load_err
    if _cpu_model is not None:
        return _cpu_model
    try:
        torch, OmniVoice = _import_stack()
        torch.set_num_threads(24)
        t0 = time.time()
        _cpu_model = OmniVoice.from_pretrained(str(MODEL_DIR), device_map="cpu", dtype=torch.bfloat16)
        print(f"omnivoice cpu loaded in {time.time() - t0:.1f}s", flush=True)
        _load_err = None
        return _cpu_model
    except Exception as e:  # noqa: BLE001
        _load_err = str(e)
        raise HTTPException(503, f"omnivoice failed to load: {e}")


def router_loaded_models():
    try:
        with urllib.request.urlopen(f"{ROUTER_URL}/v1/models", timeout=3) as res:
            data = json.loads(res.read())
        return [m["id"] for m in data.get("data", [])
                if (m.get("status") or {}).get("value") in ("loaded", "sleeping")]
    except Exception:
        return []


def router_unload(model_id):
    try:
        req = urllib.request.Request(
            f"{ROUTER_URL}/models/unload",
            data=json.dumps({"model": model_id}).encode(),
            headers={"content-type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=30).read()
        print(f"evicted {model_id} from VRAM for clone job (autoloads back on next chat)", flush=True)
    except Exception as e:
        print(f"router unload {model_id} failed: {e}", flush=True)


def gpu_synth(kwargs):
    """Synthesize on the GPU in a throwaway subprocess, only when the card is
    idle. llama-server holds VRAM through Vulkan, invisible to ROCm's
    mem_get_info, so probing lies and a blind load hard-crashes the HSA
    runtime ("Memory in use") — we ask the router instead. HSA aborts are
    process-fatal, hence the subprocess: a crash costs the job (caller falls
    back to CPU), never the service, and exit guarantees the VRAM comes back.
    Returns wav bytes or None."""
    # Measured on this card: GPU synth is only ~20% faster than 24-thread CPU
    # (MIOpen falls back to untuned kernels on gfx1201), so evicting the chat
    # model is never worth it — take the GPU only when it's already idle.
    if router_loaded_models():
        return None

    out = Path("/tmp/speech-gpu-out.wav")
    out.unlink(missing_ok=True)
    try:
        r = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "gpu_worker.py")],
            input=json.dumps({"kwargs": kwargs, "out": str(out)}).encode(),
            capture_output=True, timeout=240)
        for line in r.stderr.decode(errors="replace").splitlines():
            if line.strip():
                print(f"[gpu-worker] {line}", flush=True)
        if r.returncode == 0 and out.exists():
            return out.read_bytes()
        print(f"gpu worker exit {r.returncode} — falling back to cpu", flush=True)
    except subprocess.TimeoutExpired:
        print("gpu worker timed out — falling back to cpu", flush=True)
    finally:
        out.unlink(missing_ok=True)
    return None


def voice_dir(vid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", vid):
        raise HTTPException(400, "bad voice id")
    return VOICES_DIR / vid


def load_meta(d: Path):
    try:
        return json.loads((d / "meta.json").read_text())
    except Exception:
        return None


def slugify(name: str) -> str:
    vid = re.sub(r"[^a-z0-9-]+", "-", name.strip().lower()).strip("-")[:64] or "voice"
    base, n = vid, 2
    while (VOICES_DIR / vid).exists():
        vid, n = f"{base}-{n}", n + 1
    return vid


@app.get("/health")
def health():
    gpu = False
    try:
        torch, _ = _import_stack()
        gpu = torch.cuda.is_available()
    except Exception:
        pass
    return {"ok": True, "engine": "omnivoice", "cpu_loaded": _cpu_model is not None,
            "gpu": gpu, "error": _load_err}


@app.get("/voices")
def voices():
    out = []
    for d in sorted(VOICES_DIR.iterdir()):
        if d.is_dir() and (meta := load_meta(d)):
            out.append(meta)
    return out


@app.post("/voices")
async def clone_voice(request: Request, name: str = Query(...), ref_text: str = Query("")):
    """Create a CLONED voice from a reference clip (body = audio bytes,
    anything soundfile reads: wav/flac/ogg). ref_text optional — omnivoice
    auto-transcribes with its built-in whisper when omitted."""
    raw = await request.body()
    if len(raw) < 1000:
        raise HTTPException(400, "reference audio is empty or too short")
    try:
        audio, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(400, f"could not read audio ({e}) — send wav/flac/ogg")
    mono = audio.mean(axis=1)
    if len(mono) < sr * 2:
        raise HTTPException(400, "reference must be at least ~3 seconds of speech")
    mono = mono[: sr * MAX_REF_SECONDS]

    vid = slugify(name)
    d = voice_dir(vid)
    d.mkdir(parents=True)
    sf.write(d / "ref.wav", mono, sr)
    meta = {"id": vid, "name": name.strip()[:80], "kind": "cloned",
            "ref_text": ref_text.strip() or None,
            "seconds": round(len(mono) / sr, 1), "created_at": int(time.time())}
    (d / "meta.json").write_text(json.dumps(meta))
    return meta


@app.post("/voices/design")
def design_voice(body: dict):
    """Create a DESIGNED voice from attributes (no reference audio).
    instruct e.g. "female, low pitch, british accent" — comma-separated,
    freely combinable: gender, age, pitch, whisper, accent/dialect."""
    name = str(body.get("name", "")).strip()
    instruct = str(body.get("instruct", "")).strip()[:300]
    if not name or not instruct:
        raise HTTPException(400, "name and instruct required")
    vid = slugify(name)
    d = voice_dir(vid)
    d.mkdir(parents=True)
    meta = {"id": vid, "name": name[:80], "kind": "designed",
            "instruct": instruct, "created_at": int(time.time())}
    (d / "meta.json").write_text(json.dumps(meta))
    return meta


@app.delete("/voices/{vid}")
def delete_voice(vid: str):
    d = voice_dir(vid)
    if not d.is_dir():
        raise HTTPException(404, "no such voice")
    for f in d.iterdir():
        f.unlink()
    d.rmdir()
    return {"ok": True}


@app.post("/tts")
def tts(body: dict):
    text = str(body.get("text", "")).strip()[:MAX_TEXT]
    vid = str(body.get("voice", "")).strip()
    instruct = str(body.get("instruct", "")).strip()[:300]
    speed = min(max(float(body.get("speed") or 1.0), 0.5), 2.0)
    num_step = 16 if int(body.get("num_step") or 16) <= 16 else 32
    if not text:
        raise HTTPException(400, "text required")

    kwargs = {"text": text, "num_step": num_step}
    if speed != 1.0:
        kwargs["speed"] = speed
    cloned = False
    if vid:
        d = voice_dir(vid)
        meta = load_meta(d)
        if not meta:
            raise HTTPException(404, f"no such voice: {vid}")
        if meta.get("kind") == "designed":
            kwargs["instruct"] = meta["instruct"]
        else:
            cloned = True
            kwargs["ref_audio"] = str(d / "ref.wav")
            if meta.get("ref_text"):
                kwargs["ref_text"] = meta["ref_text"]
    elif instruct:
        kwargs["instruct"] = instruct
    else:
        raise HTTPException(400, "voice or instruct required")

    t0 = time.time()
    with _lock:
        wav_bytes = gpu_synth(kwargs) if cloned else None
        used_gpu = wav_bytes is not None
        if not used_gpu:
            audio = get_cpu_model().generate(**kwargs)
            wav = np.asarray(audio[0], dtype=np.float32)
            buf = io.BytesIO()
            sf.write(buf, wav, SAMPLE_RATE, format="WAV", subtype="PCM_16")
            wav_bytes = buf.getvalue()
    gen = time.time() - t0
    dur = max((len(wav_bytes) - 44) / 2 / SAMPLE_RATE, 0.01)
    print(f"tts {'gpu' if used_gpu else 'cpu'} voice={vid or 'instruct'} chars={len(text)} "
          f"audio={dur:.1f}s gen={gen:.1f}s rtf={gen / dur:.2f}", flush=True)
    return Response(wav_bytes, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8766, log_level="warning")
