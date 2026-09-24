import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logoForModel, logoForProvider, resolveHubLogo } from '../src/lib/hubLogos.js';
import { LOBE_ICON_FILES } from '../src/lib/lobeIconFiles.js';

const iconDir = new URL('../node_modules/@lobehub/icons-static-svg/icons/', import.meta.url);

function fileOf(logo) {
  assert.ok(logo?.path?.startsWith('/hub/logo/'), logo?.id);
  const name = logo.path.slice('/hub/logo/'.length);
  assert.equal(LOBE_ICON_FILES[logo.id], name);
  assert.equal(existsSync(join(iconDir.pathname, name)), true, name);
  return logo.id;
}

assert.equal(fileOf(logoForModel('Qwen/Qwen-Image-2.1')), 'qwen');
assert.equal(fileOf(logoForModel('unsloth/Qwen3-30B-A3B-GGUF')), 'qwen');
assert.equal(fileOf(resolveHubLogo('unsloth', 'Qwen3-30B-A3B-GGUF')), 'qwen');
assert.equal(fileOf(logoForModel('meta-llama/Llama-3.1-8B')), 'meta');
assert.equal(fileOf(logoForModel('google/gemma-3-4b-it')), 'gemma');
assert.equal(fileOf(logoForModel('deepseek-ai/DeepSeek-R1')), 'deepseek');
assert.equal(fileOf(logoForModel('mistralai/Mistral-7B-v0.1')), 'mistral');
assert.equal(fileOf(logoForModel('black-forest-labs/FLUX.2-klein-4B')), 'flux');
assert.equal(fileOf(logoForModel('MiniMaxAI/MiniMax-H3')), 'minimax');
assert.equal(fileOf(logoForModel('Wan-AI/Wan2.1-T2V-14B')), 'qwen');
assert.equal(fileOf(logoForModel('r4:openai/gpt-4o')), 'openai');
assert.equal(fileOf(logoForModel('anthropic/claude-sonnet-4')), 'claude');
assert.equal(fileOf(logoForModel('xai-org/grok-3')), 'grok');
assert.equal(fileOf(resolveHubLogo('huggingface', 'SmolLM2-1.7B')), 'huggingface');
assert.equal(fileOf(logoForModel('Qwen/Qwen3-TTS')), 'qwen');
assert.equal(fileOf(logoForModel('openai/tts-1')), 'openai');
assert.equal(logoForModel('openmoss-team/moss-tts-nano'), null);

assert.equal(fileOf(logoForProvider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1')), 'openrouter');
assert.equal(fileOf(logoForProvider('opencode-zen', 'OpenCode Zen', 'https://opencode.ai/zen/v1')), 'opencode');
assert.equal(fileOf(logoForProvider('gemini', 'Google Gemini')), 'gemini');
assert.equal(fileOf(logoForProvider('github-models', 'GitHub Models')), 'github');
assert.equal(fileOf(logoForProvider('nvidia', 'NVIDIA Build')), 'nvidia');
assert.equal(fileOf(logoForProvider('groq', 'Groq')), 'groq');
assert.equal(fileOf(logoForProvider('cerebras', 'Cerebras')), 'cerebras');
assert.equal(fileOf(logoForProvider('minimax', 'MiniMax')), 'minimax');

console.log('Hub logos: Lobe brand marks resolve for models and providers.');
