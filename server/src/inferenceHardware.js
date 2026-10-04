// Inference hardware belongs to Windows. Never substitute Fedora's readings
// when a configured remote worker is unavailable.
const HARDWARE_URL = process.env.INFERENCE_HARDWARE_URL;
let cached = null;
let pending = null;
let fetchedAt = 0;
export function usesRemoteHardware() { return !!HARDWARE_URL; }
export async function inferenceHardware() {
  if (!HARDWARE_URL) return null;
  if (cached && Date.now() - fetchedAt < 4000) return cached;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(HARDWARE_URL, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Windows hardware unavailable (${response.status})`);
    const value = await response.json();
    if (!value.ram?.totalBytes || !value.vram?.totalBytes) throw new Error('Windows hardware response is incomplete');
    cached = value;
    fetchedAt = Date.now();
    return value;
  })().finally(() => { pending = null; });
  return pending;
}
