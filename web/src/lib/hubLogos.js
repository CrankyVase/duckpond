// Brand marks from @lobehub/icons (static SVG build — this app is Svelte,
// so we use the same collection's SVG files instead of the React components).
// Keyword order matches Lobe's ModelIcon `modelMappings`: first match wins.
import { LOBE_ICON_FILES } from './lobeIconFiles.js';

function mark(id) {
  const file = LOBE_ICON_FILES[id];
  return file ? { id, path: `/hub/logo/${file}` } : null;
}

function compile(table) {
  return table.map((row) => ({
    id: row.id,
    tests: row.keywords.map((keyword) => new RegExp(keyword, 'i')),
  }));
}

function match(text, rules) {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack) return null;
  for (const rule of rules) {
    if (rule.tests.some((re) => re.test(haystack))) return mark(rule.id);
  }
  return null;
}

// Same keyword order as @lobehub/icons ModelIcon.
const MODEL_RULES = compile([
  { id: 'openai', keywords: ['gpt-3'] },
  { id: 'openai', keywords: ['gpt-4'] },
  { id: 'openai', keywords: ['gpt-5'] },
  { id: 'sora', keywords: ['sora'] },
  { id: 'openai', keywords: ['gpt-oss'] },
  { id: 'openai', keywords: ['o1-', '^o1', '/o1', 'o3-', '^o3', '/o3', 'o4-', '^o4', '/o4'] },
  { id: 'dalle', keywords: ['dalle', 'dall-e'] },
  { id: 'openai', keywords: ['text-embedding-', '(^|/)tts-', '(^|/)whisper-', 'codex', 'davinci', 'babbage', 'omni-moderation', 'text-moderation', 'text-adb', 'text-ada', 'computer-use'] },
  { id: 'openai', keywords: ['^gpt-', '/gpt-', 'openai'] },
  { id: 'glmv', keywords: ['^glm-(.*)v', '/glm-(.*)v', '-glm-(.*)v'] },
  { id: 'zai', keywords: ['^glm-5', '/glm-5', '/glm5', '-glm-4', '^glm-4', '/glm-4', '/glm4', '-glm-5'] },
  { id: 'chatglm', keywords: ['^glm-', '/glm-', 'chatglm', '-glm-'] },
  { id: 'codegeex', keywords: ['^codegeex', '/codegeex'] },
  { id: 'claude', keywords: ['claude'] },
  { id: 'anthropic', keywords: ['anthropic'] },
  { id: 'aws', keywords: ['titan'] },
  { id: 'fireworks', keywords: ['accounts/fireworks/models/fire'] },
  { id: 'internlm', keywords: ['internlm', 'internvl'] },
  { id: 'nousresearch', keywords: ['deephermes', 'hermes', 'genstruct', 'minos'] },
  { id: 'nvidia', keywords: ['nemotron', 'openreasoning', 'nemoretriever', 'neva-', 'nv-'] },
  { id: 'meta', keywords: ['llama', '/l3'] },
  { id: 'llava', keywords: ['llava'] },
  { id: 'nanobanana', keywords: ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'gemini-\\d+(?:\\.\\d+)?-(?:flash(?:-lite)?|pro)-image(?:-preview)?(?::|$)', 'nanobanana', 'nano-banana'] },
  { id: 'gemini', keywords: ['gemini'] },
  { id: 'deepmind', keywords: ['^imagen-', '/imagen-', '^imagen\\d/', '/imagen\\d'] },
  { id: 'gemma', keywords: ['gemma'] },
  { id: 'moonshot', keywords: ['kimi', 'moonshot'] },
  { id: 'qiniu', keywords: ['qiniu'] },
  { id: 'qwen', keywords: ['qwen', 'qwq', 'qvq', 'wanx', 'wan\\d/', 'wan\\d\\.\\d-', 'tongyi', 'gte-rerank'] },
  { id: 'minimax', keywords: ['minimax', 'abab', '^image-'] },
  { id: 'mistral', keywords: ['mistral', 'mixtral', 'codestral', 'mathstral', '/mn-', 'pixtral', 'ministral', 'magistral', 'devstral', 'voxtral'] },
  { id: 'perplexity', keywords: ['pplx', 'sonar'] },
  { id: 'yi', keywords: ['^yi-', '/yi-', '-yi-'] },
  { id: 'openrouter', keywords: ['^openrouter'] },
  { id: 'relace', keywords: ['^relace-', '/relace-'] },
  { id: 'arcee', keywords: ['^trinity-', '/trinity-', 'afm-4.5b', 'caller-large', 'spotlight', 'maestro-reasoning', 'virtuoso-medium-v2', 'virtuoso-large', 'coder-large', 'arcee-blitz'] },
  { id: 'essentialai', keywords: ['^rnj-', '/rnj-'] },
  { id: 'deepcogito', keywords: ['^deepcogito-', '/deepcogito-', '^cogito-', '/cogito-'] },
  { id: 'morph', keywords: ['^morph-', '/morph-'] },
  { id: 'ai2', keywords: ['^olmo-', '/olmo-'] },
  { id: 'inception', keywords: ['^mercury', '/mercury'] },
  { id: 'openchat', keywords: ['^openchat'] },
  { id: 'aya', keywords: ['aya'] },
  { id: 'cohere', keywords: ['command'] },
  { id: 'dbrx', keywords: ['dbrx'] },
  { id: 'stepfun', keywords: ['step'] },
  { id: 'aimass', keywords: ['taichu'] },
  { id: 'ai360', keywords: ['360gpt', '360zhinao'] },
  { id: 'baichuan', keywords: ['baichuan'] },
  { id: 'rwkv', keywords: ['rwkv', '/eagle-'] },
  { id: 'wenxin', keywords: ['ernie', 'irag'] },
  { id: 'jina', keywords: ['^jina', '/jina'] },
  { id: 'jimeng', keywords: ['^jimeng-', '/jimeng-', 'seedream', 'seededit', 'seedance-'] },
  { id: 'doubao', keywords: ['^ep-', 'doubao-'] },
  { id: 'kling', keywords: ['^kling', 'kling-', 'klingai'] },
  { id: 'hunyuan', keywords: ['hunyuan', 'hy3'] },
  { id: 'fishaudio', keywords: ['^d_', '^g_', '^wd_'] },
  { id: 'bytedance', keywords: ['skylark', 'seed-', 'bytedance'] },
  { id: 'burncloud', keywords: ['burncloud'] },
  { id: 'stability', keywords: ['stable-diffusion', 'stable-video', 'stable-cascade', 'sdxl', 'stablelm', '^stable-', '^sd3', '^sd2', '^sd1'] },
  { id: 'flux', keywords: ['flux'] },
  { id: 'suno', keywords: ['suno'] },
  { id: 'microsoft', keywords: ['wizardlm', '/phi-', '^phi-', '-phi-', 'mai-', 'microsoft'] },
  { id: 'adobe', keywords: ['firefly'] },
  { id: 'ai21', keywords: ['jamba', '^j2-', 'ai21'] },
  { id: 'upstage', keywords: ['^solar-', '/solar'] },
  { id: 'palm', keywords: ['palm'] },
  { id: 'sensenova', keywords: ['SenseChat', 'SenseNova'] },
  { id: 'grok', keywords: ['^grok-', '/grok-'] },
  { id: 'ideogram', keywords: ['ideogram', '^v_1', '^v_2', '^v3$', '^upscale$', '^describe$'] },
  { id: 'meta', keywords: ['(^|/)muse-spark($|-)'] },
  { id: 'spark', keywords: ['spark', 'general$', 'generalv3$', 'generalv3.5$', '4.0ultra$', 'pro-128k$', '^max-32k$', '^lite$', '^x1$'] },
  { id: 'udio', keywords: ['udio'] },
  { id: 'unionalpha', keywords: ['union-alpha', 'unionalpha', 'pareto'] },
  { id: 'deepseek', keywords: ['deepseek'] },
  { id: 'voyage', keywords: ['voyage'] },
  { id: 'assemblyai', keywords: ['assemblyai'] },
  { id: 'liquid', keywords: ['liquid', 'lfm'] },
  { id: 'inflection', keywords: ['inflection-'] },
  { id: 'aionlabs', keywords: ['aion-'] },
  { id: 'aihubmix', keywords: ['aihubmix'] },
  { id: 'v0', keywords: ['^v0-'] },
  { id: 'vertexai', keywords: ['^veo-', '/veo-', '^veo3'] },
  { id: 'google', keywords: ['google', 'learnlm', 'nano-banana'] },
  { id: 'cogview', keywords: ['cogview'] },
  { id: 'kolors', keywords: ['kolors'] },
  { id: 'baiducloud', keywords: ['baidu', 'qianfan'] },
  { id: 'phind', keywords: ['phind'] },
  { id: 'dolphin', keywords: ['dolphin'] },
  { id: 'ibm', keywords: ['ibm', 'granite'] },
  { id: 'skywork', keywords: ['skywork'] },
  { id: 'bilibiliindex', keywords: ['bilibili-index', 'index-tts'] },
  { id: 'bilibili', keywords: ['bilibili'] },
  { id: 'lg', keywords: ['kmmlu', 'exaone', 'lgai'] },
  { id: 'tii', keywords: ['falcon'] },
  { id: 'menlo', keywords: ['menlo', 'lucy', 'jan-nano'] },
  { id: 'longcat', keywords: ['longcat'] },
  { id: 'kwaipilot', keywords: ['kat-'] },
  { id: 'nova', keywords: ['^nova-', '/nova-'] },
  { id: 'xiaomimimo', keywords: ['^mimo-', '/mimo-'] },
  { id: 'baai', keywords: ['^baai', '^bge-', '/beg-', 'touchd', 'robobrain'] },
  { id: 'ace', keywords: ['ace-step'] },
  { id: 'cursor', keywords: ['^composer', '/composer', '-composer'] },
  { id: 'midjourney', keywords: ['midjourney'] },
  { id: 'luma', keywords: ['^luma', '/luma', 'ray2'] },
  { id: 'recraft', keywords: ['recraft'] },
]);

