# Duck Pond Windows worker

Fedora hosts Duck Pond, its database and the authoritative model library at
`/home/cranky/duckpond/models`. Windows MR_PC executes large chat and photo models.
The authorized Fedora exception is `lfm2-700m-q4-0`: LFM2-700M Q4_0 from Unsloth,
running on the Ryzen 5 5500 CPU with its own 32K slot. Its file size and SHA-256
are pinned in `local_worker.py`; other model IDs cannot start local inference.
`linux-runtime` contains an isolated CPU-only copy of the existing llama.cpp
b9625 runtime. No embeddings run on Fedora.
`EMBED_ENABLED=0` explicitly disables embedding requests until a Windows
embedding worker is configured. Document retrieval can use its keyword fallback;
semantic memory/search is not currently available.

The website is available at https://aii.crankyvase.site.

## Model lifecycle

Completed chat GGUF downloads are discovered automatically. Split GGUFs appear
only when every shard exists. Loading a model hashes the Fedora files, transfers
them through the private SSH tunnel, verifies their SHA-256 on Windows, and
caches them under `C:\Users\toryf\duckpond-worker\models\<content hash>`.
Later loads reuse the verified Windows SSD files.

Chat uses llama.cpp Vulkan on the RX 9070 XT, 32,768 tokens, one slot, automatic
GPU layer fitting and a 512 MiB reserve. Weights that do not fit use Windows RAM
and CPU. VRAM used by Windows applications and the context cache must also fit;
"maximum GPU use" does not mean overwriting memory owned by other applications.

Per-model performance settings live in `runtime-profiles.json` and are read on
each load. They can tune CPU threads/affinity, GPU fitting reserve, operation
placement and supported speculative decoding. The profile validator does not
allow changes to model weights, 32K context or the existing Q8 KV precision.
Models without a profile use the defaults above. Tuning for one architecture
must not be copied to newly downloaded models without testing it.

