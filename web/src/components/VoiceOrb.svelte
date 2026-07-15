<script>
  // The voice-mode orb: one reactive shape, two distinct live states —
  // a green outer ring that swells with the USER's mic level while listening,
  // and a warm core glow that pulses with the DUCK's TTS output while it
  // speaks. Thinking gets a slow conic spin. Floats above the composer,
  // never blocks the chat.
  import { toggleMute, voice, stopVoice } from '../lib/voice.svelte.js';
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import X from '@lucide/svelte/icons/x';

  const STATUS = {
    idle: 'starting…',
    listening: 'listening — just talk',
    thinking: 'thinking…',
    speaking: 'speaking',
  };
  const userScale = $derived(1 + voice.userLevel * 0.45);
  const aiScale = $derived(1 + voice.aiLevel * 0.3);
</script>

<div class="voicecard fade-in" role="dialog" aria-label="Voice conversation">
  <div class="orbwrap">
    <div class="ring" class:hot={voice.state === 'listening' && !voice.muted}
      style:transform={`scale(${voice.state === 'speaking' ? 1 : userScale})`}></div>
    <div class="orb {voice.state}" class:muted={voice.muted}
      style:transform={`scale(${voice.state === 'speaking' ? aiScale : 1})`}>
      <div class="sheen"></div>
    </div>
  </div>
  <div class="meta">
    {#if voice.error}
      <div class="err">{voice.error}</div>
    {:else}
      <div class="vstatus" class:shimmer={voice.state === 'thinking'}>
        {voice.muted ? 'muted' : STATUS[voice.state]}
      </div>
      {#if voice.heard}
        <div class="heard" title="what the duck heard">“{voice.heard}”</div>
      {/if}
    {/if}
  </div>
  <div class="vactions">
    {#if voice.sttOk}
      <button class="vbtn" class:warn={voice.muted} onclick={toggleMute}
        title={voice.muted ? 'Unmute microphone' : 'Mute microphone'}>
        {#if voice.muted}<MicOff size={14} />{:else}<Mic size={14} />{/if}
      </button>
    {/if}
    <button class="vbtn" onclick={stopVoice} title="End voice conversation"><X size={15} /></button>
  </div>
</div>

<style>
  .voicecard {
    position: fixed; right: 22px; bottom: 96px; z-index: 60;
    display: flex; align-items: center; gap: 14px;
    padding: 14px 14px 14px 16px;
    max-width: 340px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: calc(18px * var(--rf)); box-shadow: var(--shadow-lg);
  }
  .orbwrap { position: relative; width: 74px; height: 74px; flex-shrink: 0; display: grid; place-items: center; }

  .ring {
    position: absolute; inset: 0; border-radius: 50%;
    border: 2px solid transparent;
    transition: transform 90ms ease-out, border-color 220ms ease, box-shadow 220ms ease;
  }
  .ring.hot {
    border-color: color-mix(in srgb, var(--green) 65%, transparent);
    box-shadow: 0 0 18px color-mix(in srgb, var(--green) 30%, transparent);
  }

  .orb {
    position: relative; width: 54px; height: 54px; border-radius: 50%;
    overflow: hidden;
    background: radial-gradient(circle at 32% 28%, #efe0c8, var(--accent) 55%, var(--accent-deep) 100%);
    box-shadow: 0 0 22px var(--accent-glow), inset 0 -6px 14px rgba(0, 0, 0, 0.25);
    transition: transform 90ms ease-out, box-shadow 250ms ease, filter 250ms ease;
  }
  .orb.idle { animation: breathe 3.2s ease-in-out infinite; }
  .orb.listening { filter: saturate(0.8) brightness(0.92); }
  .orb.thinking .sheen { opacity: 1; animation: spin 1.8s linear infinite; }
  .orb.speaking {
    box-shadow: 0 0 30px color-mix(in srgb, var(--accent) 45%, transparent),
      inset 0 -6px 14px rgba(0, 0, 0, 0.25);
  }
  .orb.muted { filter: grayscale(0.85) brightness(0.7); }
  .sheen {
    position: absolute; inset: -30%;
    background: conic-gradient(from 0deg, transparent 0 70%, rgba(255, 244, 224, 0.55) 82%, transparent 94%);
    opacity: 0; transition: opacity 250ms ease;
  }
  @keyframes breathe { 50% { transform: scale(1.06); } }
  @keyframes spin { to { transform: rotate(360deg); } }

  .meta { flex: 1; min-width: 0; }
  .vstatus { font-size: 12.5px; color: var(--text-dim); }
  .heard {
    margin-top: 5px; font-size: 12px; color: var(--text-faint);
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .err { font-size: 12px; color: var(--red); line-height: 1.5; }
  .shimmer {
    background: linear-gradient(90deg, var(--text-faint) 30%, var(--text) 50%, var(--text-faint) 70%);
    background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmertxt 1.6s linear infinite;
  }
  @keyframes shimmertxt { to { background-position: -200% 0; } }

  .vactions { display: flex; flex-direction: column; gap: 6px; }
  .vbtn {
    all: unset; cursor: pointer;
    display: grid; place-items: center;
    width: 28px; height: 26px; border-radius: calc(7px * var(--rf));
    color: var(--text-dim);
    transition: background 120ms ease, color 120ms ease;
  }
  .vbtn:hover { background: var(--bg-hover); color: var(--text); }
  .vbtn.warn { color: var(--red); }
</style>
