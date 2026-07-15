// Voxtral TTS engine — the ONLY speech backend. Two interchangeable modes:
//   mistral  — Mistral's hosted API (api.mistral.ai), the same Voxtral model,
//              needs an API key (owner pastes it in the Speech page).
//   local    — any vLLM-Omni server speaking POST /v1/audio/speech
//              (speech_local_url setting). The Containerfile for a local
//              CPU attempt lives in speech-bridge/voxtral/, but vllm-omni
//              has no CPU platform as of 0.24 — local stays dormant until
//              upstream grows one or the GPU frees up.
// Piper and OmniVoice are gone; read-aloud and the Speech studio both land here.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = process.env.TTS_CACHE_DIR ?? join(ROOT, 'data', 'tts-cache');
mkdirSync(CACHE_DIR, { recursive: true });

const MISTRAL_BASE = 'https://api.mistral.ai/v1';
export const MAX_TTS_CHARS = 4000;
export const DEFAULT_VOICE = 'en_paul_neutral';

// ---- configuration ----
export function speechConfig() {
  const apiKey = getSetting('speech_api_key');
  const localUrl = getSetting('speech_local_url');
  const model = getSetting('speech_model') ?? 'voxtral-mini-tts-2603';
  const mode = localUrl ? 'local' : apiKey ? 'mistral' : 'off';
  return { apiKey, localUrl, model, mode };
}

export function saveSpeechSettings({ api_key, local_url, model }) {
  if (api_key !== undefined) setSetting('speech_api_key', String(api_key ?? '').trim() || null);
  if (local_url !== undefined) setSetting('speech_local_url', String(local_url ?? '').trim().replace(/\/+$/, '') || null);
  if (model !== undefined) setSetting('speech_model', String(model ?? '').trim() || null);
}

// ---- preset catalog (Mistral library voices; ids match the console) ----
export const EMOTIONS = {
  neutral: 'Calm, even, neutral',
  sad: 'Low, hollow, sad',
  happy: 'Sunny, easygoing, happy',
  excited: 'Energetic, crisp, excited',
  curious: 'Thoughtful, engaged, curious',
  confident: 'Firm, decisive, confident',
  cheerful: 'Bright, lively, cheerful',
  frustrated: 'Edgy, snappy, frustrated',
  angry: 'Intense, forceful, angry',
};

export const PRESET_VOICES = [
  { id: 'en_paul', name: 'Paul', language: 'English (US)', gender: 'male',
    emotions: ['neutral', 'sad', 'happy', 'frustrated', 'excited', 'confident', 'cheerful', 'angry'] },
  { id: 'gb_oliver', name: 'Oliver', language: 'English (UK)', gender: 'male',
    emotions: ['neutral', 'sad', 'excited', 'curious', 'confident', 'cheerful', 'angry'] },
  { id: 'gb_jane', name: 'Jane', language: 'English (UK)', gender: 'female',
    emotions: ['neutral', 'sad', 'excited', 'curious', 'confident', 'cheerful', 'angry'] },
  { id: 'fr_marie', name: 'Marie', language: 'French', gender: 'female',
    emotions: ['neutral'] },
];

// Local vLLM-Omni reference voices shipped with the open weights (voice_embedding/*.pt).
export const LOCAL_VOICES = [
  ['casual_male', 'Casual Male', 'English', 'male'], ['casual_female', 'Casual Female', 'English', 'female'],
  ['neutral_male', 'Neutral Male', 'English', 'male'], ['neutral_female', 'Neutral Female', 'English', 'female'],
  ['cheerful_female', 'Cheerful Female', 'English', 'female'],
  ['fr_male', 'French Male', 'French', 'male'], ['fr_female', 'French Female', 'French', 'female'],
  ['es_male', 'Spanish Male', 'Spanish', 'male'], ['es_female', 'Spanish Female', 'Spanish', 'female'],
  ['de_male', 'German Male', 'German', 'male'], ['de_female', 'German Female', 'German', 'female'],
  ['it_male', 'Italian Male', 'Italian', 'male'], ['it_female', 'Italian Female', 'Italian', 'female'],
  ['pt_male', 'Portuguese Male', 'Portuguese', 'male'], ['pt_female', 'Portuguese Female', 'Portuguese', 'female'],
  ['nl_male', 'Dutch Male', 'Dutch', 'male'], ['nl_female', 'Dutch Female', 'Dutch', 'female'],
  ['ar_male', 'Arabic Male', 'Arabic', 'male'],
  ['hi_male', 'Hindi Male', 'Hindi', 'male'], ['hi_female', 'Hindi Female', 'Hindi', 'female'],
].map(([id, name, language, gender]) => ({ id, name, language, gender, emotions: [] }));

export function presetVoices() {
  return speechConfig().mode === 'local' ? LOCAL_VOICES : PRESET_VOICES;
}