The source also supports `batchSize` (logical prompt batch) and `ubatchSize`
(physical prompt batch), with the native defaults of 2048 and 512. The physical
batch cannot exceed the logical batch. These controls follow the
[pinned llama.cpp b11146 server documentation](https://raw.githubusercontent.com/ggml-org/llama.cpp/b11146/tools/server/README.md).
They leave the 32K slot, one-slot allocation, weights, KV precision and sampling
settings intact. Larger batches can need more scratch memory; choose them using
prompt and generation measurements rather than a GPU utilization percentage.

`benchmark_prompt_batches.py` is an explicitly invoked comparison for when the
inference PC is available. It retains the model's saved placement/thread/MTP
profile, compares several batch pairs, and checks marker recall in an exactly
tokenized 28K–31K input. It writes diagnostics only, never a chosen runtime
profile. Recall is a narrow regression check; review generated text and memory
headroom before changing a saved profile. This script and the new controls were
added in a source-only pass and have not been run or deployed in that pass.

`benchmark*.py` scripts send all inference
through the Windows bridge. They reload between configurations, disable prompt
reuse, check the actual 32,768-token slot, and record prompt throughput,
generation throughput, elapsed time and response text. These are explicitly
invoked diagnostics; deployment does not launch them. MTP tests reuse the
trained draft head already in the target GGUF and verify its proposed tokens
with the target model; they do not download or load a second copy of the weights.

The saved Qwen 27B profile uses six generation threads, twelve prompt threads,
a 256 MiB fitting reserve and its embedded MTP head with up to three draft
tokens. GPU operations remain enabled; CPU affinity and forced CPU FFN placement
remain disabled. Other models retain their defaults. In two repeated samples
per task, Qwen prose generation improved from 6.28 to 11.68 tokens/sec and code
from 6.28 to 16.77 tokens/sec. A 4,519-token uncached recall prompt completed in
22.54 seconds versus 25.66 seconds originally and returned the correct marker.
The actual slot remained 32,768 tokens throughout. These are small controlled
tests, not a guarantee of throughput for every prompt or a full 32K input test.
The CPU-operation alternative was rejected despite a small generation gain:
it took 102.78 seconds on that same long prompt. Results are recorded in the
local `tps-optimization-result.json` and underlying benchmark result files.

Explicit unload and two minutes of idle time stop the inference process and
release its RAM and VRAM. Windows may keep reclaimable filesystem cache, and
other Windows applications retain their own allocations. The SSD copy remains.
Unloading during an explicit model load cancels that load and withdraws its
transfer lease; an active generation must finish or be stopped first.
Deleting a Fedora library file removes its Windows cache too; failed/offline
deletions remain in `windows-cache.json` and are retried. A removed loaded model
is stopped before pruning its cache.

Photo generation uses Qwen Image 2.1 Q4, the Qwen3-VL encoder and its VAE with
stable-diffusion.cpp Vulkan. It stops the chat worker to make VRAM available and
exits after generating the photo. Reference-image editing is not configured.
Video and audio models are not installed. New chat architectures must be
supported by the installed llama.cpp build; downloads alone cannot establish
runtime compatibility.

Photo runtime settings live in `photo-runtime.json`: automatic GPU placement,
Flash Attention for both the text encoder and diffusion, memory-mapped SSD
weights and conservative 256-pixel VAE tiles. No approximate denoising cache or
extra weight quantization is enabled. The runtime uses live GPU memory budgets;
it does not allocate unused memory merely to fill a usage meter.

Image presets are Fast (512px, 20 steps, CFG 4), Balanced (768px, 28 steps,
CFG 5), Quality (1024px, 40 steps, CFG 6), and Ultra (1280px, 50 steps, CFG 6).
Balanced replaces the previous 40-step unguided preset. CPU prompt enhancement
is best-effort and preserves the original prompt in the saved creation.
The current renderer reports step progress and returns a finished PNG; live
image previews and reference editing are not configured.

Controlled samples took about 25 seconds at 512px, 66 seconds at 768px Balanced,
and 185 seconds at 1024px Quality. Quality produced readable “DUCK POND” text.
These are single-run timings for specific prompts, not guaranteed completion
times. Larger VAE tiles did not improve the Balanced sample and were rejected.
The Fedora helper answered at about 73 tokens/sec in a short CPU test and
completed another reply in 0.91 seconds while Windows was actively rendering.
Its lifecycle lock is independent of the Windows GPU lock. Both explicit
unload and a two-minute idle reaper stop the helper process and free its RAM.
The CPU helper's reusable prompt cache is capped at 128 MiB; active context
remains 32,768 tokens. Linux loopback port 18084 is its private native endpoint.

After deployment, a website Fast photo with CPU prompt enhancement completed
in 25.41 seconds and returned a saved 512px PNG. During that request, a separate
website chat using the Fedora helper completed in 4.19 seconds while the Windows
photo worker remained active. The chat retained a 32,768-token context despite
an old 8,192-token conversation override. Live sampling progress reached 20/20;
the temporary conversation, creation and verification session were removed.
Results are in `photo-website-result.json`; the diagnostic PNG remains here.
The deployed helper also unloaded automatically after its two-minute idle
timeout, leaving zero Fedora inference processes. Windows had zero chat/photo
worker processes and dedicated VRAM returned to its approximately 2.8 GiB
desktop baseline. The existing discrete GPU driver was unchanged. These checks
are recorded in `photo-idle-result.json` and `photo-optimization-result.json`.
RAM and VRAM labels use binary GiB consistently. Windows' usable discrete GPU
capacity is about 15.92 GiB; fit reserves, context buffers, whole-layer sizes
and other applications can leave additional space unallocated.

## Connection and gaming

The worker uses the existing AMD driver; no GPU drivers were installed or
changed. Both native runtimes are isolated inside the Duck Pond worker folder.
There is no Windows inference service or scheduled task. Workers run on demand
under SSH and check a Fedora lease. They stop if that lease expires, the bridge
stops or the connection fails. Only Duck Pond's own executable paths are killed.

The local SSH tunnel forwards Windows inference to Fedora port 18082 and
Fedora assets/leases back to Windows port 18083. All worker HTTP ports bind to
loopback. Fedora exposes the adapter on 8081 and the photo API on 8765.

Windows RAM, CPU and dedicated VRAM readings are queried through Windows CIM.
The website uses these readings and reports an unavailable worker instead of
silently displaying Fedora's resources. Samples refresh every few seconds.

## Services and diagnostics

Enabled Fedora user services (linger is enabled):

```
systemctl --user status duckpond duckpond-windows-bridge duckpond-windows-tunnel
journalctl --user -u duckpond-windows-bridge -n 80
curl http://127.0.0.1:8081/bridge/status
curl http://127.0.0.1:8081/bridge/windows-status
curl http://127.0.0.1:8081/bridge/hardware
curl http://127.0.0.1:8765/health
```

Bridge scripts live here; deployed PowerShell copies live in the Windows worker
folder. `windows-session.log` records transfers and chat worker exits;
`windows-image.log` records photo runtime output. Native chat diagnostics live
in Windows `llama.stderr.log` and `llama.stdout.log`. Do not restart the bridge
during an active load or generation unless intentionally cancelling it.

`../deploy.sh` uses Node 24 and checks both chat and photo workers for active
work before applying updates. It synchronizes the three PowerShell wrappers
using `sync_worker.py` and restarts `duckpond-windows-bridge.service`. There is
currently no active auto-deploy timer. Fedora download, inventory and registry
defaults are derived from the project folder rather than the old mounted drive.

The restored live database is `../data/duckpond-live-restored.db`. Original
preservation backups are unchanged. Website/gallery restoration and API checks
were performed using the existing ducktest account.

## Measured connection cost

Despite the switch's 10 Gb ports, Fedora negotiated 1 Gb/s and Windows 5 Gb/s.
The model transfer is limited by Fedora: about 104 MB/s. The first 16.46 GB
Qwen copy took about 158 seconds plus verification and loading. Cached Qwen
loads took about 10–17 seconds across checks. North Mini Code's first load
took 151 seconds including its 12.77 GB copy and verification.

Measured Windows HTTP health through SSH had a 0.63 ms median. A bridged
inference-state request had a 1.44 ms median and 3.54 ms p95. These are request
overhead measurements, not full prompt latency; token generation and prompt
processing still depend on the model, context and GPU/CPU placement.

Verified workloads include Qwen chat, LFM2.5 chat, North Mini Code chat, Gemma 4
chat and Qwen Image 2.1 photo generation through the website, including saved
PNG retrieval. A real website conversation saved Gemma's reply and reported
32,768 context even with an old 8,192-token conversation override. A cached
Gemma reload took 9.6 seconds and did not transfer its weights again.
Cache deletion and queuing an offline deletion were exercised with disposable
fixtures. Test artifacts in this directory are diagnostics, not model weights.

Final checks: cancelling a cached model load stopped it in about six seconds;
LFM reloaded from its SSD cache in 2.6 seconds. Automatic idle unload completed
after 129 seconds (the reaper checks every ten seconds), with zero inference
processes, zero worker working-set bytes, seven retained cache files and VRAM
back at the approximately 3 GB Windows baseline. The discrete AMD driver remains
`32.0.31041.1004`. Temporary website verification sessions, conversations and
gallery entries were removed; standalone diagnostic PNGs remain here.
