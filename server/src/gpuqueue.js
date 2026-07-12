// Single-GPU serialization. Chat generations, image gen, diffusion and agent
// runs all contend for one GPU with only enough VRAM for one model — running
// two at once just thrashes (the router swaps models in/out) or OOMs. So every
// GPU-heavy top-level request acquires this one slot; the rest queue FIFO and
// get live position updates so a second user sees "waiting for the GPU (N
// ahead)" instead of a stall or a failure.
//
// Acquire at the REQUEST level, never nested: a chat turn that also generates an
// image in-thread holds the single slot for the whole turn (the image call must
// NOT re-acquire, or it self-deadlocks). See the three call sites: routes/chat.js,
// routes/images.js, routes/agent.js.

let held = false;
const waiters = []; // { resolve, onQueued, signal, onAbort }

export function gpuQueueDepth() { return waiters.length + (held ? 1 : 0); }
export function gpuBusy() { return held; }

function notifyPositions() {
  // 1-based position among those still WAITING (the running one isn't counted)
  waiters.forEach((w, i) => { try { w.onQueued?.(i + 1); } catch { /* observer */ } });
}

function makeRelease() {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) {
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve(makeRelease()); // hand the slot straight to the next in line
      notifyPositions();
    } else {
      held = false;
    }
  };
}

// Resolves with a release() fn once the slot is ours. If `signal` aborts while
// we're still waiting, the wait is cancelled (rejects with AbortError) and we
// drop out of the queue so we never take a turn we no longer want.
export function acquireGpu({ onQueued, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    if (!held) {
      held = true;
      resolve(makeRelease());
      return;
    }
    const waiter = { resolve, onQueued, signal, onAbort: null };
    waiters.push(waiter);
    try { onQueued?.(waiters.length); } catch { /* observer */ }
    if (signal) {
      waiter.onAbort = () => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) { waiters.splice(i, 1); notifyPositions(); }
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
  });
}

// Convenience wrapper for callers that don't need the release handle inline.
export async function withGpu(fn, opts) {
  const release = await acquireGpu(opts);
  try { return await fn(); }
  finally { release(); }
}
