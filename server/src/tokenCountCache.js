import { createHash } from 'node:crypto';

// Cache exact tokenizer results, never generated answers or shortened prompts.
// Only a digest and count survive the request; completed entries contain no text.
export function createTokenCountCache({ maxEntries = 128, maxPending = 32, ttlMs = 60_000, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();
  let generation = 0;

  function subscribe(entry, signal) {
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        entry.subscribers--;
        if (!entry.subscribers && !entry.settled) {
          entry.controller.abort(new Error('All tokenizer callers stopped'));
        }
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
      if (signal?.aborted) abort();
    });
  }

  return {
    async get(body, load, { signal } = {}) {
      signal?.throwIfAborted();
      const key = createHash('sha256').update(body).digest('hex');
      const cached = entries.get(key);
      if (cached && now() - cached.at < ttlMs) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.value;
      }
      entries.delete(key);
      const existing = pending.get(key);
      if (existing && !existing.controller.signal.aborted) return subscribe(existing, signal);
      const startedGeneration = generation;
      const entry = { controller: new AbortController(), subscribers: 0, settled: false, promise: null };
      entry.promise = Promise.resolve().then(() => {
        entry.controller.signal.throwIfAborted();
        return load(entry.controller.signal);
      }).then(value => {
        if (!entry.controller.signal.aborted && generation === startedGeneration && Number.isInteger(value) && value >= 0) {
          entries.set(key, { value, at: now() });
          while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        }
        return value;
      }).finally(() => {
        entry.settled = true;
        if (pending.get(key) === entry) pending.delete(key);
      });
      if (pending.size < maxPending || pending.has(key)) pending.set(key, entry);
      return subscribe(entry, signal);
    },
    clear() {
      generation++;
      entries.clear();
      // Existing callers still finish, but new requests cannot join old loads.
      pending.clear();
    },
  };
}
