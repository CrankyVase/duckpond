import { requireAuth } from '../auth.js';
import { MAX_TTS_CHARS, synth } from '../tts.js';

export default async function ttsRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // { text } → WAV. Markdown is stripped server-side so every client speaks
  // the same way (per-message button now, live voice mode on top of it later).
  app.post('/api/tts', async (req, reply) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return reply.code(400).send({ error: 'no text' });
    if (text.length > MAX_TTS_CHARS * 4) return reply.code(413).send({ error: 'too long to speak' });
    const wav = await synth(text);
    if (!wav) return reply.code(422).send({ error: 'nothing speakable in this message' });
    return reply.type('audio/wav').send(wav);
  });
}
