#!/usr/bin/env python3
"""One-shot GPU synthesis worker.

HSA memory errors abort the whole process, so GPU work runs here, isolated:
a crash costs one job (the bridge falls back to CPU), never the service, and
process exit guarantees the VRAM is returned for the chat model.

stdin: JSON {"kwargs": {...generate args...}, "out": "/path/out.wav"}
exit 0 on success.
"""
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch
from omnivoice import OmniVoice

job = json.load(sys.stdin)
t0 = time.time()
model = OmniVoice.from_pretrained("/home/lewis/speech-models/OmniVoice",
                                  device_map="cuda:0", dtype=torch.float16)
print(f"gpu model loaded in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
audio = model.generate(**job["kwargs"])
wav = np.asarray(audio[0], dtype=np.float32)
sf.write(job["out"], wav, 24000, format="WAV", subtype="PCM_16")
print(f"gpu synth done in {time.time() - t0:.1f}s ({len(wav) / 24000:.1f}s audio)",
      file=sys.stderr, flush=True)
