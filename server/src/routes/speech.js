// Speech studio: Voxtral voices (presets + clones), emotion variants, clip
// rendering + library, engine settings. Backed by speechEngine.js — the
// Mistral API today, a local vLLM-Omni server whenever one exists.
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import {
  createVoice, customVoices, deleteVoice, presetVoices, previewVoice,
  saveSpeechSettings, speak, speechConfig, speechStatus, DEFAULT_VOICE, EMOTIONS,
} from '../speechEngine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLIPS_DIR = process.env.SPEECH_CLIPS_DIR ?? join(ROOT, 'data', 'speech-clips');
mkdirSync(CLIPS_DIR, { recursive: true });

const MIME_BY_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg' };

export default async function speechRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/speech/status', async () => speechStatus());

  // ----- engine settings (owner only; the key is never echoed back) -----
  app.get('/api/speech/settings', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const cfg = speechConfig();
    return {
      mode: cfg.mode, model: cfg.model, local_url: cfg.localUrl ?? '',
      api_key_set: !!cfg.apiKey, api_key_hint: cfg.apiKey ? `…${cfg.apiKey.slice(-4)}` : null,
    };
  });

  app.put('/api/speech/settings', async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'owner only' });
    const { api_key, local_url, model } = req.body ?? {};
    saveSpeechSettings({ api_key, local_url, model });
    let st = await speechStatus();
    // a fresh key gets one real round-trip so "connected" means connected
    if (st.ok && st.mode === 'mistral' && api_key) {
      try { await customVoices(true); }
      catch (e) { st = { ok: false, mode: 'mistral', error: e.message }; }
    }
    return { ok: true, status: st };
  });

  // ----- voices -----
  app.get('/api/speech/voices', async () => {
    const custom = await customVoices().catch(() => []);
    return { presets: presetVoices(), custom, emotions: EMOTIONS, default_voice: DEFAULT_VOICE };
  });

  // clone from a reference clip (body = raw wav bytes, audio/wav)
  app.post('/api/speech/voices', async (req, reply) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'send raw audio bytes' });
    try {
      const v = await createVoice({ name, audioB64: req.body.toString('base64'), filename: 'sample.wav' });
      return { ok: true, voice: v };
    } catch (e) {
      return reply.code(e.status === 401 || e.status === 403 ? e.status : 502).send({ error: e.message });
    }
  });

  app.delete('/api/speech/voices/:id', async (req, reply) => {
    try { await deleteVoice(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(e.status === 404 ? 404 : 502).send({ error: e.message }); }
  });

  // short cached sample for the picker play buttons
  app.post('/api/speech/preview', async (req, reply) => {
    const voiceId = String(req.body?.voice_id ?? '').trim();
    if (!voiceId) return reply.code(400).send({ error: 'voice_id required' });
    try {
      const out = await previewVoice(voiceId);
      return reply.type(out.mime).send(out.buf);
    } catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
  });

  // read-aloud voice preference (any user)
  app.patch('/api/speech/readaloud', async (req, reply) => {
    const v = String(req.body?.voice_id ?? '').trim();
    if (!v || v.length > 120) return reply.code(400).send({ error: 'voice_id required' });
    db.prepare('UPDATE users SET tts_voice = ? WHERE id = ?').run(v, req.user.id);
    return { ok: true, voice_id: v };
  });

  // ----- clips -----
  app.post('/api/speech/clips', async (req, reply) => {
    const { text, voice_id, emotion, format } = req.body ?? {};
    if (!String(text ?? '').trim()) return reply.code(400).send({ error: 'text required' });
    const fmt = ['mp3', 'wav', 'flac', 'opus'].includes(format) ? format : 'mp3';
    const base = String(voice_id ?? DEFAULT_VOICE);
    // preset voices take an emotion suffix; clones and local voices are used as-is
    const preset = presetVoices().find((v) => v.id === base);
    const emo = preset?.emotions?.length
      ? (preset.emotions.includes(emotion) ? emotion : 'neutral') : null;
    const fullVoice = emo ? `${base}_${emo}` : base;

    let out;
    try { out = await speak({ text, voiceId: fullVoice, format: fmt }); }
    catch (e) { return reply.code(e.status === 403 ? 403 : 502).send({ error: e.message }); }
    if (!out) return reply.code(422).send({ error: 'nothing to speak' });

    const userDir = join(CLIPS_DIR, String(req.user.id));
    mkdirSync(userDir, { recursive: true });
    const fname = `${Date.now().toString(36)}.${out.ext}`;
    await writeFile(join(userDir, fname), out.buf);
    const seconds = out.ext === 'wav' ? Math.round(((out.buf.length - 44) / 2 / 24000) * 10) / 10 : null;
    const custom = await customVoices().catch(() => []);
    const vname = preset ? `${preset.name}${emo ? ` – ${emo[0].toUpperCase()}${emo.slice(1)}` : ''}`
      : custom.find((v) => v.id === base)?.name ?? base;
    const row = db.prepare(`INSERT INTO speech_clips (user_id, voice_id, voice_name, text, file, seconds)
                            VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(req.user.id, fullVoice, vname, String(text).slice(0, 4000), fname, seconds);
    return row;
  });

  app.get('/api/speech/clips', async (req) =>
    db.prepare('SELECT * FROM speech_clips WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id));

  app.get('/api/speech/clips/:id/audio', async (req, reply) => {
    const row = db.prepare('SELECT * FROM speech_clips WHERE id = ? AND user_id = ?')
      .get(Number(req.params.id), req.user.id);
    if (!row) return reply.code(404).send({ error: 'no such clip' });
    const buf = await readFile(join(CLIPS_DIR, String(req.user.id), row.file)).catch(() => null);
    if (!buf) return reply.code(410).send({ error: 'clip file is gone' });
    const ext = row.file.split('.').pop();
    return reply.type(MIME_BY_EXT[ext] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="duckpond-clip-${row.id}.${ext}"`)
      .send(buf);
  });

  app.delete('/api/speech/clips/:id', async (req, reply) => {
    const row = db.prepare('DELETE FROM speech_clips WHERE id = ? AND user_id = ? RETURNING file')
      .get(Number(req.params.id), req.user.id);
    if (!row) return reply.code(404).send({ error: 'no such clip' });
    await unlink(join(CLIPS_DIR, String(req.user.id), row.file)).catch(() => {});
    return { ok: true };
  });
}
