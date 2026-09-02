import { isDiffusionModel } from './diffusiongen.js';

// Shared model classifier — used by the LLM picker (routes/models.js, to
// hide non-chat models from chat) and the Hub (hfHub.js/HubPanel.svelte, to
// filter/badge search results). One classifier, one set of edge cases.
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
// known chat-capable pipelines — anything else with a tag is not a chat LLM
// (fill-mask, token-classification, object-detection, robotics, …)
const CHAT_TAG_RE = /^(text-generation|text2text-generation|conversational|image-text-to-text|visual-document-question-answering|question-answering|any-to-any)/;
const IMAGE_RE = /diffusion|llada|(^|[-_.])dream|dllm|flux|sdxl|sd3|sd-?xl|stable-?diffusion|pixart|playground-?v|auraflow|lumina|kolors|cogview|hunyuan-?dit|dreamshaper|chroma|z-?image/i;
const VIDEO_RE = /wan[-_.]?2|hunyuan-?video|cogvideox|ltx-?v(ideo)?|mochi|allegro|pyramid-?flow|open-?sora|genmo/i;
const EMBED_RE = /embed|bge|gte-|e5-|minilm|nomic|snowflake|jina|sentence-?transform|rerank|arctic-?embed/i;
const AUDIO_RE = /whisper|piper|kokoro|(^|[-_.])bark|vits|parler|wav2vec|silero|vosk|clap|tts/i;
// tags that exist on HF but aren't in either known set above (mixed
// image+video pipelines etc.) — a video-output pipeline with image
// conditioning, not a reason to hide a GGUF text model from the chat filter
const IMAGE_VIDEO_MIX_TAG_RE = /image.*video|video.*image/;

export function modelKind(id, pipelineTag) {
  const tag = String(pipelineTag ?? '').trim().toLowerCase();
  if (tag) {
    if (IMAGE_TAG.has(tag)) return 'image';
    if (VIDEO_TAG.has(tag)) return 'video';
    if (EMBED_TAG.has(tag)) return 'embed';
    if (AUDIO_TAG.has(tag)) return 'audio';
    if (CHAT_TAG_RE.test(tag)) return 'chat';
    if (IMAGE_VIDEO_MIX_TAG_RE.test(tag)) return 'video';
    return 'other';
  }
  const s = String(id ?? '');
  if (VIDEO_RE.test(s)) return 'video';
  if (isDiffusionModel(s) || IMAGE_RE.test(s)) return 'image';
  if (EMBED_RE.test(s)) return 'embed';
  if (AUDIO_RE.test(s)) return 'audio';
  return 'chat';
}