// Used when the repo id itself doesn't say the family (official org uploads).
const OWNERS = [
  { id: 'qwen', names: ['qwen', 'alibaba'] },
  { id: 'meta', names: ['meta-llama', 'meta', 'facebook'] },
  { id: 'mistral', names: ['mistralai', 'mistral'] },
  { id: 'google', names: ['google'] },
  { id: 'microsoft', names: ['microsoft'] },
  { id: 'nvidia', names: ['nvidia'] },
  { id: 'deepseek', names: ['deepseek-ai', 'deepseek'] },
  { id: 'moonshot', names: ['moonshotai', 'moonshot'] },
  { id: 'zai', names: ['zai-org', 'zai', 'zhipu', 'thudm', 'openbmb'] },
  { id: 'minimax', names: ['minimax', 'minimax-ai'] },
  { id: 'cohere', names: ['cohere', 'cohereforai'] },
  { id: 'ibm', names: ['ibm', 'ibm-granite'] },
  { id: 'openai', names: ['openai'] },
  { id: 'grok', names: ['xai-org', 'xai', 'x-ai'] },
  { id: 'huggingface', names: ['huggingface'] },
  { id: 'stability', names: ['stabilityai', 'stability'] },
  { id: 'flux', names: ['black-forest-labs', 'bfl'] },
  { id: 'bytedance', names: ['bytedance'] },
  { id: 'internlm', names: ['internlm'] },
  { id: 'yi', names: ['01-ai'] },
  { id: 'nousresearch', names: ['nousresearch'] },
  { id: 'liquid', names: ['liquidai', 'liquid'] },
  { id: 'tii', names: ['tiiuae'] },
  { id: 'ai2', names: ['allenai', 'allen-ai', 'ai2'] },
  { id: 'baai', names: ['baai'] },
  { id: 'stepfun', names: ['stepfun-ai', 'stepfun'] },
  { id: 'xiaomimimo', names: ['xiaomimimo', 'xiaomi'] },
  { id: 'fishaudio', names: ['fishaudio', 'fish-audio'] },
  { id: 'bilibili', names: ['bilibili'] },
  { id: 'lg', names: ['lgai', 'lgai-exaone'] },
  { id: 'comfyui', names: ['comfy-org', 'comfyanonymous'] },
  { id: 'hunyuan', names: ['tencent'] },
  { id: 'kling', names: ['klingai', 'kuaishou'] },
];

