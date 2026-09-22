// Light-LLM prompt improver for Media Studio jobs. A small (~1B) local chat
// model rewrites the user's idea into the phrasing the selected media model
// actually rewards — natural-language scene paragraphs for FLUX/Qwen-image,
// motion+camera language for video, instrumentation/bpm vocabulary for music.
// Everything here is best-effort: if the router is down, no small model is
// found, or the rewrite times out, the job simply continues with the raw
// prompt. Never let the improver block or kill a generation.
import { listModels, loadModel, streamChat } from './llama.js';
import { listLocalModels } from './localInventory.js';

// explicit override > smallest loaded model > smallest model on disk
const ENV_MODEL = process.env.DUCKPOND_ENHANCE_MODEL ?? '';
const MAX_PARAMS_B = 2;       // "super light" — never autoload anything bigger
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 500;

const cache = { id: null, at: 0, ok: false };
const CACHE_MS = 10 * 60_000;

function bFromName(name) {
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return m ? Number(m[1]) : null;
}

function looksLikeChatModel(id) {
  const s = String(id).toLowerCase();
  if (/(embed|vision|mmproj|whisper|tts|vl-|reranker|music|flux|sdxl|image|video|diffusion|codertwo|coder)/.test(s)) return false;
  return /(qwen|llama|gemma|phi|smol|tiny|granite|olmo|minicpm|internlm|deepseek)/.test(s);
}

async function pickSmallestLoaded() {
  const models = await listModels();
  const usable = models.filter((m) => looksLikeChatModel(m.id));
  if (!usable.length) return null;
  const withB = usable.filter((m) => bFromName(m.id) != null);
  if (withB.length) return withB.sort((a, b) => bFromName(b.id) - bFromName(a.id)).pop().id;
  return usable[0].id; // all unknown size — first listed wins
}

async function pickSmallestOnDisk() {
  const { models } = listLocalModels();
  let best = null;
  let bestB = Infinity;
  for (const m of models) {
    if (!looksLikeChatModel(m.repoId ?? '')) continue;
    const b = bFromName(m.repoId ?? '') ?? bFromName(m.variants?.[0]?.name ?? '');
    if (b == null || b > MAX_PARAMS_B) continue;
    if (b < bestB) { bestB = b; best = m; }
  }
  if (!best) return null;
  const variant = best.variants?.[0];
  if (!variant?.include) return null;
  const id = variant.include; // router accepts full gguf paths for dynamic loads
  try { await loadModel(id); return id; }
  catch { return null; }
}

export async function enhancerModel() {
  if (ENV_MODEL) return ENV_MODEL;
  const now = Date.now();
  if (cache.id && now - cache.at < CACHE_MS) return cache.ok ? cache.id : null;
  cache.at = now;
  try {
    const loaded = await pickSmallestLoaded();
    if (loaded) { cache.id = loaded; cache.ok = true; return loaded; }
  } catch { /* router down — try disk */ }
  try {
    const onDisk = await pickSmallestOnDisk();
    if (onDisk) { cache.id = onDisk; cache.ok = true; return onDisk; }
  } catch { /* nothing loadable */ }
  cache.ok = false;
  return null;
}

