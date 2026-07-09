# Research digest (2026-07-09)

Condensed from the design-research pass. Confidence noted where it matters.

## Web search (§6)
- **Brave Search API free tier is DEAD** (Feb 2026): now $5/1k metered with $5/mo
  credit, card required and auto-billed. Skip.
- **Serper**: 2,500 credits are one-time trial, not monthly. Skip.
- **CHOSEN — SearxNG** self-hosted, rootless podman, bind 127.0.0.1 only:
  - MUST add `json` to `search.formats` in settings.yml (else `format=json` → 403).
  - Relax limiter for loopback. Enable many engines (DDG, Brave, Startpage,
    Mojeek, Bing, Qwant); Google WILL fingerprint-CAPTCHA and self-suspend 24h —
    treat as bonus.
  - Never expose through the tunnel; proxy through DuckPond's authed backend.
- **Fallback — Tavily** free tier: 1,000 credits/mo, no card. Add per-user/day cap.
- Emergency tertiary: `ddgs` PyPI lib (keyless scraping, chronically rate-limited).

## DiffusionGemma (§9a note) — DEFERRED
- llama.cpp PR #24423 still an OPEN DRAFT (plus competing draft #24427); some
  SEO pages falsely claim it merged. CLI-only (`llama-diffusion-cli`), no server.
- Only checkpoint is 26B-A4B: Q4_K_M ~16GB file, ~18GB needed → doesn't fit 16GB.
- `--diffusion-visual` is raw ANSI terminal art — unparseable. The right hook is
  the C `diffusion_step_callback_t` (full token canvas per step) via a ~150-line
  wrapper emitting JSON-lines. Revisit when merged AND fits VRAM:
  `gh pr view 24423 --repo ggml-org/llama.cpp`

## Sandbox (§5) — design for task 5
- Rootless podman via Docker-compatible socket (`systemctl --user enable --now
  podman.socket` → dockerode or plain HTTP). Nothing off-the-shelf fits a
  multi-user web backend; steal the proxy-allowlist idea from
  anthropic-experimental/sandbox-runtime later.
- Container-per-workspace, `exec` per command w/ timeout, idle-stop ~15 min:
  `--userns=keep-id:uid=1000,gid=1000 --read-only --read-only-tmpfs=false
  --tmpfs /tmp:size=256m -v <ws>:/workspace:Z,rw -v <vol>:/home/pn
  --cap-drop ALL --security-opt no-new-privileges --memory 3g --memory-swap 3g
  --pids-limit 512 -p 127.0.0.1:<block>:3000-3009`
- Port block reserved AT CREATION (pasta can't hot-add ports). Dev servers bind
  0.0.0.0:3000-3009 inside; DuckPond reverse-proxies with auth.
- Image: nikolaik/python-nodejs (uid-1000 `pn` matches keep-id; pin by digest).
- `--cpus` needs systemd `Delegate=cpu cpuset io memory pids` drop-in + relogin;
  memory/pids work today. SELinux stays enforcing (`:Z` labels).
- v1 egress open (npm/pip work); `--network none` flag for untrusted runs;
  domain-allowlist proxy is the later upgrade.

## Auth (§7)
- fail2ban unusable behind tunnel (source IP = 127.0.0.1; only working action is
  the Cloudflare-API ban, callable ourselves in 20 lines if ever needed).
- CF-Connecting-IP trustworthy ONLY while the app binds loopback behind
  cloudflared. Reject requests missing it in prod mode.
- argon2 npm pkg (needs Node ≥22, prebuilt binaries, maintained). Sessions in
  SQLite, not JWT (instant revocation, one process). Lockout counters in SQLite
  (survive restarts), per-account AND per-IP (per-IP looser — CGNAT/shared IPs).
- Cloudflare Access free ≤50 seats = optional outer gate later; its
  Cf-Access-Jwt-Assertion could exempt the owner from IP lockouts.

## UI prior art (§11)
- llama.cpp's own webui (SvelteKit, embedded static) = closest reference: live
  context bar, branching, SSE. Hollama = clean minimal SvelteKit reference.
- Smooth streaming = tokens into non-reactive buffer, flush 1×/rAF; markdown
  split into blocks, memoize closed blocks, only trailing open block re-parses
  (Streamdown technique). Per-token setState is the #1 jank source.
- Diff UX gold standard (Cline/Roo): show diff BEFORE approval control,
  per-edit approve/reject, integrate with undo.
- OpenHands' typed-event-stream (every agent step a serialized event) → replay/
  resume for free; adopt for the sandbox WebSocket.
- bolt.diy's WebContainers rejected: paid license for production + COOP/COEP
  headers + Node-only. Server-side podman wins on this box.
- SSE > Socket.IO here (no sticky-session pain behind the tunnel).

## Still to research (agents died on quota)
- TTS serving: Voxtral-4B-TTS-2603 runtimes; k2-fsa/OmniVoice via sherpa-onnx;
  ROCm-vs-CPU. (Task 6.)
- Package vetting pipeline: OSV.dev / deps.dev / typosquat heuristics. (Task 5.)
