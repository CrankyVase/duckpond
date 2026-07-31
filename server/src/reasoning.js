// Reasoning / "thinking" mode — dialect translation + inline-tag splitting.
//
// Why this file exists: DuckPond already had a `thinking` setting, a
// `reasoning_effort` param, a `messages.thinking` column and a collapsible
// thinking panel — and it still looked broken on most providers, for two
// reasons this module fixes.
//
// 1. DIALECTS. `reasoning_effort` is an OpenAI-ism. Anthropic wants
//    `thinking: {type:'enabled', budget_tokens}`, OpenRouter wants
//    `reasoning: {effort|max_tokens}`, Google wants `thinkingConfig`, qwen-style
//    llama.cpp templates want `chat_template_kwargs.enable_thinking`. Sending
//    the wrong one is a silent no-op (best case) or a 400 (worst), so the
//    toggle appeared to do nothing.
//
// 2. INLINE TAGS. Plenty of gateways don't populate `reasoning_content` at all
//    — they inline the chain of thought in `content` as `<think>…</think>`.
//    With no parser, that leaked raw tags into the visible reply. Splitting it
//    out has to survive a tag arriving split across two stream chunks, which is
//    what makeThinkSplitter() is for.
//
// Everything here is derived automatically from the provider URL, the model id
// and the sniffed capability flags. The user-facing setting stays a single
// four-way choice (auto/high/low/none) and 'auto' is correct for everyone.

// ---------- dialects ----------

/**
 * Which reasoning dialect does this model speak?
 * `provider` is the providers row (null for local llama.cpp).
 */
export function reasoningDialect(provider, modelId) {
  const id = String(modelId ?? '').toLowerCase();
  const base = String(provider?.base_url ?? '').toLowerCase();

  // A gateway's own envelope wins over the underlying model's: OpenRouter
  // normalises every upstream model onto its `reasoning` object.
  if (base.includes('openrouter')) return 'openrouter';
  if (base.includes('anthropic') || /(^|\/)claude-/.test(id)) return 'anthropic';
  if (base.includes('generativelanguage') || base.includes('googleapis') || /(^|\/)gemini-/.test(id)) return 'google';
  if (/(^|\/)(gpt-5|o[1345](-|$)|gpt-oss)/.test(id)) return 'openai';
  // DeepSeek's reasoner thinks unconditionally and rejects effort knobs; we
  // still capture its reasoning_content, we just never send a parameter.
  if (/deepseek-(r1|reasoner)/.test(id)) return 'always';
  if (!provider) return 'llama';          // local llama-server understands both
  // qwen/glm/minimax-style templates on an OpenAI-compatible endpoint
  if (/qwen|qwq|glm-|minimax|kimi|magistral/.test(id)) return 'qwen';
  return 'openai';                        // the safest generic guess
}

// effort → token budget, for the dialects that want a number instead of a word
const BUDGETS = { low: 2048, medium: 8192, high: 16384 };

/**
 * Build the provider-specific params for a turn.
 *
 * @param {object}  o
 * @param {string}  o.dialect    from reasoningDialect()
 * @param {string}  o.effort     'auto' | 'high' | 'low' | 'none'
 * @param {boolean} o.supported  caps.reasoning — false means send nothing
 * @param {number}  [o.budget]   explicit token budget, overrides the effort map
 * @param {boolean} [o.constrained] grammar/JSON-schema turn: thinking must be
 *                                  off, or the constrained tokens get swallowed
 *                                  as reasoning and the reply comes back empty
 * @returns {object} params to merge into the request body
 */
export function reasoningParams({
  dialect, effort = 'auto', supported = true, budget = 0, constrained = false, remote = false,
}) {
  // Remote qwen-style models are a special case. `chat_template_kwargs` is on
  // the llama-only strip list (an OpenAI-compatible gateway may 400 on it, and
  // a 400 is not retryable, so the turn would just die) — but Qwen3 also ships
  // a provider-agnostic soft switch: the literal token `/no_think` in the last
  // user message. That is plain prompt text, so it survives any gateway.
  // `_soft` is not a request param; chatPost applies it to the message.
  if (remote && dialect === 'qwen') {
    if (effort === 'none' || constrained) return { _soft: '/no_think' };
    if (effort === 'high' || effort === 'low') return { _soft: '/think' };
    return {};
  }
  return reasoningParamsFor({ dialect, effort, supported, budget, constrained });
}

