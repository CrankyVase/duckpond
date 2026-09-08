// Shared model classifier — used by the LLM picker (routes/models.js, to
// hide non-chat models from chat), the Hub (hfHub.js/HubPanel.svelte, to
// filter/badge search results), and Media Studio (imagegen.js, to put a
// downloaded repo in Images / Video / Music / Voice).
//
// pipeline_tag is frequently missing on HF for GGUF-only repos (HF's
// auto-detection runs off config.json/safetensors introspection, which a
// GGUF-only repo often doesn't have) even when a safetensors sibling repo of
// the same model has it — so an empty tag must NOT mean "unknown/hide", it
// falls back to filename heuristics and defaults to chat, since the
// overwhelming majority of untagged GGUF repos are plain chat models.
const IMAGE_TAG = new Set([
  'text-to-image', 'image-to-image', 'unconditional-image-generation', 'inpainting',
]);
const VIDEO_TAG = new Set(['text-to-video', 'image-to-video']);
const EMBED_TAG = new Set(['feature-extraction', 'sentence-similarity']);
const AUDIO_TAG = new Set([
  'automatic-speech-recognition', 'text-to-speech', 'text-to-audio',
  'audio-to-audio', 'audio-classification',
]);
const SPEECH_TAG = new Set(['text-to-speech', 'automatic-speech-recognition']);
// known chat-capable pipelines — anything else with a tag is not a chat LLM
// (fill-mask, token-classification, object-detection, robotics, …)
const CHAT_TAG_RE = /^(text-generation|text2text-generation|conversational|image-text-to-text|visual-document-question-answering|question-answering|any-to-any)/;
const IMAGE_RE = /flux|sdxl|sd3|sd-?xl|stable-?diffusion|pixart|playground-?v|auraflow|lumina|kolors|cogview|hunyuan-?dit|hunyuanimage|dreamshaper|dreambooth|hidream|chroma|z-?image|krea|ideogram|qwen-?image/i;
const VIDEO_RE = /wan[-_.]?\d|hunyuan-?video|cogvideox|ltx(?:[-_]?v(?:ideo)?)?(?:[-_]|$)|ltx[-_]?2|mochi|allegro|pyramid-?flow|open-?sora|genmo/i;
const EMBED_RE = /embed|bge|gte-|e5-|minilm|nomic|snowflake|jina|sentence-?transform|rerank|arctic-?embed/i;
const SPEECH_RE = /omnivoice|openvoice|cosyvoice|higgs[-_]?tts|higgs[-_]?audio|moss[-_]?tts|(^|[-_.\/])tts($|[-_.\/])|text-to-speech|speecht5|(^|[-_.])bark|(^|[-_.])vits|piper|parler[-_]?tts|kokoro|xtts|chatterbox|styletts|fish[-_]?speech|f5[-_]?tts|index[-_]?tts|melo[-_]?tts|qwen3[-_]?tts|voice[-_]?clone|voicecraft/i;
const AUDIO_RE = /whisper|wav2vec|silero|vosk|clap|musicgen|stable-?audio|audioldm|minimax[-_]?music|riffusion|(^|[-_.\/])audio($|[-_.\/])/i;
// tags that exist on HF but aren't in either known set above (mixed
// image+video pipelines etc.) — a video-output pipeline with image
// conditioning, not a reason to hide a GGUF text model from the chat filter
const IMAGE_VIDEO_MIX_TAG_RE = /image.*video|video.*image/;

export function modelKind(id, pipelineTag) {
  const tag = String(pipelineTag ?? '').trim().toLowerCase();
  if (tag) {
    if (VIDEO_TAG.has(tag) || IMAGE_VIDEO_MIX_TAG_RE.test(tag)) return 'video';
    if (IMAGE_TAG.has(tag)) return 'image';
    if (AUDIO_TAG.has(tag)) return 'audio';
    if (EMBED_TAG.has(tag)) return 'embed';
    if (CHAT_TAG_RE.test(tag)) return 'chat';
    return 'other';
  }
  const s = String(id ?? '');
  // Speech/music/video before image. Do NOT reuse the chat-side diffusion-LLM
  // detector (LLaDA / Dream / dllm) — those are text models, and a bare
  // "dream" substring used to shove HiDream *and* Dream-7B into Images.
  if (VIDEO_RE.test(s)) return 'video';
  if (SPEECH_RE.test(s) || AUDIO_RE.test(s)) return 'audio';
  if (IMAGE_RE.test(s)) return 'image';
  if (EMBED_RE.test(s)) return 'embed';
  return 'chat';
}

// Media Studio tasks are finer than Hub kinds: audio splits into music
// (`audio`) vs speech (`tts`). A stale bridge that defaulted everything
// unknown to `image` is corrected from the repo id so Voice models do not
// keep showing up under Images.
export function mediaTask(id, declared, pipelineTag) {
  const tag = String(pipelineTag ?? '').trim().toLowerCase();
  const s = String(id ?? '');
  if (SPEECH_TAG.has(tag) || SPEECH_RE.test(s)) return 'tts';
  if (tag === 'text-to-audio' || AUDIO_RE.test(s)) return 'audio';
  if (VIDEO_TAG.has(tag) || IMAGE_VIDEO_MIX_TAG_RE.test(tag) || VIDEO_RE.test(s)) return 'video';
  if (IMAGE_TAG.has(tag) || IMAGE_RE.test(s)) return 'image';
  if (declared === 'tts' || declared === 'audio' || declared === 'video' || declared === 'image') return declared;
  return 'image';
}