const PROVIDER_RULES = compile([
  { id: 'opencode', keywords: ['opencode'] },
  { id: 'openrouter', keywords: ['openrouter'] },
  { id: 'githubcopilot', keywords: ['github.?copilot', 'copilot'] },
  { id: 'groq', keywords: ['groq'] },
  { id: 'cerebras', keywords: ['cerebras'] },
  { id: 'github', keywords: ['github'] },
  { id: 'gemini', keywords: ['gemini', 'generativelanguage\\.googleapis'] },
  { id: 'nvidia', keywords: ['nvidia'] },
  { id: 'minimax', keywords: ['minimax'] },
  { id: 'huggingface', keywords: ['huggingface', 'hf\\.co'] },
  { id: 'ollama', keywords: ['ollama'] },
  { id: 'comfyui', keywords: ['comfy'] },
  { id: 'together', keywords: ['together'] },
  { id: 'fireworks', keywords: ['fireworks'] },
  { id: 'grok', keywords: ['grok'] },
  { id: 'xai', keywords: ['x\\.ai', '\\bxai\\b'] },
  { id: 'deepseek', keywords: ['deepseek'] },
  { id: 'anthropic', keywords: ['anthropic', 'claude'] },
  { id: 'azure', keywords: ['azure'] },
  { id: 'bedrock', keywords: ['bedrock'] },
  { id: 'openai', keywords: ['openai', 'chatgpt'] },
  { id: 'mistral', keywords: ['mistral'] },
  { id: 'cohere', keywords: ['cohere'] },
  { id: 'qwen', keywords: ['qwen', 'dashscope', 'alibaba'] },
  { id: 'moonshot', keywords: ['moonshot', '\\bkimi\\b'] },
  { id: 'zai', keywords: ['\\bzai\\b', 'zhipu', 'bigmodel', 'chatglm'] },
  { id: 'perplexity', keywords: ['perplexity'] },
  { id: 'meta', keywords: ['\\bmeta\\b'] },
  { id: 'google', keywords: ['google', 'vertex'] },
  { id: 'microsoft', keywords: ['microsoft'] },
  { id: 'sambanova', keywords: ['sambanova'] },
  { id: 'deepinfra', keywords: ['deepinfra'] },
  { id: 'replicate', keywords: ['replicate'] },
  { id: 'fal', keywords: ['\\bfal\\b', 'fal\\.ai'] },
  { id: 'lmstudio', keywords: ['lm\\s?studio'] },
  { id: 'vllm', keywords: ['vllm'] },
  { id: 'cloudflare', keywords: ['cloudflare', 'workers\\.ai'] },
  { id: 'stepfun', keywords: ['stepfun'] },
  { id: 'baichuan', keywords: ['baichuan'] },
  { id: 'zeroone', keywords: ['01\\.ai', 'zeroone', 'lingyi'] },
  { id: 'internlm', keywords: ['internlm'] },
  { id: 'bytedance', keywords: ['bytedance', 'volcengine', 'doubao'] },
  { id: 'stability', keywords: ['stability'] },
  { id: 'flux', keywords: ['black-forest', '\\bflux\\b', '\\bbfl\\b'] },
]);