function reasoningParamsFor({ dialect, effort = 'auto', supported = true, budget = 0, constrained = false }) {
  // Off is meaningful even for models that can't think — it's how we stop a
  // qwen template from burning the budget on chain-of-thought.
  const off = effort === 'none' || constrained;
  if (off) {
    switch (dialect) {
      case 'anthropic': return { thinking: { type: 'disabled' } };
      case 'openrouter': return { reasoning: { exclude: true, enabled: false } };
      case 'google': return { thinkingConfig: { thinkingBudget: 0 } };
      case 'qwen':
      case 'llama': return { chat_template_kwargs: { enable_thinking: false } };
      // OpenAI reasoning models cannot be told not to think; asking for the
      // cheapest tier is the closest thing to off.
      case 'openai': return { reasoning_effort: 'low' };
      default: return {};
    }
  }
  if (!supported || dialect === 'always') return {};
  // 'auto' = let the provider decide. Sending nothing is genuinely the best
  // default: every one of these APIs has a sensible built-in.
  if (effort === 'auto' && !budget) return {};

  const tier = effort === 'auto' ? 'medium' : effort;
  const tokens = budget > 0 ? budget : BUDGETS[tier] ?? BUDGETS.medium;
  switch (dialect) {
    case 'anthropic':
      // Anthropic requires max_tokens > budget_tokens; the caller's cap is
      // enforced downstream, so keep the budget clear of the 4096 remote cap.
      return { thinking: { type: 'enabled', budget_tokens: Math.min(tokens, 32_000) } };
    case 'openrouter':
      return budget > 0
        ? { reasoning: { max_tokens: tokens } }
        : { reasoning: { effort: tier } };
    case 'google':
      return { thinkingConfig: { thinkingBudget: Math.min(tokens, 24_576), includeThoughts: true } };
    case 'qwen':
      return { chat_template_kwargs: { enable_thinking: true } };
    case 'llama':
      return { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: tier };
    case 'openai':
    default:
      return { reasoning_effort: tier };
  }
}

/** Params that carry reasoning config, for the remote-strip lists to know about. */
export const REASONING_PARAM_KEYS = [
  'reasoning_effort', 'reasoning', 'thinking', 'thinkingConfig', 'chat_template_kwargs',
];

// ---------- inline <think> splitting ----------

const OPEN_TAGS = ['<think>', '<thinking>', '<reason>', '<reasoning>', '<|thinking|>'];
const CLOSE_TAGS = ['</think>', '</thinking>', '</reason>', '</reasoning>', '<|/thinking|>'];
const MAX_TAG = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((t) => t.length));

/** Index where a suffix of `buf` starts that could still grow into a tag. */
function partialTagStart(buf, tags) {
  const max = Math.min(buf.length, MAX_TAG - 1);
  for (let len = max; len > 0; len -= 1) {
    const suffix = buf.slice(buf.length - len);
    if (tags.some((t) => t.length > len && t.startsWith(suffix))) return buf.length - len;
  }
  return -1;
}

/**
 * Stateful splitter for providers that inline reasoning in `content`.
 *
 * Returns `push(chunk) -> {text, reasoning}` plus `flush()`. Safe across chunk
 * boundaries: a `<thi` at the end of one delta and `nk>` at the start of the
 * next is held back rather than emitted as visible text. That hold-back is the
 * whole point — without it the user sees half a tag flash into the reply.
 */
export function makeThinkSplitter() {
  let mode = 'text';      // 'text' | 'think'
  let pending = '';       // possible partial tag carried to the next chunk

  const push = (chunk) => {
    let buf = pending + String(chunk ?? '');
    pending = '';
    let text = '';
    let reasoning = '';

    while (buf) {
      const tags = mode === 'text' ? OPEN_TAGS : CLOSE_TAGS;
      let idx = -1;
      let hit = null;
      for (const t of tags) {
        const i = buf.indexOf(t);
        if (i !== -1 && (idx === -1 || i < idx)) { idx = i; hit = t; }
      }
      if (idx !== -1) {
        const head = buf.slice(0, idx);
        if (mode === 'text') text += head; else reasoning += head;
        buf = buf.slice(idx + hit.length);
        mode = mode === 'text' ? 'think' : 'text';
        continue;
      }
      const cut = partialTagStart(buf, tags);
      if (cut === -1) {
        if (mode === 'text') text += buf; else reasoning += buf;
      } else {
        const head = buf.slice(0, cut);
        if (mode === 'text') text += head; else reasoning += head;
        pending = buf.slice(cut);
      }
      buf = '';
    }
    return { text, reasoning };
  };

  /** End of stream: whatever is held back is real content, not a tag. */
  const flush = () => {
    const left = pending;
    pending = '';
    if (!left) return { text: '', reasoning: '' };
    return mode === 'text' ? { text: left, reasoning: '' } : { text: '', reasoning: left };
  };

  return { push, flush, inThinking: () => mode === 'think' };
}

/**
 * One-shot version for non-streamed text (cache replays, stored messages).
 * Returns `{ text, reasoning }` with the tags removed.
 */
export function splitThinking(full) {
  const s = makeThinkSplitter();
  const a = s.push(full);
  const b = s.flush();
  return { text: a.text + b.text, reasoning: a.reasoning + b.reasoning };
}

/** Does this text look like it carries inline reasoning tags at all? */
export const hasThinkTags = (s) => /<(\/)?(think|thinking|reason|reasoning)>/i.test(String(s ?? ''));
