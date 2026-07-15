import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { MAX_TTS_CHARS, synthReadAloud } from '../speechEngine.js';

export default async function ttsRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // { text } → audio. Markdown is stripped server-side so every client speaks
  // the same way. Voice = the user's read-aloud pick (Speech page).
  app.post('/api/tts', async (req, reply) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return reply.code(400).send({ error: 'no text' });
    if (text.length > MAX_TTS_CHARS * 4) return reply.code(413).send({ error: 'too long to speak' });
    const voice = db.prepare('SELECT tts_voice FROM users WHERE id = ?').get(req.user.id)?.tts_voice;
    let out;
    try { out = await synthReadAloud(text, voice); }
    catch (e) { return reply.code(e.status ?? 502).send({ error: e.message }); }
    if (!out) return reply.code(422).send({ error: 'nothing speakable in this message' });
    return reply.type(out.mime).send(out.buf);
  });
}
