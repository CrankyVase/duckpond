// A 401 on any call means the session died server-side (logout elsewhere,
// account deleted, expiry). Announce it so the app can kick to the login
// screen without waiting for a manual refresh.
function announceUnauthorized() {
  window.dispatchEvent(new CustomEvent('dp:unauthorized'));
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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

// POST an SSE endpoint via fetch and invoke onEvent per JSON data line.
// Returns an object with abort(); resolves the promise when the stream ends.
export function sse(path, body, onEvent) {
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      if (res.status === 401) announceUnauthorized();
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
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
  })();
  return { abort: () => ctrl.abort(), done };
}
