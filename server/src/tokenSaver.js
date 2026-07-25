// The always-on savings pipeline for remote (paid) turns — "most lossless,
// most savings". Every technique here is either free of quality loss or only
// kicks in when doing nothing would break the turn (auto-compaction).
//
//  1. exact response cache        — identical plain prompt → free replay
//  2. prefix-cache-friendly order — volatile system blocks go LAST, so the
//     provider's automatic prompt caching keeps hitting on the stable head
//  3. auto max_tokens cap         — no unlimited-output bills (chatBackend)
//  4. cheap aux routing           — titles/followups/memory/compaction run on
//     the cheapest available model (chatBackend.auxModelFor)
//  5. auto-compaction             — prompts that would overflow (or blow past
//     80% of) the context get compacted first, using the existing lossy-but-
//     reviewed compaction nodes, so the turn survives AND costs less
import { estimateTokens } from './providers.js';

// Fraction of the context window at which auto-compaction fires. Above this,
// the provider call would either error out or cost much more than needed.
export const AUTO_COMPACT_AT = 0.8;

/** Estimated prompt tokens vs the model's budget. */
export function promptPressure(messages, ctxSize) {
  const used = estimateTokens(messages);
  const budget = Number(ctxSize) > 0 ? Number(ctxSize) : 128_000;
  return { used, budget, over: used > budget * AUTO_COMPACT_AT };
}

const DATE_RE = /^Today's date is [^\n]+\n?/;

/**
 * Reorder the single leading system message so the stable head (core prompt,
 * model system prompt, tool policies) comes first and volatile blocks (the
 * date line, recalled-memory block, attached-doc excerpts) go last.
 * Provider-side prefix caches key on the prompt PREFIX — every turn that
 * starts with the same bytes reuses cached (discounted) input tokens.
 * Content is unchanged, only the order: lossless in the bits that matter.
 */
export function orderSystemForPrefixCache(messages) {
  if (!messages?.length || messages[0]?.role !== 'system') return messages;
  let content = messages[0].content;
  const volatileParts = [];
  // 1) the date line is always first (buildPrompt pushes it before anything)
  const dm = content.match(DATE_RE);
  if (dm) {
    volatileParts.push(dm[0].trim());
    content = content.slice(dm[0].length).replace(/^\n+/, '');
  }
  // 2) sections that change turn-to-turn — cut them out and re-append.
  for (const marker of ['## Your long-term memory', '## Attached documents', '## User location']) {
    const i = content.indexOf(marker);
    if (i === -1) continue;
    // section runs to the next "## " heading or the end
    const rest = content.slice(i);
    const next = rest.indexOf('\n## ', 1);
    const section = next === -1 ? rest : rest.slice(0, next);
    volatileParts.push(section.trim());
    content = (content.slice(0, i) + (next === -1 ? '' : rest.slice(next))).replace(/\n{3,}/g, '\n\n').trim();
  }
  if (!volatileParts.length) return messages;
  return [
    { role: 'system', content: `${content}\n\n${volatileParts.join('\n\n')}` },
    ...messages.slice(1),
  ];
}

/** Is this turn eligible for the exact response cache? Plain chat only:
 * no workspace/agent, no constrained output, not a regeneration. */
export function cacheEligible({ remote, wsRow, constrained, regenerateFrom, cacheEnabled }) {
  return !!(remote && cacheEnabled && !wsRow && !constrained && !regenerateFrom);
}
