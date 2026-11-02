// Output/context budgeting for generation turns.
//
// A thinking model spends the same max_tokens budget as its answer. The old
// flat 2,048-token local cap could therefore be consumed entirely by
// reasoning, leaving an empty reply. These helpers treat the configured reply
// limit as a minimum headroom instead of a hard ceiling for local models:
// generation may use the rest of the context window, and older history is
// compacted before that window runs out.

export const MIN_OUTPUT_TOKENS = 512;
export const DEFAULT_DESIRED_OUTPUT = 8192;
// Keep enough room for reasoning + an answer even when a model profile still
// has the old 2,048-token reply limit saved.
export const THINKING_OUTPUT_FLOOR = 8192;
const CONTEXT_MARGIN = 512;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function desiredOutputTokens({ ctxSize, requested, thinking = false } = {}) {
  const ctx = positive(ctxSize, 32_768);
  const base = positive(requested, DEFAULT_DESIRED_OUTPUT);
  const floor = thinking ? Math.max(base, THINKING_OUTPUT_FLOOR) : base;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(floor, Math.floor(ctx / 2)));
}

/**
 * What max_tokens to send to a local model on this call. The configured reply
 * limit is a floor; if the context still has room, the model may keep thinking
 * and answering until the window is genuinely near full.
 */
export function localOutputBudget({ ctxSize, promptTokens, requested, thinking = false } = {}) {
  const ctx = positive(ctxSize, 32_768);
  const remaining = Math.max(MIN_OUTPUT_TOKENS, Math.floor(ctx - positive(promptTokens, 0) - CONTEXT_MARGIN));
  const wanted = desiredOutputTokens({ ctxSize: ctx, requested, thinking });
  // Thinking may use every remaining token: a model that needs a long internal
  // monologue should not be cut off while the answer is still unspoken.
  if (thinking) return remaining;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(wanted, remaining));
}

/**
 * Prompt size at which history should be compacted so the next call still has
 * useful output headroom. This is deliberately earlier than "context full":
 * waiting for overflow leaves no space to answer.
 */
export function compactPromptLimit(ctxSize, { desiredOutput = DEFAULT_DESIRED_OUTPUT } = {}) {
  const ctx = positive(ctxSize, 32_768);
  const reserve = Math.min(positive(desiredOutput, DEFAULT_DESIRED_OUTPUT), Math.floor(ctx / 2));
  const margin = Math.min(1024, Math.ceil(ctx * 0.05));
  return Math.max(1, Math.floor(ctx - reserve - margin));
}
