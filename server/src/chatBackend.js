// Chat backend dispatcher: one call surface for local (llama.cpp router) and
// remote (OpenAI-compatible provider) models. chat.js talks to streamChatAny /
// countTokensAny and never cares which side a model id lives on.
import { db } from './db.js';
import { countInputTokens, listModels, streamChat } from './llama.js';
import {
  estimateTokens, isRemoteId, resolveRemote, streamRemote,
} from './providers.js';

export { isRemoteId };

// llama.cpp-only knobs that OpenAI-compatible APIs reject or ignore.
const LLAMA_ONLY = new Set([
  'top_k', 'repeat_penalty', 'mirostat', 'mirostat_tau', 'mirostat_eta',
  'grammar', 'json_schema', 'chat_template_kwargs', 'timings_per_token',
]);

// Paid models must never run with unlimited output (llama's max_tokens: -1)
// — a runaway loop on a paid endpoint is a real bill. The saver's default
// cap; per-model profiles can raise/lower it via settings.max_tokens.
export const DEFAULT_REMOTE_MAX_TOKENS = 4096;

/** Map duckpond/llama gen params to what an OpenAI-compatible API accepts. */
export function mapParamsForRemote(params = {}, modelRow = null) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (LLAMA_ONLY.has(k) || v === undefined) continue;
    out[k] = v;
  }
  const cap = Number(modelRow?.max_output) > 0
    ? Math.min(Number(modelRow.max_output), DEFAULT_REMOTE_MAX_TOKENS * 4)
    : DEFAULT_REMOTE_MAX_TOKENS;
  if (out.max_tokens == null || Number(out.max_tokens) < 0) out.max_tokens = cap;
  // reasoning_effort passes through (OpenAI o-series, gpt-5, deepseek v3.1+)
  return out;
}

/**
 * streamChat for any model id. Returns the same shape as llama.js streamChat
 * plus `_remote: { provider, modelRow }` when the call went to a provider, so
 * the caller can price it.
 */
export async function streamChatAny({ model, messages, params = {}, onDelta, abortSignal }) {
  if (!isRemoteId(model)) {
    return streamChat({ model, messages, params, onDelta, abortSignal });
  }
  const r = resolveRemote(model);
  if (!r) throw new Error(`remote model unavailable (provider deleted or disabled): ${model}`);
  if (r.model && !r.model.enabled) throw new Error(`model disabled in the Providers panel: ${r.modelId}`);
  const res = await streamRemote({
    provider: r.provider, model: r.modelId, messages,
    params: mapParamsForRemote(params, r.model), onDelta, abortSignal,
  });
  return { ...res, _remote: { provider: r.provider, modelRow: r.model } };
}

/** Exact token count locally; chars/4 estimate for remote endpoints. */
export async function countTokensAny(model, messages) {
  if (!isRemoteId(model)) return countInputTokens(model, messages);
  return estimateTokens(messages);
}

/**
 * Cheapest model for background jobs (titles, follow-up chips, memory
 * extraction, compaction summaries). Policy:
 *  - local conv model → itself (already warm, $0)
 *  - remote conv model → a loaded local model if the router has one ($0),
 *    else the cheapest enabled remote model by in+out price,
 *    else the conv model itself.
 */
export async function auxModelFor(convModelId, log) {
  if (!isRemoteId(convModelId)) return convModelId;
  try {
    const loaded = (await listModels()).find((m) => m.status === 'loaded');
    if (loaded) return loaded.id;
  } catch { /* router down — fall through to remote */ }
  try {
    const rows = db.prepare(`
      SELECT pm.model_id, pm.provider_id, pm.price_in, pm.price_out
      FROM provider_models pm JOIN providers p ON p.id = pm.provider_id
      WHERE p.enabled = 1 AND pm.enabled = 1 AND pm.price_in IS NOT NULL AND pm.price_out IS NOT NULL
      ORDER BY pm.price_in + pm.price_out ASC LIMIT 1`).all();
    if (rows.length) return `r${rows[0].provider_id}:${rows[0].model_id}`;
  } catch (err) { log?.warn({ err }, 'aux model pick failed'); }
  return convModelId;
}
