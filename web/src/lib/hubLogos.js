// Provider-logo registry copied from Unsloth Studio's hub (AGPL-3.0).
// Unsloth re-uploads (unsloth/Qwen3-…) keep the username "unsloth" but we
// show the upstream family's mark so the list isn't 40 identical sloths.

const LOGOS = [
  {
    id: 'nvidia',
    path: '/hub/logo/nvidia.svg',
    bg: 'white',
    prefixes: [
      'Llama-3.1-Nemotron-', 'Llama-3.3-Nemotron-', 'Llama-3.1-Minitron-',
      'NVIDIA-Nemotron-', 'Nemotron-3-', 'Nemotron-4-', 'Nemotron-H-',
      'Minitron-', 'Mistral-NeMo-', 'OpenReasoning-Nemotron-',
      'OpenCodeReasoning', 'Cosmos-',
    ],
  },
  {
    id: 'deepseek',
    path: '/hub/logo/deepseek.svg',
    bg: 'white',
    prefixes: ['DeepSeek-R1-Distill-', 'DeepSeek-', 'deepseek-', 'deepseek-llm-', 'deepseek-coder-'],
  },
  {
    id: 'microsoft',
    path: '/hub/logo/microsoft.svg',
    bg: 'white',
    prefixes: ['MAI-DS-R1', 'NextCoder-', 'Phi-3-', 'Phi-3.5-', 'Phi-4', 'phi-1', 'phi-2', 'phi-'],
  },
  {
    id: 'qwen',
    path: '/hub/logo/qwen.png',
    bg: 'white',
    prefixes: ['Qwen', 'QwQ-', 'QVQ-'],
  },
  {
    id: 'moonshot',
    path: '/hub/logo/moonshot.jpg',
    bg: 'transparent',
    fit: 'cover',
    prefixes: ['Kimi-', 'Moonlight-'],
  },
  {
    id: 'zai',
    path: '/hub/logo/zai.svg',
    bg: 'transparent',
    fit: 'cover',
    prefixes: ['GLM-', 'glm-', 'chatglm', 'codegeex'],
  },
  {
    id: 'xai',
    path: '/hub/logo/xai.svg',
    bg: 'white',
    prefixes: ['grok-'],
  },
  {
    id: 'minimax',
    path: '/hub/logo/minimax-color.png',
    bg: 'white',
    prefixes: ['MiniMax-'],
  },
  {
    id: 'hf',
    path: '/hub/logo/hf.svg',
    bg: 'white',
    prefixes: ['SmolLM'],
  },
  {
    id: 'ibm',
    path: '/hub/logo/ibm.png',
    bg: 'transparent',
    fit: 'cover',
    prefixes: ['granite-', 'granitelib-'],
  },
  {
    id: 'cohere',
    path: '/hub/logo/cohere.png',
    bg: 'white',
    prefixes: ['c4ai-command', 'aya-'],
  },
  {
    id: 'openai',
    path: '/hub/logo/openai.svg',
    bg: 'transparent',
    prefixes: ['gpt-oss-'],
  },
  {
    id: 'google',
    path: '/hub/logo/google.png',
    bg: 'white',
    prefixes: [
      'gemma-', 'codegemma-', 'recurrentgemma-', 'shieldgemma-', 'medgemma-',
      'functiongemma-', 'translategemma-', 'embeddinggemma-', 'paligemma-',
    ],
    stems: ['gemma'],
  },
  {
    id: 'mistral',
    path: '/hub/logo/mistral.svg',
    bg: 'white',
    prefixes: ['Mistral-', 'Mixtral-', 'Codestral-', 'Pixtral-', 'Devstral-', 'Ministral-', 'Voxtral-', 'Magistral-'],
  },
  {
    id: 'meta',
    path: '/hub/logo/meta.svg',
    bg: 'white',
    prefixes: ['Meta-Llama-', 'Llama-Guard-', 'LlamaGuard-', 'CodeLlama-', 'Llama-', 'llama-', 'meta-', 'Muse-Glimmer'],
    owners: ['meta-models', 'meta-llama', 'facebook'],
  },
];

function matchByRepo(repoName) {
  if (!repoName) return null;
  for (const p of LOGOS) {
    if (p.prefixes.some((pre) => repoName.startsWith(pre))) return p;
  }
  const lower = repoName.toLowerCase();
  for (const p of LOGOS) {
    if (p.stems?.some((stem) => {
      const at = lower.indexOf(stem);
      if (at < 0) return false;
      const next = lower[at + stem.length];
      return next === undefined || next < 'a' || next > 'z';
    })) return p;
  }
  return null;
}

function matchByOwner(owner) {
  const needle = owner?.trim().toLowerCase();
  if (!needle) return null;
  for (const p of LOGOS) {
    if (p.owners?.some((org) => org.toLowerCase() === needle)) return p;
  }
  return null;
}

/** Logo to render instead of the owner's HF avatar, or null. */
export function resolveHubLogo(owner, repoName) {
  return matchByOwner(owner) ?? (owner?.toLowerCase() === 'unsloth' ? matchByRepo(repoName) : null);
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
  if (s.includes('unsloth') || s.includes('lfm')) return 'rgba(0, 198, 150, 0.42)';
  return 'rgba(200, 153, 104, 0.28)';
}
