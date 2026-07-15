// A 401 on any call means the session died server-side (logout elsewhere,
// account deleted, expiry). Announce it so the app can kick to the login
// screen without waiting for a manual refresh.
function announceUnauthorized() {
  window.dispatchEvent(new CustomEvent('dp:unauthorized'));
}

export async function api(path, opts = {}) {
  // POST/PUT/PATCH without a body still send `{}` so Fastify never 415s on
  // empty application/json (the Stop button used to hit this and leave runs stuck).
  const method = String(opts.method || 'GET').toUpperCase();
  const needsBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
  const payload = opts.body !== undefined ? opts.body : (needsBody ? {} : undefined);
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  if (res.status === 401) {
    announceUnauthorized();
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.error ?? `HTTP ${res.status}`), { status: res.status, ...j });
  }
  return res.json();
}

// Read an SSE response body, invoking onEvent per JSON data line.
async function readSse(res, onEvent, signal) {
  if (!res.body) throw new Error('no stream body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip bad frame */ }
      }
    }
  }
}

// POST an SSE endpoint via fetch and invoke onEvent per JSON data line.
// Returns an object with abort(); resolves the promise when the stream ends.
export function sse(path, body, onEvent) {
  const ctrl = new AbortController();
  const done = (async () => {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      // Browsers surface hard disconnects as TypeError/NetworkError with a
      // useless message. Translate so the toast is actionable.
      if (ctrl.signal.aborted) throw err;
      const msg = String(err?.message ?? err);
      if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
        throw new Error(
          'Connection dropped (server restart, tunnel blip, or the image bridge crashed). Try again — if it keeps happening, check that duckpond + image-gen-bridge are running.',
        );
      }
      throw err;
    }
    if (!res.ok || !res.body) {
      if (res.status === 401) announceUnauthorized();
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    try {
      await readSse(res, onEvent, ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) throw err;
      const msg = String(err?.message ?? err);
      if (/failed to fetch|networkerror|network|aborted/i.test(msg)) {
        throw new Error(
          'Stream cut mid-job (often a service restart or Cloudflare timeout on a long image gen). Check Files for a finished image, then retry.',
        );
      }
      throw err;
    }
  })();
  return { abort: () => ctrl.abort(), done };
}

// GET an SSE endpoint (live reattach after refresh). 204 = nothing live.
// Returns { abort, done, active } where active is false on 204.
export function sseGet(path, onEvent) {
  const ctrl = new AbortController();
  let active = true;
  const done = (async () => {
    const res = await fetch(path, {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (res.status === 204) { active = false; return; }
    if (!res.ok || !res.body) {
      if (res.status === 401) announceUnauthorized();
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    await readSse(res, onEvent, ctrl.signal);
  })();
  return { abort: () => ctrl.abort(), done, get active() { return active; } };
}
