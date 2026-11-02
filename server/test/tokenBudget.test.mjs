import assert from 'node:assert/strict';
import {
  compactPromptLimit, desiredOutputTokens, localOutputBudget, MIN_OUTPUT_TOKENS,
} from '../src/tokenBudget.js';

// A thinking model is not forced to fit its reasoning and answer inside the
// old 2,048-token reply cap.
assert.equal(
  localOutputBudget({ ctxSize: 32768, promptTokens: 4000, requested: 2048, thinking: true }),
  32768 - 4000 - 512,
);
assert.equal(
  localOutputBudget({ ctxSize: 32768, promptTokens: 4000, requested: 2048, thinking: false }),
  2048,
);
// The remaining window is always respected, even when the profile asks for a
// larger answer than the prompt leaves room for.
assert.equal(
  localOutputBudget({ ctxSize: 8192, promptTokens: 7600, requested: 8192, thinking: false }),
  MIN_OUTPUT_TOKENS,
);
assert.equal(
  localOutputBudget({ ctxSize: 8192, promptTokens: 7600, requested: 8192, thinking: true }),
  Math.max(MIN_OUTPUT_TOKENS, 8192 - 7600 - 512),
);
// Compaction fires before the context wall so there is room left to answer.
assert.equal(compactPromptLimit(32768, { desiredOutput: 8192 }), 32768 - 8192 - 1024);
assert(desiredOutputTokens({ ctxSize: 32768, requested: 2048, thinking: true }) >= 8192);
console.log('token budget: thinking headroom and compaction threshold');
