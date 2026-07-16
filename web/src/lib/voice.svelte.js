// Live voice conversation engine: mic → VAD → whisper → chat → piper → speakers.
//
// The full-duplex loop lives here; Chat.svelte only binds two hooks
// (onUtterance → send the text through the normal chat pipeline, onBargeIn →
// abort the in-flight stream) and feeds streamed reply text back in via
// voiceFeedDelta/voiceFeedDone. Everything else — capture, turn-taking,
// sentence-chunked TTS with prefetch, barge-in, level metering for the orb —
// is self-contained.
//
// Two audio contexts on purpose: capture runs at 16 kHz (what whisper wants),
// playback at the device's native rate (piper WAVs are 22.05 kHz and
// decodeAudioData resamples cleanly upward, not down).

import { stopSpeech } from './tts.svelte.js';

export const voice = $state({
  open: false,          // voice mode active (orb visible)
  state: 'idle',        // idle | listening | thinking | speaking
  userLevel: 0,         // live mic amplitude 0..1 (orb: user side)
  aiLevel: 0,           // live TTS amplitude 0..1 (orb: duck side)
  heard: '',            // last transcript sent to the model
  error: null,
  sttOk: null,          // /api/voice/status probe result
  muted: false,
});

// ---- tunables ----
const CHUNK = 1024;                 // samples per VAD chunk (64 ms @ 16 kHz)
const PREROLL_CHUNKS = 6;           // ~380 ms kept from before speech onset
const START_CHUNKS = 2;             // ~130 ms of speech to open an utterance
const BARGE_CHUNKS = 5;             // ~320 ms of sustained speech to interrupt
const END_SILENCE_CHUNKS = 14;      // ~900 ms of silence closes the utterance
const MIN_SPEECH_CHUNKS = 5;        // utterances with less speech are noise
const MAX_UTTER_CHUNKS = 940;       // hard cap ~60 s
const ABS_FLOOR = 0.012;            // absolute minimum speech threshold (RMS)

let hooks = { onUtterance: null, onBargeIn: null };
export function bindVoice(h) { hooks = { ...hooks, ...h }; }

// ---- capture side ----
let media = null;      // MediaStream
let capCtx = null;     // 16 kHz AudioContext
let workletNode = null;
let noiseFloor = 0.01;
let speechRun = 0;
let silenceRun = 0;
let capturing = false;
let preroll = [];
let utter = [];        // Float32Array chunks of the current utterance
let speechChunks = 0;
let genCounter = 0;    // bumps on stop() so stale async work knows to die

// Worklet source as a blob module: batches the 128-frame render quanta into
// CHUNK-sized Float32 buffers and posts them to the main thread.
const WORKLET_SRC = `
class DpCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, ${CHUNK} - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take; i += take;
      if (this.n === ${CHUNK}) {
        this.port.postMessage(this.buf.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('dp-capture', DpCapture);`;

const rmsOf = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
};

function onChunk(chunk) {
  if (!voice.open || voice.muted) { voice.userLevel = 0; return; }
  const rms = rmsOf(chunk);

  // adaptive noise floor: sink fast onto quiet, drift up very slowly
  noiseFloor = rms < noiseFloor ? rms : Math.min(noiseFloor * 1.004, 0.05);
  const threshold = Math.max(noiseFloor * 3.5, ABS_FLOOR);
  const isSpeech = rms > (voice.state === 'speaking' ? Math.max(threshold * 2, 0.03) : threshold);

  // orb: user side reacts whenever the user is audible, in any state
  const lvl = Math.min(1, rms * 14);
  voice.userLevel = lvl > voice.userLevel ? lvl : voice.userLevel * 0.72;

  if (capturing) {
    utter.push(chunk);
    if (isSpeech) { silenceRun = 0; speechChunks++; } else silenceRun++;
    if (silenceRun >= END_SILENCE_CHUNKS || utter.length >= MAX_UTTER_CHUNKS) endUtterance();
    return;
  }

  preroll.push(chunk);
  if (preroll.length > PREROLL_CHUNKS) preroll.shift();

  if (!isSpeech) { speechRun = 0; return; }
  speechRun++;

  if (voice.state === 'listening' && speechRun >= START_CHUNKS) {
    capturing = true;
    utter = [...preroll];
    speechChunks = speechRun;
    silenceRun = 0;
  } else if (voice.state === 'speaking' && speechRun >= BARGE_CHUNKS) {
    // barge-in: kill playback + the in-flight stream, keep listening —
    // the pre-roll means the first words of the interruption aren't lost
    bargeIn();
    capturing = true;
    utter = [...preroll];
    speechChunks = speechRun;
    silenceRun = 0;
  }
}