function ownerMark(owner) {
  const key = String(owner ?? '').trim().toLowerCase();
  if (!key) return null;
  for (const row of OWNERS) {
    if (row.names.some((name) => key === name)) return mark(row.id);
  }
  return null;
}

/** Logo for a model id (local repo id, remote catalog id, or `r12:model`). */
export function logoForModel(id) {
  const text = String(id ?? '').replace(/^r\d+:/, '');
  const hit = match(text, MODEL_RULES);
  if (hit) return hit;
  const owner = text.includes('/') ? text.slice(0, text.indexOf('/')) : '';
  return ownerMark(owner);
}

/** Logo for a provider key, display name, or base URL. */
export function logoForProvider(...parts) {
  return match(parts.filter(Boolean).join(' '), PROVIDER_RULES);
}

/** Hub avatar: family mark for this repo, otherwise null (HF avatar fallback). */
export function resolveHubLogo(owner, repoName) {
  const full = [owner, repoName].filter(Boolean).join('/');
  return logoForModel(full);
}

export function cardGlow(id) {
  const s = String(id ?? '').toLowerCase();
  if (s.includes('gemma') || s.includes('google')) return 'rgba(62, 125, 255, 0.45)';
  if (s.includes('qwen') || s.includes('qwq')) return 'rgba(150, 92, 255, 0.45)';
  if (s.includes('llama') || s.includes('meta') || s.includes('muse')) return 'rgba(20, 184, 166, 0.42)';
  if (s.includes('mistral') || s.includes('mixtral') || s.includes('ministral')) return 'rgba(255, 138, 64, 0.42)';
  if (s.includes('deepseek')) return 'rgba(104, 96, 255, 0.45)';
  if (s.includes('phi')) return 'rgba(34, 176, 224, 0.42)';
  if (s.includes('glm') || s.includes('zai')) return 'rgba(62, 125, 255, 0.4)';
  if (s.includes('kimi') || s.includes('moonshot')) return 'rgba(20, 184, 166, 0.4)';
  if (s.includes('unsloth') || s.includes('lfm') || s.includes('liquid')) return 'rgba(0, 198, 150, 0.42)';
  return 'rgba(200, 153, 104, 0.28)';
}
