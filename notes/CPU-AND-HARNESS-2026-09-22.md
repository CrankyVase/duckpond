# Qwen CPU, unloading, and coding context

Qwen's September 22 failure was a bridge preflight refusal: 31 GiB on-disk
weights versus 27 GiB MemAvailable. It was not a missing checkpoint.
The old loader also chose CUDA automatically and expanded CPU weights to FP32.

Implemented:
- Per-model CPU override, explicit BF16 CPU option, low-memory loading and CPU VAE tiling.
- Weight-size preflight now logs an estimate instead of refusing a load.
- Host systemd override `qwen-cpu.conf`: Qwen CPU/BF16, 12 threads, 36G MemoryHigh,
  existing 40G MemoryMax retained, 7200-second no-progress watchdog for CPU work.
- Lock-protected media unload endpoint, owner route, loaded/device metadata,
  Studio unload control and Model Hub unload for resident bridge models.
  Active generation returns 409. Separate Comfy video runtime is not unloaded here.
- ModelPicker load/unload URLs encode model IDs.
- Media job elapsed clock is reactive; loading phase and accessible progress labels.
- Studio Automatic selection reflects the bridge default rather than array ordering.
- Agent context estimates include new tool results, tool definitions, message overhead,
  image allowance, provider usage calibration, and reserved answer space.
  Provider overflow recovery remains because estimates are not exact token counts.
- Older tool output retains its beginning and end, preserving compiler failures.
- Missing Settings sampling values no longer crash number formatting.

References reviewed: MiniMax Code at commit
4357fe493125fc6bd90839594e77e7038ec0ac7a, especially
packages/agent-modules/context-manager/src/provider-budget.ts and
context-usage-estimator.ts. Original implementation; no upstream source copied.
https://github.com/MiniMax-AI/minimax-code
https://huggingface.co/Qwen/Qwen-Image-2.1

Validation:
- Qwen CPU 512x512, 2 steps: success in 40.5 seconds (blurry smoke output).
- Qwen CPU 512x512, 20 steps, seed 42: success in 145.9 seconds; visually checked
  a clear watercolor duck beside a blue cup. Saved through generateViaBridge to
  owner gallery, image ID 1, file image-1790081733058-0-d2ef8dc5.png.
- Unload verified after generation; process RSS dropped to approximately 2 GiB.
  Cgroup file cache remains reclaimable and is not resident model tensor memory.
- 44 Python bridge/catalog/adapter tests; agent context regression tests;
  complete server npm test and workspace checks passed.
- Real Podman project integration passed file editing, shell, preview, path checks.
- Web production build passed (existing accessibility and bundle size warnings).
- Workbench browser tests passed desktop/tablet/phone, Settings, drafts, tool evidence.
- Mobile media test passed CPU label, busy unload error, successful unload and layout.
- Fixed test server cleanup so media lifecycle tests exit; expanded browser fixture
  list responses and console reporting to expose caught render errors.

This establishes these behaviors, not a comparative 'best coding harness' ranking.
A model-driven coding benchmark suite remains future work.

Deployment completed: application and bridge restarted after idle/drain checks.
Post-restart health reports Qwen ready, device=cpu, loaded=false. The final media
browser test also passed against the deployed frontend (mocked API responses).
The generated image remains saved; Qwen was unloaded after verification.