const TASK_GUIDES = {
  image: `Rewrite the idea as ONE long English paragraph (120-220 words) in third-person observer register ("The image is a ...", never "Create/make"):
- Open with ONE ~20-word sentence: medium noun (mandatory: photograph / poster / illustration / logo / ...) + style + main subject + background/palette.
- Preserve user content verbatim: literal text strings character-for-character in straight "double quotes" in their original script; keep named objects, counts, colors, positions exactly.
- Walk the frame positionally: background first after the opener, then top band → left/center/right → bottom band (or subject-centric for single-subject). Use ~6-10 positional phrases (upper-left, across the lower third, behind..., in the foreground...). Hit corners/edges/center.
- Name every legible string in reading order with location/weight/color/case. Distant/unreadable text → say it's blurred/too small to read, never invent letters.
- Include exactly ONE dedicated lighting sentence (source, direction, quality, shadow behavior).
- Close with exactly ONE summary sentence ("The overall composition / mood / palette ...").
- Hard bans: no quality boosters ("4K", "8K", "masterpiece", "highly detailed", "sharp", "award-winning"), no job-instructions ("you should", "make sure"), no negative phrasing ("without", "no X") — describe what IS there, no resolution/ratio words inside the description.`,
  video: `Rewrite the idea as ONE paragraph (under 80 words) a text-to-video model rewards:
- Open with the subject and scene, then how things MOVE across the clip.
- Describe camera behavior (slow push-in, pan, handheld…), pacing, and how light/atmosphere evolve.
- One continuous shot — no cuts, no scene changes.
- Keep every concrete thing the user asked for; add motion and mood detail only.`,
  audio: `Rewrite the idea as ONE paragraph (under 80 words) a music generation model rewards:
- Genre first, then instruments, tempo (bpm), mood, production feel (lo-fi, lush, sparse…), era/scene.
- If the user named instruments or a vibe, keep them exactly and enrich around them.
- Describe the music, not the lyrics — the user's lyrics are separate.
- No meta text, no song title, no artist names.`,
};

const FAMILY_HINTS = [
  [/qwen[-_]?image/i, 'Qwen-Image-2.1: one flowing English paragraph, 120-220 words, third-person "The image is a ..." register; medium+style+subject opener; positional frame walk; one lighting sentence; one closing summary; quoted literal text preserved verbatim; no boosters, no negations, no ratio words.'],
  [/flux/i, 'FLUX: natural full sentences, rich descriptive prose; avoid keyword soup and avoid negations.'],
  [/music3|minimax[-_]?music/i, 'MiniMax Music: describe vocals (gender, texture, language) plus arrangement; keep it singable-style guidance.'],
  [/minimax[-_]?h3|h3/i, 'MiniMax H3 video: describe the scene, motion, and the ambient audio (sounds, ambience) — it generates sound too.'],
];

function guideFor(task, modelId) {
  const family = FAMILY_HINTS.find(([re]) => re.test(String(modelId ?? '')))?.[1] ?? '';
  return [TASK_GUIDES[task] ?? TASK_GUIDES.image, family].filter(Boolean).join('\n');
}

function cleanRewrite(raw, prompt, maxChars = 900) {
  let text = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```[\w-]*\s*|```\s*$/g, '')
    .replace(/^\s*(here'?s? (is |your )?(the )?(rewritten|improved|enhanced) prompt:?|improved prompt:?|prompt:)\s*/i, '')
    .trim();
  if (!text || text.length < 8) return null;
  // If the model rambled into multiple paragraphs, keep the first coherent one.
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length > 1 && paras[0].length > 30) text = paras[0];
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length < 8 || text.length > 4 * prompt.length + 300 || text.length > maxChars) return null;
  // A rewrite that just echoes the input adds nothing — skip it.
  if (text.toLowerCase() === prompt.trim().toLowerCase()) return null;
  return text;
}

/**
 * @returns {Promise<{text: string, model: string} | null> — null = keep raw prompt
 */
export async function enhanceMediaPrompt({ prompt, task = 'image', modelId = '' }) {
  const raw = String(prompt ?? '').trim();
  if (!raw) return null;
  const model = await enhancerModel();
  if (!model) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const { content } = await streamChat({
      model,
      messages: [
        { role: 'system', content: 'You rewrite short creative ideas into optimal generation prompts. You reply with the rewritten prompt ONLY — no preamble, no quotes, no explanation, no options.' },
        { role: 'user', content: `${guideFor(task, modelId)}\n\nRewrite this ${task} idea:\n"""${raw.slice(0, 1200)}"""` },
      ],
      params: {
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: false },
      },
      abortSignal: abort.signal,
    });
    const text = cleanRewrite(content, raw, task === 'image' ? 1600 : 900);
    return text ? { text, model } : null;
  } catch {
    return null; // router down / timeout / template hiccup — job continues raw
  } finally {
    clearTimeout(timer);
  }
}
