// whisper.cpp speech-to-text: local, CPU-only (never fights the GPU).
// The binary/model are optional at runtime — sttAvailable() gates the voice
// features in the UI until they're installed, so the app works without them.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const WHISPER_BIN = process.env.WHISPER_BIN ?? '/home/cranky/bin/whisper-prebuilt/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? '/home/lewis/whisper-models/ggml-base.en.bin';
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS ?? 8);

const WORK_DIR = join(tmpdir(), 'duckpond-stt');
mkdirSync(WORK_DIR, { recursive: true });

export function sttAvailable() {
  return existsSync(WHISPER_BIN) && existsSync(WHISPER_MODEL);
}

// One transcription at a time — utterances are short (a few seconds of speech)
// and whisper on 8 threads chews through them far faster than people talk.
let chain = Promise.resolve();

// wav: 16 kHz mono 16-bit PCM buffer (the browser encodes exactly this).
export function transcribe(wav) {
  const job = chain.then(async () => {
    if (!sttAvailable()) {
      throw Object.assign(new Error('speech-to-text engine is not installed'), { code: 'STT_MISSING' });
    }
    const file = join(WORK_DIR, `utt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    await writeFile(file, wav);
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile(
          WHISPER_BIN,
          ['-m', WHISPER_MODEL, '-f', file, '-nt', '-np', '-t', String(WHISPER_THREADS), '-l', 'en'],
          {
            env: { ...process.env, LD_LIBRARY_PATH: dirname(WHISPER_BIN) },
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          },
          (err, out) => (err ? reject(err) : resolve(out)),
        );
      });
      // -nt -np leaves just the transcript on stdout; whisper still emits
      // bracketed markers like [BLANK_AUDIO] or (crickets) for non-speech
      return stdout
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } finally {
      unlink(file).catch(() => {});
    }
  });
  chain = job.catch(() => {});
  return job;
}
