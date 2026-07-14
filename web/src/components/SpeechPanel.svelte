<script>
  // Speech Lab: clone a voice from a short recording, design one from
  // attributes, then render clips with emotion tags. Full page, same layout
  // family as StatsPanel. Backend: /api/speech/* → OmniVoice bridge.
  import { api } from '../lib/api.js';
  import { toast } from '../lib/toast.svelte.js';
  import AudioWaveform from '@lucide/svelte/icons/audio-waveform';
  import Download from '@lucide/svelte/icons/download';
  import Mic from '@lucide/svelte/icons/mic';
  import Play from '@lucide/svelte/icons/play';
  import Square from '@lucide/svelte/icons/square';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Wand2 from '@lucide/svelte/icons/wand-2';

  let status = $state(null);
  let voices = $state([]);
  let clips = $state([]);

  // studio
  let text = $state('');
  let selVoice = $state('');       // voice id, or '' = ad-hoc design
  let adhoc = $state('');          // instruct text when no voice selected
  let speed = $state(1);
  let rendering = $state(false);
  let renderSec = $state(0);
  let textEl = $state(null);

  // clone flow
  let cloneName = $state('');
  let cloneRefText = $state('');
  let recState = $state('idle');   // idle | rec | have
  let recSec = $state(0);
  let recWav = $state(null);       // Blob
  let cloneBusy = $state(false);

  // design flow
  let designName = $state('');
  let designAttrs = $state('');
  let designBusy = $state(false);

  // playback (one clip at a time)
  let playingId = $state(null);
  let audioEl = null;

  const TOKENS = ['[laughter]', '[sigh]', '[surprise-ah]', '[surprise-oh]', '[surprise-wa]',
    '[question-ah]', '[question-oh]', '[confirmation-en]', '[dissatisfaction-hnn]'];
  const ATTR_CHIPS = ['male', 'female', 'child', 'young adult', 'elderly', 'low pitch',
    'high pitch', 'whisper', 'american accent', 'british accent'];

  async function refresh() {
    const [s, v, c] = await Promise.all([
      api('/api/speech/status').catch(() => ({ ok: false })),
      api('/api/speech/voices').catch(() => []),
      api('/api/speech/clips').catch(() => []),
    ]);
    status = s; voices = v; clips = c;
  }
  $effect(() => { refresh(); });

  function insertToken(tok) {
    const el = textEl;
    const at = el?.selectionStart ?? text.length;
    text = `${text.slice(0, at)}${tok} ${text.slice(at)}`;
    el?.focus();
  }

  function toggleAttr(a) {
    const parts = designAttrs.split(',').map((s) => s.trim()).filter(Boolean);
    designAttrs = (parts.includes(a) ? parts.filter((p) => p !== a) : [...parts, a]).join(', ');
  }

  // ---- recording: mic → 16-bit mono wav (decode via AudioContext so the
  // MediaRecorder container format never matters server-side) ----
  let mediaRec = null;
  let recChunks = [];
  let recTimer = null;

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      mediaRec = new MediaRecorder(stream);
      mediaRec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
      mediaRec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          recWav = await toWav(new Blob(recChunks, { type: mediaRec.mimeType }));
          recState = 'have';
        } catch { toast('Could not process the recording'); recState = 'idle'; }
      };
      mediaRec.start();
      recState = 'rec'; recSec = 0;
      recTimer = setInterval(() => {
        recSec += 1;
        if (recSec >= 12) stopRec(); // bridge trims to 6s anyway; don't over-record
      }, 1000);
    } catch { toast('Microphone permission denied'); }
  }
  function stopRec() {
    clearInterval(recTimer);
    if (mediaRec?.state === 'recording') mediaRec.stop();
  }

  async function toWav(blob) {
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    ac.close();
    const ch = buf.numberOfChannels > 1
      ? buf.getChannelData(0).map((v, i) => (v + buf.getChannelData(1)[i]) / 2)
      : buf.getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + ch.length * 2));
    const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); out.setUint32(4, 36 + ch.length * 2, true); w(8, 'WAVEfmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * 2, true);
    out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data');
    out.setUint32(40, ch.length * 2, true);
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      out.setInt16(44 + i * 2, v * 0x7fff, true);
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  async function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { recWav = await toWav(f); recState = 'have'; }
    catch { toast('Could not read that audio file'); }
  }

  async function createClone() {
    if (!cloneName.trim() || !recWav) return;
    cloneBusy = true;
    try {
      const qs = new URLSearchParams({ name: cloneName.trim(), ref_text: cloneRefText.trim() });
      const res = await fetch(`/api/speech/voices?${qs}`, { method: 'POST', body: recWav });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'clone failed');
      cloneName = ''; cloneRefText = ''; recWav = null; recState = 'idle';
      await refresh();
      toast('Voice cloned');
    } catch (e) { toast(e.message); }
    cloneBusy = false;
  }

  async function createDesign() {
    if (!designName.trim() || !designAttrs.trim()) return;
    designBusy = true;
    try {
      await api('/api/speech/voices/design', { method: 'POST', body: { name: designName.trim(), instruct: designAttrs.trim() } });
      designName = ''; designAttrs = '';
      await refresh();
      toast('Voice created');
    } catch (e) { toast(e.message); }
    designBusy = false;
  }

  async function removeVoice(id) {
    await api(`/api/speech/voices/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    if (selVoice === id) selVoice = '';
    refresh();
  }

  async function render() {
    if (!text.trim() || rendering) return;
    if (!selVoice && !adhoc.trim()) { toast('Pick a voice or describe one'); return; }
    rendering = true; renderSec = 0;
    const t = setInterval(() => (renderSec += 1), 1000);
    try {
      await api('/api/speech/clips', {
        method: 'POST',
        body: { text, voice: selVoice || undefined, instruct: selVoice ? undefined : adhoc.trim(), speed },
      });
      await refresh();
    } catch (e) { toast(e.message); }
    clearInterval(t);
    rendering = false;
  }

  function togglePlay(clip) {
    if (playingId === clip.id) { audioEl?.pause(); playingId = null; return; }
    audioEl?.pause();
    audioEl = new Audio(`/api/speech/clips/${clip.id}/audio`);
    audioEl.onended = () => (playingId = null);
    audioEl.play().then(() => (playingId = clip.id)).catch(() => toast('Playback failed'));
  }

  async function removeClip(id) {
    if (playingId === id) { audioEl?.pause(); playingId = null; }
    await api(`/api/speech/clips/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    refresh();
  }

  const fmtLen = (s) => (s == null ? '' : `${s.toFixed(1)}s`);
  const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
</script>

<div class="lab">
  {#if status && !status.ok}
    <div class="offline">The speech engine is offline — <span class="mono">speech-bridge-8766</span> isn't responding.</div>
  {/if}

  <section>
    <h2>Your voices</h2>
    <div class="voicegrid">
      {#each voices as v (v.id)}
        <div class="vcard" class:sel={selVoice === v.id}
          onclick={() => (selVoice = selVoice === v.id ? '' : v.id)} role="button" tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && (selVoice = selVoice === v.id ? '' : v.id)}>
          <div class="vhead">
            <span class="vname">{v.name}</span>
            <button class="vdel" title="Delete voice" onclick={(e) => { e.stopPropagation(); removeVoice(v.id); }}>
              <Trash2 size={13} />
            </button>
          </div>
          <span class="vkind">{v.kind === 'designed' ? v.instruct : `cloned · ${v.seconds}s reference`}</span>
          {#if selVoice === v.id}<span class="vuse">selected for the studio</span>{/if}
        </div>
      {:else}
        <div class="none">No voices yet — clone or design one below.</div>
      {/each}
    </div>

    <div class="makers">
      <div class="maker">
        <h3><Mic size={14} /> Clone a voice</h3>
        <p class="hint">Record or upload 3–10 seconds of clear speech. It captures tone, accent, even disfluencies.</p>
        <div class="row">
          {#if recState === 'rec'}
            <button class="btn rec" onclick={stopRec}><Square size={13} /> Stop ({recSec}s)</button>
          {:else}
            <button class="btn" onclick={startRec}><Mic size={13} /> {recState === 'have' ? 'Re-record' : 'Record'}</button>
          {/if}
          <label class="btn">
            <Upload size={13} /> Upload
            <input type="file" accept="audio/*" onchange={pickFile} hidden />
          </label>
          {#if recState === 'have'}<span class="ok">reference ready</span>{/if}
        </div>
        <input placeholder="Voice name" bind:value={cloneName} maxlength="60" />
        <input placeholder="What the reference says (optional — auto-transcribed if empty)" bind:value={cloneRefText} maxlength="300" />
        <button class="btn primary" disabled={cloneBusy || recState !== 'have' || !cloneName.trim()} onclick={createClone}>
          {cloneBusy ? 'Cloning…' : 'Create cloned voice'}
        </button>
      </div>

      <div class="maker">
        <h3><Wand2 size={14} /> Design a voice</h3>
        <p class="hint">No recording needed — describe the voice with attributes, freely combinable.</p>
        <div class="chips">
          {#each ATTR_CHIPS as a (a)}
            <button class="chip" class:on={designAttrs.includes(a)} onclick={() => toggleAttr(a)}>{a}</button>
          {/each}
        </div>
        <input placeholder="Attributes, e.g. female, low pitch, british accent" bind:value={designAttrs} maxlength="200" />
        <input placeholder="Voice name" bind:value={designName} maxlength="60" />
        <button class="btn primary" disabled={designBusy || !designName.trim() || !designAttrs.trim()} onclick={createDesign}>
          {designBusy ? 'Creating…' : 'Create designed voice'}
        </button>
      </div>
    </div>
  </section>

  <section>
    <h2>Studio</h2>
    <div class="studio">
      <div class="tokens">
        {#each TOKENS as tok (tok)}
          <button class="chip" onclick={() => insertToken(tok)}>{tok}</button>
        {/each}
      </div>
      <textarea rows="4" maxlength="4000" bind:this={textEl} bind:value={text}
        placeholder="Write what the voice should say. Drop in emotion tags like [laughter] anywhere."></textarea>
      <div class="controls">
        <span class="voicepick">
          {#if selVoice}
            Voice: <b>{voices.find((v) => v.id === selVoice)?.name ?? selVoice}</b>
          {:else}
            <input class="adhoc" placeholder="…or describe a one-off voice: male, elderly, whisper"
              bind:value={adhoc} maxlength="200" />
          {/if}
        </span>
        <label class="speed">Speed {speed.toFixed(1)}×
          <input type="range" min="0.5" max="2" step="0.1" bind:value={speed} />
        </label>
        <button class="btn primary" disabled={rendering || !text.trim()} onclick={render}>
          {#if rendering}Rendering… {renderSec}s{:else}<AudioWaveform size={14} /> Generate clip{/if}
        </button>
      </div>
      {#if rendering}
        <p class="hint">Clips render at roughly 2–4× their length{status?.gpu ? ' (faster when the GPU is idle)' : ''} — a long paragraph takes a couple of minutes.</p>
      {/if}
    </div>
  </section>

  <section>
    <h2>Clips</h2>
    <div class="cliplist">
      {#each clips as c (c.id)}
        <div class="clip">
          <button class="pbtn" onclick={() => togglePlay(c)} title={playingId === c.id ? 'Stop' : 'Play'}>
            {#if playingId === c.id}<Square size={14} />{:else}<Play size={14} />{/if}
          </button>
          <div class="cmain">
            <span class="ctext">{c.text}</span>
            <span class="cmeta mono">{c.voice_name} · {fmtLen(c.seconds)} · {fmtDay(c.created_at)}</span>
          </div>
          <a class="cbtn" href={`/api/speech/clips/${c.id}/audio`} download title="Download WAV"><Download size={14} /></a>
          <button class="cbtn del" onclick={() => removeClip(c.id)} title="Delete clip"><Trash2 size={14} /></button>
        </div>
      {:else}
        <div class="none">Nothing rendered yet.</div>
      {/each}
    </div>
  </section>
</div>

<style>
  .lab { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px 40px; }
  .mono { font-family: var(--mono); }
  .none { padding: 14px 0; color: var(--text-faint); font-size: 12.5px; }
  .offline {
    margin-bottom: 20px; padding: 10px 14px; border-radius: 10px; font-size: 13px;
    background: rgba(192, 96, 79, 0.12); color: var(--red); border: 1px solid rgba(192, 96, 79, 0.3);
  }
  section { margin-bottom: 34px; max-width: 860px; }
  h2 { font-size: 13px; font-weight: 600; color: var(--text-dim); margin: 0 0 12px; }
  h3 {
    display: flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 600; margin: 0 0 4px; color: var(--text);
  }
  h3 :global(svg) { color: var(--accent); }
  .hint { font-size: 12px; color: var(--text-faint); margin: 0 0 10px; line-height: 1.5; }

  .voicegrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .vcard {
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: 12px;
    padding: 12px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 4px;
    transition: border-color 120ms ease;
  }
  .vcard:hover { border-color: var(--border); }
  .vcard.sel { border-color: var(--accent); }
  .vhead { display: flex; align-items: center; gap: 8px; }
  .vname { flex: 1; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vkind { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vuse { font-size: 11px; color: var(--accent); }
  .vdel {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: 6px; color: var(--text-faint);
  }
  .vdel:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); }

  .makers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 860px) { .makers { grid-template-columns: 1fr; } }
  .maker {
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: 14px;
    padding: 16px 18px; display: flex; flex-direction: column; gap: 9px;
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ok { font-size: 12px; color: var(--green); }
  .maker input, .studio textarea, .adhoc {
    background: var(--bg-input); border: 1px solid var(--border-soft); border-radius: 10px;
    padding: 8px 12px; font-size: 13px; color: var(--text); width: 100%;
  }
  .btn {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 7px 13px; border-radius: 9px; font-size: 12.5px; cursor: pointer;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text);
  }
  .btn:hover { background: var(--bg-hover); }
  .btn.primary { background: var(--accent); color: var(--bg); border-color: transparent; font-weight: 600; }
  .btn.primary:disabled { opacity: 0.5; cursor: default; }
  .btn.rec { color: var(--red); border-color: rgba(192, 96, 79, 0.4); }
  .chips, .tokens { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    all: unset; cursor: pointer; font-size: 11.5px; padding: 4px 10px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text-dim);
  }
  .chip:hover { background: var(--bg-hover); }
  .chip.on { color: var(--accent); border-color: var(--accent); }

  .studio {
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: 14px;
    padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  }
  .studio textarea { resize: vertical; min-height: 84px; font-family: inherit; line-height: 1.5; }
  .controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .voicepick { flex: 1; min-width: 200px; font-size: 12.5px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
  .speed { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); white-space: nowrap; }
  .speed input { accent-color: var(--accent); }

  .cliplist { display: flex; flex-direction: column; gap: 8px; }
  .clip {
    display: flex; align-items: center; gap: 12px;
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: 12px;
    padding: 10px 14px;
  }
  .pbtn {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 32px; height: 32px; border-radius: 999px; flex-shrink: 0;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--accent);
  }
  .pbtn:hover { background: var(--bg-hover); }
  .cmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ctext { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmeta { font-size: 10.5px; color: var(--text-faint); }
  .cbtn {
    all: unset; cursor: pointer; display: grid; place-items: center;
    width: 26px; height: 26px; border-radius: 7px; color: var(--text-dim); flex-shrink: 0;
  }
  .cbtn:hover { background: var(--bg-hover); color: var(--text); }
  .cbtn.del:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); }
</style>