// ---- Mistral API helpers ----
async function mistral(path, { method = 'GET', body, timeoutMs = 120_000 } = {}) {
  const { apiKey } = speechConfig();
  if (!apiKey) throw Object.assign(new Error('no API key configured'), { status: 503 });
  const res = await fetch(MISTRAL_BASE + path, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.message
      ?? (res.status === 401 ? 'API key rejected' : res.status === 403 ? 'blocked by content moderation' : `Mistral API ${res.status}`);
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res;
}

// Custom (cloned) voices live on the Mistral account. Cached briefly so the
// voice picker doesn't hammer the API.
let voicesCache = { at: 0, list: [] };
export async function customVoices(force = false) {
  if (speechConfig().mode !== 'mistral') return [];
  if (!force && Date.now() - voicesCache.at < 300_000) return voicesCache.list;
  const data = await (await mistral('/audio/voices', { timeoutMs: 15_000 })).json();
  const raw = Array.isArray(data) ? data : data?.data ?? data?.voices ?? [];
  const list = raw.map((v) => ({
    id: v.id ?? v.voice_id, name: v.name ?? v.id,
    language: (v.languages ?? []).join(', ') || 'custom clone',
    gender: v.gender ?? null, emotions: [], custom: true,
  }));
  voicesCache = { at: Date.now(), list };
  return list;
}

export async function createVoice({ name, audioB64, filename }) {
  const res = await mistral('/audio/voices', {
    method: 'POST',
    body: { name, sample_audio: audioB64, sample_filename: filename ?? 'sample.wav' },
    timeoutMs: 60_000,
  });
  voicesCache.at = 0;
  return res.json();
}

export async function deleteVoice(id) {
  await mistral(`/audio/voices/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 15_000 });
  voicesCache.at = 0;
}

// ---- synthesis ----
// One render at a time: hosted calls are quick, but a future local CPU server
// would thrash under parallel renders, and honest queueing beats a pile-up.
let chain = Promise.resolve();

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg', pcm: 'application/octet-stream' };

export function speak({ text, voiceId, refAudioB64, format = 'mp3' }) {
  const cfg = speechConfig();
  const input = String(text ?? '').slice(0, MAX_TTS_CHARS);
  if (!input.trim()) return Promise.resolve(null);
  const job = chain.then(async () => {
    if (cfg.mode === 'off') throw Object.assign(new Error('speech engine not configured'), { status: 503 });
    if (cfg.mode === 'local') {
      const res = await fetch(`${cfg.localUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input, model: 'voxtral-tts', voice: voiceId || undefined, response_format: format }),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw Object.assign(new Error(`local voxtral ${res.status}`), { status: 502 });
      return { buf: Buffer.from(await res.arrayBuffer()), mime: MIME[format] ?? 'audio/mpeg', ext: format };
    }
    const res = await mistral('/audio/speech', {
      method: 'POST',
      body: {
        input, model: cfg.model, response_format: format,
        ...(refAudioB64 ? { ref_audio: refAudioB64 } : { voice_id: voiceId || DEFAULT_VOICE }),
      },
    });
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      const data = await res.json();
      return { buf: Buffer.from(data.audio_data, 'base64'), mime: MIME[format] ?? 'audio/mpeg', ext: format };
    }
    return { buf: Buffer.from(await res.arrayBuffer()), mime: MIME[format] ?? 'audio/mpeg', ext: format };
  });
  chain = job.catch(() => {});
  return job;
}

// ---- read-aloud: markdown → speakable text, disk-cached by content ----
export function stripForSpeech(md) {
  let t = String(md ?? '');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' … ');            // fenced code + duckwidget blocks
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');             // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');          // links → label
  t = t.replace(/\[\^?\d+\]/g, '');                       // citation markers
  t = t.replace(/`([^`]*)`/g, '$1');                      // inline code → bare text
  t = t.replace(/^#{1,6}\s+/gm, '');                      // headings
  t = t.replace(/^\s*[-*+]\s+/gm, '');                    // bullets
  t = t.replace(/^\s*\|.*\|\s*$/gm, '');                  // table rows
  t = t.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');  // bold/italic/strike
  t = t.replace(/^[-=_]{3,}\s*$/gm, '');                  // hrules
  t = t.replace(/\n{2,}/g, '\n').replace(/[ \t]+/g, ' ');
  return t.trim();
}

export async function synthReadAloud(text, voiceId) {
  const clean = stripForSpeech(text).slice(0, MAX_TTS_CHARS);
  if (!clean) return null;
  const voice = voiceId || DEFAULT_VOICE;
  const hash = createHash('sha256').update(voice + '\0' + clean).digest('hex').slice(0, 32);
  const file = join(CACHE_DIR, `${hash}.mp3`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return { buf: cached, mime: 'audio/mpeg' };
  const out = await speak({ text: clean, voiceId: voice, format: 'mp3' });
  if (out) await writeFile(file, out.buf).catch(() => {});
  return out;
}

// Short cached per-voice sample for the picker play buttons.
const PREVIEW_LINES = {
  neutral: 'Hi there — this is how I sound.',
  sad: 'Hi there… this is how I sound.',
  happy: 'Hi there! This is how I sound!',
  excited: 'Hi there! This is how I sound!',
  curious: 'Hi there — is this how I sound?',
  confident: 'Hi there. This is how I sound.',
  cheerful: 'Hi there! This is how I sound!',
  frustrated: 'Hi there. This is how I sound, okay?',
  angry: 'Hi there. This is how I sound!',
};

export async function previewVoice(voiceId) {
  const emotion = Object.keys(PREVIEW_LINES).find((e) => voiceId.endsWith(`_${e}`)) ?? 'neutral';
  const file = join(CACHE_DIR, `preview-${voiceId.replace(/[^\w-]/g, '')}.mp3`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return { buf: cached, mime: 'audio/mpeg' };
  const out = await speak({ text: PREVIEW_LINES[emotion], voiceId, format: 'mp3' });
  if (out) await writeFile(file, out.buf).catch(() => {});
  return out;
}

export async function speechStatus() {
  const cfg = speechConfig();
  if (cfg.mode === 'off') return { ok: false, mode: 'off', error: 'not configured' };
  if (cfg.mode === 'local') {
    try {
      const res = await fetch(`${cfg.localUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return { ok: res.ok, mode: 'local', model: 'voxtral-tts (local)' };
    } catch { return { ok: false, mode: 'local', error: 'local server not responding' }; }
  }
  return { ok: true, mode: 'mistral', model: cfg.model };
}