async function endUtterance() {
  const chunks = utter;
  const hadSpeech = speechChunks;
  capturing = false;
  utter = [];
  speechRun = 0;
  silenceRun = 0;
  speechChunks = 0;

  if (hadSpeech < MIN_SPEECH_CHUNKS) return; // a cough, not a turn

  const gen = genCounter;
  voice.state = 'thinking';
  try {
    const wav = encodeWav(chunks, capCtx?.sampleRate ?? 16000);
    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
    });
    if (gen !== genCounter) return;
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `transcribe ${res.status}`);
    }
    const { text } = await res.json();
    if (gen !== genCounter) return;
    if (!text?.trim()) { voice.state = 'listening'; return; }
    voice.heard = text.trim();
    hooks.onUtterance?.(voice.heard);   // → Chat sends it through the normal pipeline
  } catch (err) {
    if (gen !== genCounter) return;
    voice.error = String(err.message ?? err);
    voice.state = 'listening';
  }
}

// chunks (Float32 @ srcRate) → 16 kHz mono 16-bit PCM WAV
function encodeWav(chunks, srcRate) {
  let all = new Float32Array(chunks.length * CHUNK);
  for (let i = 0; i < chunks.length; i++) all.set(chunks[i], i * CHUNK);
  if (srcRate !== 16000) { // browser ignored the 16 kHz hint → linear resample
    const ratio = srcRate / 16000;
    const out = new Float32Array(Math.floor(all.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio, lo = Math.floor(p), hi = Math.min(lo + 1, all.length - 1);
      out[i] = all[lo] + (all[hi] - all[lo]) * (p - lo);
    }
    all = out;
  }
  const buf = new ArrayBuffer(44 + all.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + all.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, all.length * 2, true);
  for (let i = 0; i < all.length; i++) {
    const s = Math.max(-1, Math.min(1, all[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ---- speaking side ----
let playCtx = null;    // native-rate AudioContext for TTS playback
let analyser = null;
let gainNode = null;
let sentBuf = '';      // streamed reply text not yet split into sentences
let fenceOpen = false; // inside a ``` block — never split there
let ttsQueue = [];     // sentences waiting for synthesis
let playQueue = [];    // decoded AudioBuffers waiting to play
let curSource = null;
let fetching = false;
let playing = false;
let streamEnded = true;
let levelRaf = 0;

function ensurePlayCtx() {
  if (!playCtx) {
    playCtx = new AudioContext();
    gainNode = playCtx.createGain();
    analyser = playCtx.createAnalyser();
    analyser.fftSize = 512;
    gainNode.connect(analyser);
    analyser.connect(playCtx.destination);
  }
  if (playCtx.state === 'suspended') playCtx.resume();
}

export function voiceFeedDelta(text) {
  if (!voice.open) return;
  streamEnded = false;
  sentBuf += text;
  // track fence parity so code blocks pass through whole (server strips them)
  const fences = (sentBuf.match(/```/g) ?? []).length;
  fenceOpen = fences % 2 === 1;
  if (fenceOpen) return;
  // peel off complete sentences, keep the tail
  let m;
  const re = /[.!?…]["')\]]*(?:\s+|$)/g;
  let cut = 0;
  while ((m = re.exec(sentBuf))) {
    const end = m.index + m[0].length;
    if (end - cut >= 30 || /\n/.test(m[0]) || end === sentBuf.length) {
      const s = sentBuf.slice(cut, end).trim();
      if (s) speakSentence(s);
      cut = end;
    }
  }
  // also split on paragraph breaks (headings, list items rarely end in .!?)
  const rest = sentBuf.slice(cut);
  const para = rest.lastIndexOf('\n\n');
  if (para > 0) {
    const s = rest.slice(0, para).trim();
    if (s) speakSentence(s);
    cut += para + 2;
  }
  sentBuf = sentBuf.slice(cut);
}

// a new inline-search round wipes the streamed text — drop the unspoken tail
// so the next round doesn't get glued onto it (already-queued audio stands)
export function voiceResetBuffer() { sentBuf = ''; }

export function voiceFeedDone() {
  if (!voice.open) return;
  streamEnded = true;
  const s = sentBuf.trim();
  sentBuf = '';
  if (s) speakSentence(s);
  maybeBackToListening();
}

function speakSentence(text) {
  ttsQueue.push(text);
  voice.state = 'speaking';
  pumpTts();
}

async function pumpTts() {
  if (fetching || !ttsQueue.length) return;
  fetching = true;
  const gen = genCounter;
  try {
    while (ttsQueue.length) {
      const text = ttsQueue.shift();
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (gen !== genCounter) return;
        if (!res.ok) continue; // unspeakable chunk (all code/syntax) — skip it
        const raw = await res.arrayBuffer();
        if (gen !== genCounter) return;
        ensurePlayCtx();
        const buf = await playCtx.decodeAudioData(raw);
        if (gen !== genCounter) return;
        playQueue.push(buf);
        pumpPlay();
      } catch { /* one bad sentence never stalls the rest */ }
    }
  } finally {
    if (gen === genCounter) fetching = false;
  }
}

function pumpPlay() {
  if (playing || !playQueue.length) return;
  const buf = playQueue.shift();
  playing = true;
  voice.state = 'speaking';
  ensurePlayCtx();
  curSource = playCtx.createBufferSource();
  curSource.buffer = buf;
  curSource.connect(gainNode);
  curSource.onended = () => {
    playing = false;
    curSource = null;
    if (playQueue.length) pumpPlay();
    else maybeBackToListening();
  };
  curSource.start();
  meterLoop();
}

function maybeBackToListening() {
  if (!voice.open) return;
  if (!playing && !playQueue.length && !ttsQueue.length && streamEnded) {
    voice.aiLevel = 0;
    if (voice.state === 'speaking' || voice.state === 'thinking') voice.state = 'listening';
  }
}

function meterLoop() {
  if (levelRaf) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    levelRaf = 0;
    if (!playing || !analyser) { voice.aiLevel = 0; return; }
    analyser.getByteTimeDomainData(data);
    let s = 0;
    for (let i = 0; i < data.length; i++) { const d = (data[i] - 128) / 128; s += d * d; }
    const lvl = Math.min(1, Math.sqrt(s / data.length) * 3.2);
    voice.aiLevel = lvl > voice.aiLevel ? lvl : voice.aiLevel * 0.8;
    levelRaf = requestAnimationFrame(tick);
  };
  levelRaf = requestAnimationFrame(tick);
}

function stopPlayback() {
  ttsQueue = [];
  playQueue = [];
  sentBuf = '';
  if (curSource) { try { curSource.onended = null; curSource.stop(); } catch { /* already done */ } curSource = null; }
  playing = false;
  fetching = false;
  voice.aiLevel = 0;
  if (levelRaf) { cancelAnimationFrame(levelRaf); levelRaf = 0; }
}

function bargeIn() {
  stopPlayback();
  streamEnded = true;
  hooks.onBargeIn?.();       // Chat aborts the in-flight generation
  voice.state = 'listening';
}

// ---- lifecycle ----
export async function startVoice() {
  if (voice.open) return;
  voice.open = true;
  voice.error = null;
  voice.heard = '';
  voice.state = 'idle';
  genCounter++;
  stopSpeech(); // the per-message read-aloud button yields to voice mode

  try {
    const st = await fetch('/api/voice/status').then((r) => r.json());
    voice.sttOk = !!st.stt;
  } catch { voice.sttOk = false; }
  if (!voice.sttOk) {
    voice.error = 'Speech-to-text is not installed on the server yet, so Dumpling can talk but not hear. (whisper.cpp needs a one-time build.)';
    return; // orb stays up with the hint; no mic capture
  }

  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    capCtx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    try { await capCtx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const src = capCtx.createMediaStreamSource(media);
    workletNode = new AudioWorkletNode(capCtx, 'dp-capture');
    src.connect(workletNode);
    workletNode.port.onmessage = (e) => onChunk(e.data);
    noiseFloor = 0.01;
    voice.state = 'listening';
  } catch (err) {
    voice.error = err?.name === 'NotAllowedError'
      ? 'Microphone access was denied — allow it in the browser to talk to Dumpling.'
      : `Couldn't open the microphone: ${err.message ?? err}`;
    teardownCapture();
  }
}

function teardownCapture() {
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (capCtx) { capCtx.close().catch(() => {}); capCtx = null; }
  if (media) { for (const t of media.getTracks()) t.stop(); media = null; }
  capturing = false;
  utter = [];
  preroll = [];
  speechRun = 0;
}

export function stopVoice() {
  genCounter++;
  stopPlayback();
  teardownCapture();
  streamEnded = true;
  voice.open = false;
  voice.state = 'idle';
  voice.userLevel = 0;
  voice.aiLevel = 0;
  voice.error = null;
}

export function toggleMute() {
  voice.muted = !voice.muted;
  if (voice.muted) { capturing = false; utter = []; speechRun = 0; }
}
