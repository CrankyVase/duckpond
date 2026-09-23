// The same mapping is used by every paid-model call path. Explicit per-model
// max_tokens can override the default; the default stays bounded everywhere.
const LLAMA_ONLY = new Set([
  'top_k', 'repeat_penalty', 'mirostat', 'mirostat_tau', 'mirostat_eta',
  'grammar', 'json_schema', 'chat_template_kwargs', 'timings_per_token',
]);

export const DEFAULT_REMOTE_MAX_TOKENS = 4096;

export function mapParamsForRemote(params = {}, modelRow = null) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (LLAMA_ONLY.has(key) || value === undefined) continue;
    out[key] = value;
  }
  const advertised = Number(modelRow?.max_output);
  const cap = Number.isFinite(advertised) && advertised > 0
    ? Math.min(advertised, DEFAULT_REMOTE_MAX_TOKENS)
    : DEFAULT_REMOTE_MAX_TOKENS;
  const requested = Number(out.max_tokens);
  if (out.max_tokens == null || !Number.isInteger(requested) || requested <= 0) out.max_tokens = cap;
  else if (Number.isFinite(advertised) && advertised > 0) out.max_tokens = Math.min(requested, advertised);
  return out;
}
