// Turns a GGUF model id (e.g. "qwen3-6-35b-a3b-uncensored-q4-k-m") into a plain-
// English blurb for people who don't know what "MoE" or "Q4_K_M" mean. Pure
// string heuristics — no GPU call, so it's instant for a settings-panel tooltip.

const FAMILIES = [
  // [match substring, display name, one-line house style]
  ['diffusiongemma', 'Gemma (diffusion)', 'generates text by denoising, like an image model — unusual, sometimes faster for structured output'],
  ['nemotron', 'Nemotron (NVIDIA)', 'tuned by NVIDIA; generally strong at following instructions and reasoning'],
  ['gemma', 'Gemma (Google)', 'Google\'s open model line; well-rounded, good at following instructions'],
  ['lfm2', 'LFM2 (Liquid AI)', 'a non-Transformer architecture built for speed on modest hardware'],
  ['qwen', 'Qwen (Alibaba)', 'a strong all-rounder for chat, coding, and general knowledge'],
  ['llama', 'Llama (Meta)', 'Meta\'s open model line; solid general-purpose chat'],
  ['gpt-oss', 'gpt-oss (OpenAI)', 'OpenAI\'s open-weights model; strong reasoning'],
  ['mistral', 'Mistral', 'fast and efficient for its size'],
  ['deepseek', 'DeepSeek', 'known for strong reasoning and coding ability'],
  ['phi', 'Phi (Microsoft)', 'a small model trained to punch above its size'],
];

function sizeTier(activeB) {
  if (activeB == null) return null;
  if (activeB <= 3) return { tier: 'tiny', speed: 'very fast', quality: 'best for quick, simple tasks' };
  if (activeB <= 8) return { tier: 'small', speed: 'fast', quality: 'a good everyday balance of speed and quality' };
  if (activeB <= 16) return { tier: 'medium', speed: 'moderate', quality: 'noticeably smarter, a bit slower' };
  if (activeB <= 40) return { tier: 'large', speed: 'slower', quality: 'strong reasoning and detail, costs more time per reply' };
  return { tier: 'huge', speed: 'slow', quality: 'the most capable option here, but the slowest' };
}

function quantBlurb(id) {
  const m = id.match(/\biq?(\d)(?:_|-)?k?/i);
  // look specifically for a qN / iqN token, not just any digit
  const qm = id.match(/(?:^|[-_])(i?q)(\d)(?:[-_]|$)/i);
  if (!qm) return null;
  const bits = Number(qm[2]);
  const dynamic = /\bud[-_]/i.test(id) || /unsloth/i.test(id);
  if (bits >= 8) return 'lightly compressed — very close to full quality';
  if (bits >= 5) return 'lightly compressed for a small quality trade-off';
  if (bits === 4) return `compressed to save memory${dynamic ? ' (dynamically, to protect the most important parts)' : ''} — a small, usually unnoticeable quality trade-off`;
  if (bits <= 3) return 'heavily compressed to save memory — smaller and faster, but more likely to make mistakes';
  return null;
}

// total[-active] params in billions parsed from the id, e.g. "35b-a3b" (MoE)
// or "12b" (dense). Exported for capability gating (the dashboard tool is only
// offered to models big enough to compose nested tool calls reliably).
export function modelParamsB(id) {
  const lower = String(id).toLowerCase();
  const moe = lower.match(/(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/);
  const dense = !moe && lower.match(/(?:^|[-_])(\d+(?:\.\d+)?)b(?:[-_]|$)/);
  const effective = !moe && !dense && lower.match(/\be(\d+(?:\.\d+)?)b\b/); // gemma "e2b" style
  const totalB = moe ? Number(moe[1]) : dense ? Number(dense[1]) : effective ? Number(effective[1]) : null;
  return { totalB, activeB: moe ? Number(moe[2]) : totalB, moe: !!moe };
}

export function describeModel(id, ctxSize) {
  const lower = String(id).toLowerCase();
  const family = FAMILIES.find(([key]) => lower.includes(key));

  const { totalB, activeB, moe } = modelParamsB(id);

  const traits = [];
  if (/reasoning|thinking/.test(lower)) traits.push('does visible step-by-step reasoning before answering');
  if (/coder|code/.test(lower)) traits.push('specialized for writing and understanding code');
  if (/omni|vision|vl\b/.test(lower)) traits.push('can also take images (and sometimes audio) as input');
  if (/nano|mini|small/.test(lower)) traits.push('built to be small and fast');
  if (/uncensored|abliterated|aggressive/.test(lower)) traits.push('a fine-tune with fewer built-in refusals — use with care');

  const tier = sizeTier(activeB);
  const quant = quantBlurb(lower);

  const sentences = [];
  if (family) sentences.push(`${family[1]} — ${family[2]}.`);
  if (totalB != null) {
    sentences.push(moe
      ? `A large ${totalB}B-parameter model, but only ~${activeB}B are active per response, so it runs closer to a ${activeB}B model's speed with more of a bigger model's knowledge.`
      : `Roughly ${totalB}B parameters${tier ? ` (${tier.tier} for a local model)` : ''}.`);
  }
  if (tier) sentences.push(`${tier.speed[0].toUpperCase()}${tier.speed.slice(1)} to respond — ${tier.quality}.`);
  if (quant) sentences.push(quant[0].toUpperCase() + quant.slice(1) + '.');
  if (traits.length) sentences.push(traits.map((t) => t[0].toUpperCase() + t.slice(1)).join('. ') + '.');
  if (ctxSize) {
    const pages = Math.max(1, Math.round((ctxSize * 0.75) / 250));
    sentences.push(`Remembers roughly the last ${pages.toLocaleString()} pages worth of this conversation before it starts forgetting the oldest parts.`);
  }

  return {
    blurb: sentences.join(' ') || 'A local language model. No further details could be inferred from its filename.',
    tags: [
      family?.[1], tier?.tier ? `${tier.tier} model` : null, moe ? 'mixture-of-experts' : null,
      /reasoning|thinking/.test(lower) ? 'reasoning' : null,
      /coder|code/.test(lower) ? 'coding' : null,
      /omni|vision|vl\b/.test(lower) ? 'vision' : null,
    ].filter(Boolean),
  };
}
