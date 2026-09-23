// A model stream is owned by the server, not the browser connection. A stalled
// upstream must still release its slot eventually. Reset the deadline only for
// parsed SSE events; transport keep-alive comments are not model progress.
export function createStreamDeadline({
  signal: upstreamSignal,
  label,
  startupMs,
  idleMs,
}) {
  const controller = new AbortController();
  let timer;
  let started = false;
  const forwardAbort = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });

  const arm = (ms) => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      const error = new Error(`${label} stopped responding for ${Math.ceil(ms / 1000)} seconds`);
      error.code = 'STREAM_IDLE_TIMEOUT';
      controller.abort(error);
    }, ms);
  };
  arm(startupMs);

  return {
    signal: controller.signal,
    progress() {
      if (!started) started = true;
      arm(idleMs);
    },
    error(err) {
      return controller.signal.aborted && !upstreamSignal?.aborted
        ? controller.signal.reason : err;
    },
    dispose() {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}
