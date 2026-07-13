// Per-message "read aloud": at most one message speaks at a time, app-wide.
// (Live voice mode has its own audio pipeline — this is just the button.)

export const speech = $state({ playingId: null, loadingId: null });

let audio = null;
let url = null;

export function stopSpeech() {
  if (audio) { audio.pause(); audio = null; }
  if (url) { URL.revokeObjectURL(url); url = null; }
  speech.playingId = null;
  speech.loadingId = null;
}

export async function toggleSpeech(msg) {
  if (speech.playingId === msg.id || speech.loadingId === msg.id) { stopSpeech(); return; }
  stopSpeech();
  speech.loadingId = msg.id;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg.content ?? '' }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    // user may have hit stop (or played another message) while we synthesized
    if (speech.loadingId !== msg.id) return;
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.onended = stopSpeech;
    audio.onerror = stopSpeech;
    await audio.play();
    speech.loadingId = null;
    speech.playingId = msg.id;
  } catch {
    if (speech.loadingId === msg.id) stopSpeech();
  }
}
