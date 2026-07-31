// Reasoning dialect + inline <think> splitter tests.
import {
  reasoningDialect, reasoningParams, makeThinkSplitter, splitThinking, hasThinkTags,
} from '../src/reasoning.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${extra}`); fails += 1; }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);

console.log('\n== dialect detection ==');
const P = (u) => ({ base_url: u });
eq('openrouter gateway wins', reasoningDialect(P('https://openrouter.ai/api/v1'), 'anthropic/claude-sonnet-4'), 'openrouter');
eq('anthropic direct', reasoningDialect(P('https://api.anthropic.com/v1'), 'claude-sonnet-4'), 'anthropic');
eq('claude id without anthropic url', reasoningDialect(P('https://nano-gpt.com/api/v1'), 'claude-opus-4'), 'anthropic');
eq('gemini', reasoningDialect(P('https://nano-gpt.com/api/v1'), 'gemini-2.5-pro'), 'google');
eq('gpt-5', reasoningDialect(P('https://api.openai.com/v1'), 'gpt-5'), 'openai');
eq('o3', reasoningDialect(P('https://api.openai.com/v1'), 'o3-mini'), 'openai');
eq('deepseek reasoner is always-on', reasoningDialect(P('https://api.deepseek.com'), 'deepseek-reasoner'), 'always');
eq('qwen on a gateway', reasoningDialect(P('https://nano-gpt.com/api/v1'), 'qwen3-235b'), 'qwen');
eq('local = llama', reasoningDialect(null, 'qwen3-30b-a3b'), 'llama');
eq('unknown remote falls back to openai', reasoningDialect(P('https://x.example/v1'), 'mystery-model'), 'openai');

console.log('\n== params per dialect ==');
eq('anthropic high', reasoningParams({ dialect: 'anthropic', effort: 'high' }), { thinking: { type: 'enabled', budget_tokens: 16384 } });
eq('anthropic off', reasoningParams({ dialect: 'anthropic', effort: 'none' }), { thinking: { type: 'disabled' } });
eq('openrouter effort', reasoningParams({ dialect: 'openrouter', effort: 'low' }), { reasoning: { effort: 'low' } });
eq('openrouter explicit budget', reasoningParams({ dialect: 'openrouter', effort: 'high', budget: 5000 }), { reasoning: { max_tokens: 5000 } });
eq('google budget', reasoningParams({ dialect: 'google', effort: 'low' }), { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } });
eq('qwen on', reasoningParams({ dialect: 'qwen', effort: 'high' }), { chat_template_kwargs: { enable_thinking: true } });
eq('qwen off', reasoningParams({ dialect: 'qwen', effort: 'none' }), { chat_template_kwargs: { enable_thinking: false } });
eq('openai effort', reasoningParams({ dialect: 'openai', effort: 'high' }), { reasoning_effort: 'high' });
eq('auto sends nothing', reasoningParams({ dialect: 'openai', effort: 'auto' }), {});
eq('unsupported model sends nothing', reasoningParams({ dialect: 'openai', effort: 'high', supported: false }), {});
eq('always-on dialect sends nothing', reasoningParams({ dialect: 'always', effort: 'high' }), {});
ok('constrained turn forces thinking off',
  JSON.stringify(reasoningParams({ dialect: 'qwen', effort: 'high', constrained: true })) === JSON.stringify({ chat_template_kwargs: { enable_thinking: false } }));
ok('off works even when caps say unsupported',
  Object.keys(reasoningParams({ dialect: 'qwen', effort: 'none', supported: false })).length > 0);

console.log('\n== remote qwen soft switch ==');
// chat_template_kwargs is on the remote strip list, so remote qwen models use
// Qwen3's prompt-text switches instead — they survive any gateway.
eq('remote qwen off', reasoningParams({ dialect: 'qwen', effort: 'none', remote: true }), { _soft: '/no_think' });
eq('remote qwen high', reasoningParams({ dialect: 'qwen', effort: 'high', remote: true }), { _soft: '/think' });
eq('remote qwen auto', reasoningParams({ dialect: 'qwen', effort: 'auto', remote: true }), {});
eq('remote qwen constrained', reasoningParams({ dialect: 'qwen', effort: 'high', constrained: true, remote: true }), { _soft: '/no_think' });
eq('LOCAL qwen still uses kwargs', reasoningParams({ dialect: 'qwen', effort: 'none', remote: false }), { chat_template_kwargs: { enable_thinking: false } });
eq('remote anthropic unaffected', reasoningParams({ dialect: 'anthropic', effort: 'high', remote: true }), { thinking: { type: 'enabled', budget_tokens: 16384 } });

console.log('\n== inline <think> splitting ==');
let s = makeThinkSplitter();
let r = s.push('<think>let me reason</think>The answer is 42.');
eq('single chunk splits cleanly', r, { text: 'The answer is 42.', reasoning: 'let me reason' });

s = makeThinkSplitter();
const chunks = ['<thi', 'nk>step one', ' step two</th', 'ink>Visible ', 'answer.'];
let text = '';
let reasoning = '';
for (const c of chunks) { const o = s.push(c); text += o.text; reasoning += o.reasoning; }
const f = s.flush(); text += f.text; reasoning += f.reasoning;
eq('tag split across chunks', { text, reasoning }, { text: 'Visible answer.', reasoning: 'step one step two' });

s = makeThinkSplitter();
let leaked = '';
for (const c of ['Here <thi', 'nk>hidden</think> there']) leaked += s.push(c).text;
leaked += s.flush().text;
ok('no partial tag ever leaks into visible text', !leaked.includes('<') && !leaked.includes('thi>'), JSON.stringify(leaked));
eq('surrounding text preserved exactly', leaked, 'Here  there');

s = makeThinkSplitter();
r = s.push('no tags at all here');
eq('plain text passes through untouched', r, { text: 'no tags at all here', reasoning: '' });

s = makeThinkSplitter();
r = s.push('<think>truncated reasoning with no close');
const fl = s.flush();
eq('unclosed think is reasoning, not text', { text: r.text + fl.text, reasoning: r.reasoning + fl.reasoning },
  { text: '', reasoning: 'truncated reasoning with no close' });

s = makeThinkSplitter();
let t2 = ''; let g2 = '';
for (const c of ['<think>a</think>vis1<thinking>b</thinking>vis2']) { const o = s.push(c); t2 += o.text; g2 += o.reasoning; }
eq('multiple blocks and tag aliases', { text: t2, reasoning: g2 }, { text: 'vis1vis2', reasoning: 'ab' });

s = makeThinkSplitter();
const trail = s.push('answer ends with a lone <');
eq('lone angle bracket is held, not dropped', trail.text, 'answer ends with a lone ');
eq('...and released on flush', s.flush().text, '<');

console.log('\n== one-shot helpers ==');
eq('splitThinking', splitThinking('<think>why</think>because'), { text: 'because', reasoning: 'why' });
ok('hasThinkTags positive', hasThinkTags('a <think>b</think>'));
ok('hasThinkTags negative', !hasThinkTags('a < b > c'));

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll green.\n');
process.exit(fails ? 1 : 0);
