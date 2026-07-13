// Piper text-to-speech: local, CPU-only (never fights the GPU), ~0.03x
// real-time factor on this box so per-sentence synthesis is effectively free.
// Synth results are cached on disk by content hash — replaying a message or
// re-speaking a common sentence costs one stat() instead of a spawn.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPER_BIN = process.env.PIPER_BIN ?? '/home/cranky/bin/piper-install/piper/piper';
const PIPER_VOICE = process.env.PIPER_VOICE ?? '/home/lewis/tts-voices/en_US-amy-medium.onnx';
const PIPER_DIR = dirname(PIPER_BIN);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = process.env.TTS_CACHE_DIR ?? join(ROOT, 'data', 'tts-cache');
mkdirSync(CACHE_DIR, { recursive: true });

export const MAX_TTS_CHARS = 4000;

// Markdown → speakable text. The model writes for the eye; strip everything
// piper would read as syntax. Code and widgets are dropped (not read aloud),
// links keep their label, formatting marks disappear.
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

// One synth at a time: piper is fast enough that a queue never builds up, and
// serializing keeps memory flat if several users hit play at once.
let chain = Promise.resolve();

export function synth(text) {
  const clean = stripForSpeech(text).slice(0, MAX_TTS_CHARS);
  if (!clean) return Promise.resolve(null);
  const hash = createHash('sha256').update(PIPER_VOICE + '\0' + clean).digest('hex').slice(0, 32);
  const file = join(CACHE_DIR, `${hash}.wav`);
  const job = chain.then(async () => {
    const cached = await readFile(file).catch(() => null);
    if (cached) return cached;
    const wav = await new Promise((resolve, reject) => {
      const child = execFile(
        PIPER_BIN,
        ['-m', PIPER_VOICE, '--output_file', '-'],
        {
          env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR },
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60_000,
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin.end(clean);
    });
    await writeFile(file, wav).catch(() => {});
    return wav;
  });
  // keep the chain alive even when a job fails
  chain = job.catch(() => {});
  return job;
}
