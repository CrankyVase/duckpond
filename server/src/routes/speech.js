// Speech Lab: voice cloning + voice design + clip rendering, backed by the
// OmniVoice bridge on :8766 (speech-bridge/bridge.py). All endpoints are
// authed; the bridge itself is localhost-only and trusts us.
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';

const BRIDGE = process.env.SPEECH_BRIDGE_URL ?? 'http://127.0.0.1:8766';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLIPS_DIR = process.env.SPEECH_CLIPS_DIR ?? join(ROOT, 'data', 'speech-clips');
mkdirSync(CLIPS_DIR, { recursive: true });

// Clip renders take ~2-4x realtime on CPU — one at a time keeps the box sane
// and gives honest queueing instead of thrashing.
let chain = Promise.resolve();
const queued = () => { let n = 0; return { inc: () => ++n, dec: () => --n, get: () => n }; };
const q = queued();

async function bridge(path, opts = {}, timeoutMs = 10_000) {
  const res = await fetch(BRIDGE + path, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({})))?.detail;
    throw Object.assign(new Error(detail ?? `speech bridge ${res.status}`), { status: res.status });
  }
  return res;
}

export default async function speechRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/speech/status', async () => {
    try {
      const h = await (await bridge('/health', {}, 3000)).json();
      return { ...h, queue: q.get() };
    } catch {
      return { ok: false, error: 'speech bridge is not running' };
    }
  });

  app.get('/api/speech/voices', async () => (await bridge('/voices')).json());

  // clone from a reference clip (body = wav/flac/ogg bytes)
  app.post('/api/speech/voices', async (req, reply) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'send raw audio bytes' });
    const qs = new URLSearchParams({ name, ref_text: String(req.query.ref_text ?? '') });
    const res = await bridge(`/voices?${qs}`, { method: 'POST', body: req.body }, 30_000)
      .catch((e) => reply.code(e.status === 400 ? 400 : 502).send({ error: e.message }));
    if (reply.sent) return;
    return res.json();
  });

  // design from attributes — no reference audio
  app.post('/api/speech/voices/design', async (req, reply) => {
    const { name, instruct } = req.body ?? {};
    const res = await bridge('/voices/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, instruct }),
    }, 15_000).catch((e) => reply.code(e.status === 400 ? 400 : 502).send({ error: e.message }));
    if (reply.sent) return;
    return res.json();
  });

  app.delete('/api/speech/voices/:id', async (req, reply) => {
    await bridge(`/voices/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' })
      .catch((e) => reply.code(e.status === 404 ? 404 : 502).send({ error: e.message }));
    if (reply.sent) return;
    return { ok: true };
  });

  // render a clip: serialized behind the queue, saved to the user's library
  app.post('/api/speech/clips', async (req, reply) => {
    const { text, voice, instruct, speed } = req.body ?? {};
    if (!String(text ?? '').trim()) return reply.code(400).send({ error: 'text required' });
    if (!voice && !String(instruct ?? '').trim()) return reply.code(400).send({ error: 'pick a voice or describe one' });

    q.inc();
    const job = chain.then(async () => {
      const res = await bridge('/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, instruct, speed }),
      }, 300_000);
      return Buffer.from(await res.arrayBuffer());
    });
    chain = job.catch(() => {});
    let wav;
    try { wav = await job; } finally { q.dec(); }

    const userDir = join(CLIPS_DIR, String(req.user.id));
    mkdirSync(userDir, { recursive: true });
    const fname = `${Date.now().toString(36)}.wav`;
    await writeFile(join(userDir, fname), wav);
    const seconds = Math.round(((wav.length - 44) / 2 / 24000) * 10) / 10;
    let voiceName = String(instruct ?? '').trim() || voice;
    if (voice) {
      try {
        const voices = await (await bridge('/voices')).json();
        voiceName = voices.find((v) => v.id === voice)?.name ?? voice;
      } catch { /* keep the id */ }
    }
    const row = db.prepare(`INSERT INTO speech_clips (user_id, voice_id, voice_name, text, file, seconds)
                            VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(req.user.id, voice ?? null, voiceName, String(text).slice(0, 4000), fname, seconds);
    return row;
  });

  app.get('/api/speech/clips', async (req) =>
    db.prepare('SELECT * FROM speech_clips WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id));

  app.get('/api/speech/clips/:id/audio', async (req, reply) => {
    const row = db.prepare('SELECT * FROM speech_clips WHERE id = ? AND user_id = ?')
      .get(Number(req.params.id), req.user.id);
    if (!row) return reply.code(404).send({ error: 'no such clip' });
    const wav = await readFile(join(CLIPS_DIR, String(req.user.id), row.file)).catch(() => null);
    if (!wav) return reply.code(410).send({ error: 'clip file is gone' });
    return reply.type('audio/wav')
      .header('content-disposition', `attachment; filename="duckpond-clip-${row.id}.wav"`)
      .send(wav);
  });

  app.delete('/api/speech/clips/:id', async (req, reply) => {
    const row = db.prepare('DELETE FROM speech_clips WHERE id = ? AND user_id = ? RETURNING file')
      .get(Number(req.params.id), req.user.id);
    if (!row) return reply.code(404).send({ error: 'no such clip' });
    await unlink(join(CLIPS_DIR, String(req.user.id), row.file)).catch(() => {});
    return { ok: true };
  });
}
