import { requireAuth } from '../auth.js';
import { sttAvailable, transcribe } from '../stt.js';

export default async function voiceRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // raw WAV bodies for transcription (16 kHz mono PCM from the browser)
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
    (req, body, done) => done(null, body));

  // lets the UI grey out voice mode (with an install hint) until whisper exists
  app.get('/api/voice/status', async () => ({ stt: sttAvailable() }));

  app.post('/api/voice/transcribe', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    if (!sttAvailable()) {
      return reply.code(503).send({ error: 'speech-to-text is not installed yet (whisper.cpp binary/model missing)' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
      return reply.code(400).send({ error: 'expected a WAV body (content-type: audio/wav)' });
    }
    try {
      const text = await transcribe(req.body);
      return { text };
    } catch (err) {
      req.log.error({ err }, 'transcription failed');
      return reply.code(500).send({ error: `transcription failed: ${err.message}` });
    }
  });
}
