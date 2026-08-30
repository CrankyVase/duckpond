<script>
  // Text to Speech — Voxtral. Layout mirrors the Mistral console: big text
  // pane + right rail (model card, voice card, emotion card, each drilling
  // into its own selector panel), generate → bottom player bar with waveform.
  import { api } from '../lib/api.js';
  import { noAutofill } from '../lib/noAutofill.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import AudioWaveform from '@lucide/svelte/icons/audio-waveform';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Download from '@lucide/svelte/icons/download';
  import Mic from '@lucide/svelte/icons/mic';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Search from '@lucide/svelte/icons/search';
  import Square from '@lucide/svelte/icons/square';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Volume2 from '@lucide/svelte/icons/volume-2';

  const MAX_CHARS = 4000;

  let status = $state(null);
  let presets = $state([]);
  let custom = $state([]);
  let emotions = $state({});
  let clips = $state([]);

  let text = $state('');
  let voiceId = $state(localStorage.getItem('dp_speech_voice') ?? 'en_paul');
  let emotion = $state(localStorage.getItem('dp_speech_emotion') ?? 'neutral');
  let rail = $state('main');       // main | voice | emotion | clone
  let vsearch = $state('');
  let vgender = $state('');
  let vlang = $state('');
  let generating = $state(false);

  // engine settings (owner)
  let cfg = $state(null);
  let keyInput = $state('');
  let urlInput = $state('');
  let savingCfg = $state(false);

  // player
  let player = $state(null);       // { clip, url, dur }
  let playing = $state(false);
  let ptime = $state(0);
  let pspeed = $state(1);
  let peaks = $state([]);
  let audio = null;

  // voice preview (picker play buttons)
  let previewingId = $state(null);
  let previewAudio = null;

  // clone flow
  let cloneName = $state('');
  let recState = $state('idle');
  let recSec = $state(0);
  let recWav = $state(null);
  let cloneBusy = $state(false);

  const isOwner = $derived(app.user?.role === 'owner');
  const allVoices = $derived([...presets, ...custom]);
  const selVoice = $derived(allVoices.find((v) => v.id === voiceId) ?? allVoices[0]);
  const hasEmotions = $derived((selVoice?.emotions?.length ?? 0) > 0);
  const fullVoiceId = $derived(hasEmotions ? `${selVoice.id}_${emotion}` : selVoice?.id);
  const langs = $derived([...new Set(presets.map((v) => v.language))]);
  const filtered = $derived(allVoices.filter((v) =>
    (!vsearch || v.name.toLowerCase().includes(vsearch.toLowerCase()))
    && (!vgender || v.gender === vgender)
    && (!vlang || v.language === vlang)));

  const SAMPLES = [
    ['Short story', 'Oh, the dawn whispers secrets to the waking earth, as golden fingers of sunlight dance upon the dewy grass, painting the world anew with hues of hope and promise.'],
    ['Announcement', 'Attention everyone! The pond will be closed for maintenance this Saturday from nine to noon. We apologize for any inconvenience and thank you for your patience.'],
    ['Podcast intro', "Welcome back to another episode! Today we're diving into something I've been excited about for weeks — so grab a coffee, settle in, and let's get started."],
    ['Tech support', "Thanks for calling support, I'd be happy to help you with that. Could you tell me exactly what you see on the screen right now?"],
  ];

  async function refresh() {
    const [s, v, c] = await Promise.all([
      api('/api/speech/status').catch(() => ({ ok: false, mode: 'off' })),
      api('/api/speech/voices').catch(() => null),
      api('/api/speech/clips').catch(() => []),
    ]);
    status = s; clips = c;
    if (v) { presets = v.presets; custom = v.custom; emotions = v.emotions; }
    if (s.mode === 'off' && isOwner) cfg = await api('/api/speech/settings').catch(() => null);
    // stale saved voice → fall back
    if (![...presets, ...custom].some((x) => x.id === voiceId) && presets.length) voiceId = presets[0].id;
  }
  $effect(() => { refresh(); });
  $effect(() => { localStorage.setItem('dp_speech_voice', voiceId); });
  $effect(() => { localStorage.setItem('dp_speech_emotion', emotion); });

  function pickVoice(v) {
    voiceId = v.id;
    if (v.emotions?.length && !v.emotions.includes(emotion)) emotion = 'neutral';
    rail = 'main';
  }

  async function saveCfg() {
    savingCfg = true;
    try {
      const r = await api('/api/speech/settings', {
        method: 'PUT',
        body: { ...(keyInput.trim() && { api_key: keyInput.trim() }), ...(urlInput.trim() && { local_url: urlInput.trim() }) },
      });
      keyInput = ''; urlInput = '';
      if (r.status?.ok) toast('Speech engine connected');
      else toast(r.status?.error ?? 'Saved, but the engine is not responding');
      await refresh();
    } catch (e) { toast(e.message); }
    savingCfg = false;
  }

  // ---- generation + player ----
  async function generate() {
    if (!text.trim() || generating || !selVoice) return;
    generating = true;
    stopPlayer();
    try {
      const clip = await api('/api/speech/clips', {
        method: 'POST',
        body: { text, voice_id: selVoice.id, emotion: hasEmotions ? emotion : undefined, format: 'mp3' },
      });
      clips = [clip, ...clips];
      await loadPlayer(clip);
    } catch (e) { toast(e.message); }
    generating = false;
  }

  async function loadPlayer(clip) {
    stopPlayer();
    const res = await fetch(`/api/speech/clips/${clip.id}/audio`);
    if (!res.ok) { toast('Could not load audio'); return; }
    const buf = await res.arrayBuffer();
    const ac = new AudioContext();
    let dur = 0;
    try {
      const decoded = await ac.decodeAudioData(buf.slice(0));
      dur = decoded.duration;
      const data = decoded.getChannelData(0);
      const bars = 160;
      const step = Math.floor(data.length / bars) || 1;
      const p = [];
      for (let i = 0; i < bars; i++) {
        let max = 0;
        for (let j = i * step; j < (i + 1) * step && j < data.length; j += 8) max = Math.max(max, Math.abs(data[j]));
        p.push(max);
      }
      const top = Math.max(...p, 0.01);
      peaks = p.map((x) => x / top);
    } catch { peaks = []; }
    ac.close();
    const url = URL.createObjectURL(new Blob([buf]));
    player = { clip, url, dur };
    audio = new Audio(url);
    audio.playbackRate = pspeed;
    audio.ontimeupdate = () => (ptime = audio.currentTime);
    audio.onended = () => (playing = false);
    audio.play().then(() => (playing = true)).catch(() => {});
  }

  function togglePlay() {
    if (!audio) return;
    if (playing) { audio.pause(); playing = false; }
    else { audio.play(); playing = true; }
  }
  function stopPlayer() {
    if (audio) { audio.pause(); audio = null; }
    if (player?.url) URL.revokeObjectURL(player.url);
    player = null; playing = false; ptime = 0; peaks = [];
  }
  function seek(e) {
    if (!audio || !player?.dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * player.dur;
  }
  function cycleSpeed() {
    const steps = [1, 1.25, 1.5, 2, 0.75];
    pspeed = steps[(steps.indexOf(pspeed) + 1) % steps.length];
    if (audio) audio.playbackRate = pspeed;
  }

  async function preview(id, e) {
    e?.stopPropagation();
    if (previewingId === id) { previewAudio?.pause(); previewingId = null; return; }
    previewAudio?.pause();
    previewingId = id;
    try {
      const res = await fetch('/api/speech/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice_id: id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'preview failed');
      if (previewingId !== id) return;
      previewAudio = new Audio(URL.createObjectURL(await res.blob()));
      previewAudio.onended = () => (previewingId = null);
      await previewAudio.play();
    } catch (e2) { toast(e2.message); previewingId = null; }
  }

  async function setReadAloud() {
    try {
      await api('/api/speech/readaloud', { method: 'PATCH', body: { voice_id: fullVoiceId } });
      toast('Read-aloud voice updated');
    } catch (e) { toast(e.message); }
  }

  // ---- recording (clone flow) ----
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
        try { recWav = await toWav(new Blob(recChunks, { type: mediaRec.mimeType })); recState = 'have'; }
        catch { toast('Could not process the recording'); recState = 'idle'; }
      };
      mediaRec.start();
      recState = 'rec'; recSec = 0;
      recTimer = setInterval(() => { recSec += 1; if (recSec >= 15) stopRec(); }, 1000);
    } catch { toast('Microphone permission denied'); }
  }
  function stopRec() { clearInterval(recTimer); if (mediaRec?.state === 'recording') mediaRec.stop(); }

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
      const res = await fetch(`/api/speech/voices?${new URLSearchParams({ name: cloneName.trim() })}`,
        { method: 'POST', body: recWav });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'clone failed');
      cloneName = ''; recWav = null; recState = 'idle';
      await refresh();
      rail = 'voice';
      toast('Voice cloned');
    } catch (e) { toast(e.message); }
    cloneBusy = false;
  }

  async function removeVoice(id, e) {
    e?.stopPropagation();
    await api(`/api/speech/voices/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((er) => toast(er.message));
    if (voiceId === id) voiceId = presets[0]?.id ?? '';
    refresh();
  }

  async function removeClip(id) {
    if (player?.clip.id === id) stopPlayer();
    await api(`/api/speech/clips/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    refresh();
  }

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
  }

  // ---- pixel-art avatars (no emoji, ever) ----
  // 7x7 grid face; hue from the voice id, hairstyle from gender.
  function avatarRects(v) {
    const hue = [...(v.id ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    const skin = `hsl(${hue} 45% 62%)`;
    const hair = `hsl(${(hue + 150) % 360} 40% 32%)`;
    const r = [];
    for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) r.push([x, y, skin]);
    r.push([2, 2, '#1c1a17'], [4, 2, '#1c1a17']);                       // eyes
    for (let x = 2; x <= 4; x++) r.push([x, 4, `hsl(${hue} 55% 42%)`]); // mouth
    for (let x = 0; x <= 6; x++) r.push([x, 0, hair]);                  // hair top
    r.push([0, 1, hair], [6, 1, hair]);
    if (v.gender === 'female') r.push([0, 2, hair], [6, 2, hair], [0, 3, hair], [6, 3, hair], [0, 4, hair], [6, 4, hair]);
    return r;
  }
  const EMO_HUE = { neutral: 210, sad: 225, happy: 48, excited: 28, curious: 168, confident: 268, cheerful: 88, frustrated: 14, angry: 0 };
  const EMO_SAT = (e) => (e === 'neutral' ? '12%' : '62%');
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
</script>

{#snippet pixelAvatar(v, size = 26)}
  <svg width={size} height={size} viewBox="0 0 7 7" class="pavatar" aria-hidden="true">
    {#each avatarRects(v) as [x, y, c], i (i)}<rect {x} {y} width="1.02" height="1.02" fill={c} />{/each}
  </svg>
{/snippet}

{#snippet emoGlyph(e, size = 22)}
  <svg width={size} height={size} viewBox="0 0 8 8" class="pemo" aria-hidden="true">
    {#each [3, 5, 2, 6, 4, 7, 3, 5] as h, i (i)}
      <rect x={i} y={(8 - h * (e === 'sad' ? 0.6 : e === 'excited' || e === 'angry' ? 1 : 0.8)) / 1}
        width="0.8" height={h * (e === 'sad' ? 0.6 : e === 'excited' || e === 'angry' ? 1 : 0.8)}
        fill={`hsl(${EMO_HUE[e] ?? 210} ${EMO_SAT(e)} 58%)`} rx="0.2" />
    {/each}
  </svg>
{/snippet}

<div class="tts">
  <div class="topbar">
    <h1>Text to Speech <span class="badge">Voxtral</span></h1>
    <div class="topright">
      <span class="counter" class:over={text.length > MAX_CHARS}>{text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}</span>
      {#if text}
        <button class="ghost" onclick={() => { text = ''; stopPlayer(); }} title="Clear text"><RotateCcw size={13} /> Reset</button>
      {/if}
      <button class="gen" disabled={generating || !text.trim() || status?.mode === 'off'} onclick={generate}>
        <Volume2 size={15} /> {generating ? 'Generating…' : 'Generate speech'} <span class="kbd">Ctrl↵</span>
      </button>
    </div>
  </div>

  {#if status && status.mode === 'off'}
    <div class="setup">
      <h3>Connect the Voxtral engine</h3>
      {#if isOwner}
        <p>Voxtral-4B-TTS needs a GPU that this box doesn't have free — the local runtime (vLLM-Omni) has no CPU support yet.
          Paste a Mistral API key to use the exact same model hosted (your console account works), or point at a local
          vLLM-Omni server if one ever comes up.</p>
        <div class="setuprow">
          <input type="password" placeholder="Mistral API key (console.mistral.ai → API Keys)" bind:value={keyInput} />
          <button class="gen" disabled={savingCfg || (!keyInput.trim() && !urlInput.trim())} onclick={saveCfg}>
            {savingCfg ? 'Checking…' : 'Connect'}
          </button>
        </div>
        <div class="setuprow">
          <input placeholder="…or local vLLM-Omni URL, e.g. http://127.0.0.1:8767" bind:value={urlInput} use:noAutofill />
        </div>
        {#if cfg?.api_key_set}<p class="mono dim">current key: {cfg.api_key_hint}</p>{/if}
      {:else}
        <p>The speech engine isn't set up yet — ask the pond owner to connect it.</p>
      {/if}
    </div>
  {/if}

  <div class="stage">
    <div class="pane">
      {#if generating}
        <div class="genwait">
          <div class="genspin">
            {#each [0, 1, 2, 3, 4, 5, 6, 7, 8] as i (i)}<span class="gpx" style={`--i:${i}`}></span>{/each}
          </div>
          <span>Generating audio</span>
        </div>
      {:else}
        <textarea bind:value={text} maxlength={MAX_CHARS} onkeydown={onKey}
          placeholder="Type or paste the text you'd like to hear spoken aloud..."></textarea>
        {#if !text}
          <div class="starters">
            <span class="startlbl">Get started</span>
            <div class="startchips">
              {#each SAMPLES as [label, sample] (label)}
                <button class="chip" onclick={() => (text = sample)}>{label}</button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      {#if player}
        <div class="playerbar">
          <button class="pplay" onclick={togglePlay}>
            {#if playing}<Pause size={16} />{:else}<Play size={16} />{/if}
          </button>
          <span class="plabel">{player.clip.voice_name}</span>
          <span class="ptime mono">{fmtT(ptime)}</span>
          <div class="wave" onclick={seek} role="slider" aria-label="Seek" aria-valuenow={Math.round(ptime)}
            aria-valuemin="0" aria-valuemax={Math.round(player.dur)} tabindex="0"
            onkeydown={(e) => { if (audio && e.key === 'ArrowRight') audio.currentTime += 3; if (audio && e.key === 'ArrowLeft') audio.currentTime -= 3; }}>
            {#each peaks as p, i (i)}
              <span class="wbar" class:played={player.dur && i / peaks.length <= ptime / player.dur}
                style={`height:${Math.max(8, p * 100)}%`}></span>
            {/each}
          </div>
          <span class="ptime mono">{fmtT(player.dur)}</span>
          <button class="ghost" onclick={cycleSpeed}>{pspeed}x</button>
          <a class="ghost" href={`/api/speech/clips/${player.clip.id}/audio`} download title="Download"><Download size={14} /></a>
        </div>
      {/if}
    </div>

    <aside class="rail">
      {#if rail === 'main'}
        <div class="sect">Model</div>
        <div class="card static">
          <span class="mico"><AudioWaveform size={14} /></span>
          <span class="cname">Voxtral</span>
          <span class="cmeta">{status?.mode === 'local' ? 'local' : status?.mode === 'mistral' ? 'hosted' : 'offline'}</span>
        </div>

        <div class="sect">Voice</div>
        {#if selVoice}
          <button class="card" onclick={() => (rail = 'voice')}>
            {@render pixelAvatar(selVoice)}
            <span class="cname">{selVoice.name}</span>
            <span class="cmeta">{selVoice.language}</span>
            <ChevronRight size={15} class="chev" />
          </button>
          {#if hasEmotions}
            <button class="card" onclick={() => (rail = 'emotion')}>
              {@render emoGlyph(emotion)}
              <span class="cname">{cap(emotion)}</span>
              <ChevronRight size={15} class="chev" />
            </button>
          {/if}
          <button class="linkbtn" onclick={setReadAloud} title="Chat messages read aloud will use this voice">
            Use for read-aloud in chat
          </button>
        {/if}
      {:else if rail === 'voice'}
        <div class="railhead">
          <button class="back" onclick={() => (rail = 'main')}><ArrowLeft size={15} /></button>
          <span>Select a voice</span>
        </div>
        <div class="vsearch">
          <Search size={13} />
          <input placeholder="Search voices..." bind:value={vsearch} use:noAutofill />
        </div>
        <div class="filters">
          {#each ['', 'male', 'female'] as g (g)}
            <button class="chip" class:on={vgender === g} onclick={() => (vgender = g)}>{g === '' ? 'All' : cap(g)}</button>
          {/each}
          <select bind:value={vlang}>
            <option value="">Any language</option>
            {#each langs as l (l)}<option value={l}>{l}</option>{/each}
          </select>
        </div>
        <div class="vlist">
          {#each filtered as v (v.id)}
            <div class="vrow" class:sel={voiceId === v.id} onclick={() => pickVoice(v)} role="button" tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && pickVoice(v)}>
              {@render pixelAvatar(v, 24)}
              <span class="vmain"><b>{v.name}</b><small>{v.language}</small></span>
              {#if voiceId === v.id}<Check size={14} class="vcheck" />{/if}
              {#if v.custom}
                <button class="rowbtn del" title="Delete clone" onclick={(e) => removeVoice(v.id, e)}><Trash2 size={12} /></button>
              {/if}
              <button class="rowbtn" title="Preview" onclick={(e) => preview(v.emotions?.length ? `${v.id}_neutral` : v.id, e)}>
                {#if previewingId === (v.emotions?.length ? `${v.id}_neutral` : v.id)}<Square size={12} />{:else}<Play size={12} />{/if}
              </button>
            </div>
          {:else}
            <div class="none">No voices match.</div>
          {/each}
        </div>
        <button class="linkbtn" onclick={() => (rail = 'clone')} disabled={status?.mode !== 'mistral'}>
          <Mic size={13} /> Clone a new voice{status?.mode !== 'mistral' ? ' (needs the hosted engine)' : ''}
        </button>
      {:else if rail === 'emotion'}
        <div class="railhead">
          <button class="back" onclick={() => (rail = 'main')}><ArrowLeft size={15} /></button>
          <span>Select an emotion</span>
        </div>
        {#if selVoice}
          <div class="vwho">
            {@render pixelAvatar(selVoice, 30)}
            <span class="vmain"><b>{selVoice.name}</b><small>{selVoice.language}</small></span>
          </div>
          <div class="vlist">
            {#each selVoice.emotions as e (e)}
              <div class="vrow" class:sel={emotion === e} onclick={() => { emotion = e; rail = 'main'; }} role="button" tabindex="0"
                onkeydown={(ev) => ev.key === 'Enter' && (emotion = e)}>
                {@render emoGlyph(e, 20)}
                <span class="vmain"><b>{cap(e)}</b><small>{emotions[e] ?? ''}</small></span>
                {#if emotion === e}<Check size={14} class="vcheck" />{/if}
                <button class="rowbtn" title="Preview" onclick={(ev) => preview(`${selVoice.id}_${e}`, ev)}>
                  {#if previewingId === `${selVoice.id}_${e}`}<Square size={12} />{:else}<Play size={12} />{/if}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      {:else if rail === 'clone'}
        <div class="railhead">
          <button class="back" onclick={() => (rail = 'voice')}><ArrowLeft size={15} /></button>
          <span>Clone a voice</span>
        </div>
        <p class="hint">Record or upload 3–10 seconds of clear speech. Only clone voices you have permission to use.</p>
        <div class="clonerow">
          {#if recState === 'rec'}
            <button class="ghost rec" onclick={stopRec}><Square size={13} /> Stop ({recSec}s)</button>
          {:else}
            <button class="ghost" onclick={startRec}><Mic size={13} /> {recState === 'have' ? 'Re-record' : 'Record'}</button>
          {/if}
          <label class="ghost">
            <Upload size={13} /> Upload
            <input type="file" accept="audio/*" onchange={pickFile} hidden />
          </label>
        </div>
        {#if recState === 'have'}<p class="okline">Reference ready</p>{/if}
        <input class="clonename" placeholder="Voice name" bind:value={cloneName} maxlength="60" use:noAutofill />
        <button class="gen wide" disabled={cloneBusy || recState !== 'have' || !cloneName.trim()} onclick={createClone}>
          {cloneBusy ? 'Cloning…' : 'Create cloned voice'}
        </button>
      {/if}
    </aside>
  </div>

  <section class="library">
    <h2>Clips</h2>
    <div class="cliplist">
      {#each clips as c (c.id)}
        <div class="cliprow" class:active={player?.clip.id === c.id}>
          <button class="rowplay" onclick={() => (player?.clip.id === c.id ? togglePlay() : loadPlayer(c))}>
            {#if player?.clip.id === c.id && playing}<Pause size={13} />{:else}<Play size={13} />{/if}
          </button>
          <div class="cmain">
            <span class="ctext">{c.text}</span>
            <span class="cmeta mono">{c.voice_name}{c.seconds ? ` · ${c.seconds.toFixed(1)}s` : ''} · {fmtDay(c.created_at)}</span>
          </div>
          <a class="rowbtn" href={`/api/speech/clips/${c.id}/audio`} download title="Download"><Download size={13} /></a>
          <button class="rowbtn del" onclick={() => removeClip(c.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="none">Nothing generated yet.</div>
      {/each}
    </div>
  </section>
</div>

<style>
  .tts { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 28px 40px; display: flex; flex-direction: column; }
  .mono { font-family: var(--mono); }
  .dim { color: var(--text-faint); font-size: 11.5px; }
  .none { padding: 12px 4px; color: var(--text-faint); font-size: 12.5px; }
  .hint { font-size: 12px; color: var(--text-faint); line-height: 1.5; margin: 0 0 10px; }

  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
  h1 { font-size: 17px; font-weight: 650; margin: 0; display: flex; align-items: center; gap: 9px; }
  .badge {
    font-size: 10.5px; font-weight: 600; padding: 3px 8px; border-radius: 999px;
    background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent-dim);
  }
  .topright { display: flex; align-items: center; gap: 10px; }
  .counter { font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); }
  .counter.over { color: var(--red); }
  .gen {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--accent); color: var(--on-accent); border: none; cursor: pointer;
    padding: 9px 16px; border-radius: calc(10px * var(--rf)); font-size: 13px; font-weight: 650;
  }
  .gen:disabled { opacity: 0.45; cursor: default; }
  .gen.wide { width: 100%; justify-content: center; }
  .kbd { font-size: 10px; opacity: 0.65; font-weight: 500; }
  .ghost {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text-dim);
    padding: 6px 11px; border-radius: calc(9px * var(--rf)); font-size: 12px;
  }
  .ghost:hover { background: var(--bg-hover); color: var(--text); }
  .ghost.rec { color: var(--red); border-color: rgba(192, 96, 79, 0.4); }

  .setup {
    background: var(--bg-card); border: 1px solid var(--accent-dim); border-radius: calc(14px * var(--rf));
    padding: 16px 18px; margin-bottom: 16px;
  }
  .setup h3 { margin: 0 0 6px; font-size: 14px; }
  .setup p { margin: 0 0 10px; font-size: 12.5px; color: var(--text-dim); line-height: 1.55; max-width: 640px; }
  .setuprow { display: flex; gap: 8px; margin-bottom: 8px; max-width: 560px; }
  .setuprow input {
    flex: 1; background: var(--bg-input); border: 1px solid var(--border-soft); color: var(--text);
    border-radius: calc(9px * var(--rf)); padding: 8px 12px; font-size: 12.5px;
  }

  .stage { display: flex; gap: 18px; min-height: 420px; }
  .pane {
    flex: 1; min-width: 0; display: flex; flex-direction: column;
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: calc(14px * var(--rf));
    overflow: hidden;
  }
  .pane textarea {
    flex: 1; resize: none; border: none; outline: none; background: transparent; color: var(--text);
    font: inherit; font-size: 16px; line-height: 1.65; padding: 22px 24px; min-height: 260px;
  }
  .pane textarea::placeholder { color: var(--text-faint); }

  .starters { padding: 0 24px 18px; }
  .startlbl { display: block; font-size: 12px; color: var(--text-faint); margin-bottom: 8px; }
  .startchips { display: flex; flex-wrap: wrap; gap: 7px; }
  .chip {
    all: unset; cursor: pointer; font-size: 11.5px; padding: 5px 11px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text-dim);
  }
  .chip:hover { background: var(--bg-hover); color: var(--text); }
  .chip.on { color: var(--accent); border-color: var(--accent); }

  .genwait {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
    color: var(--text-dim); font-size: 13.5px; min-height: 260px;
  }
  .genspin { display: grid; grid-template-columns: repeat(3, 10px); gap: 3px; }
  .gpx {
    width: 10px; height: 10px; background: var(--accent); border-radius: 2px;
    animation: gpulse 1.1s ease-in-out infinite; animation-delay: calc(var(--i) * 90ms); opacity: 0.25;
  }
  @keyframes gpulse { 40% { opacity: 1; } }

  .playerbar {
    display: flex; align-items: center; gap: 12px;
    border-top: 1px solid var(--border-soft); background: var(--bg-raised);
    padding: 12px 16px;
  }
  .pplay {
    all: unset; cursor: pointer; display: grid; place-items: center; flex-shrink: 0;
    width: 38px; height: 38px; border-radius: calc(11px * var(--rf));
    background: var(--accent); color: var(--on-accent);
  }
  .plabel { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .ptime { font-size: 11px; color: var(--text-faint); }
  .wave { flex: 1; height: 34px; display: flex; align-items: center; gap: 1.5px; cursor: pointer; min-width: 120px; }
  .wbar { flex: 1; min-width: 1px; background: var(--border); border-radius: 1px; transition: background 80ms linear; }
  .wbar.played { background: var(--accent); }

  .rail { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; }
  .sect { font-size: 11.5px; font-weight: 600; color: var(--text-dim); margin: 4px 2px 0; }
  .card {
    all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; cursor: pointer;
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf));
    padding: 11px 13px; width: 100%;
  }
  .card:hover:not(.static) { border-color: var(--border); background: var(--bg-hover); }
  .card.static { cursor: default; }
  .cname { font-size: 13px; font-weight: 600; }
  .cmeta { font-size: 11.5px; color: var(--text-faint); flex: 1; }
  .card :global(.chev) { color: var(--text-faint); margin-left: auto; }
  .mico {
    display: grid; place-items: center; width: 26px; height: 26px; border-radius: calc(8px * var(--rf));
    background: var(--accent-glow); color: var(--accent);
  }
  .linkbtn {
    all: unset; cursor: pointer; display: flex; align-items: center; gap: 7px; justify-content: center;
    font-size: 12px; color: var(--text-dim); padding: 8px; border-radius: calc(9px * var(--rf));
    border: 1px dashed var(--border-soft);
  }
  .linkbtn:hover { color: var(--accent); border-color: var(--accent-dim); }
  .linkbtn:disabled { opacity: 0.5; cursor: default; }

  .railhead { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; padding: 2px 0 4px; }
  .back {
    all: unset; cursor: pointer; display: grid; place-items: center; width: 26px; height: 26px;
    border-radius: 999px; background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text-dim);
  }
  .back:hover { color: var(--text); background: var(--bg-hover); }
  .vsearch {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-input); border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf));
    padding: 7px 11px; color: var(--text-faint);
  }
  .vsearch input { flex: 1; background: none; border: none; outline: none; color: var(--text); font-size: 12.5px; }
  .filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .filters select {
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--text-dim);
    border-radius: 999px; font-size: 11.5px; padding: 4px 8px; max-width: 130px;
  }
  .vlist { display: flex; flex-direction: column; gap: 5px; overflow-y: auto; max-height: 380px; padding-right: 2px; }
  .vrow {
    display: flex; align-items: center; gap: 10px; cursor: pointer;
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: calc(11px * var(--rf));
    padding: 9px 11px;
  }
  .vrow:hover { background: var(--bg-hover); }
  .vrow.sel { border-color: var(--accent); }
  .vmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .vmain b { font-size: 12.5px; font-weight: 600; }
  .vmain small { font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vrow :global(.vcheck) { color: var(--accent); flex-shrink: 0; }
  .vwho {
    display: flex; align-items: center; gap: 10px; padding: 6px 2px 2px;
  }
  .rowbtn {
    all: unset; cursor: pointer; display: grid; place-items: center; flex-shrink: 0;
    width: 24px; height: 24px; border-radius: 999px; color: var(--text-faint);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
  }
  .rowbtn:hover { color: var(--accent); }
  .rowbtn.del:hover { background: rgba(192, 96, 79, 0.15); color: var(--red); border-color: rgba(192, 96, 79, 0.3); }
  .pavatar, .pemo { flex-shrink: 0; image-rendering: pixelated; border-radius: calc(6px * var(--rf)); }

  .clonerow { display: flex; gap: 8px; }
  .okline { font-size: 12px; color: var(--green); margin: 2px 0 0; }
  .clonename {
    background: var(--bg-input); border: 1px solid var(--border-soft); color: var(--text);
    border-radius: calc(9px * var(--rf)); padding: 8px 12px; font-size: 12.5px;
  }

  .library { margin-top: 26px; }
  h2 { font-size: 13px; font-weight: 600; color: var(--text-dim); margin: 0 0 10px; }
  .cliplist { display: flex; flex-direction: column; gap: 7px; }
  .cliprow {
    display: flex; align-items: center; gap: 11px;
    background: var(--bg-card); border: 1px solid var(--border-soft); border-radius: calc(11px * var(--rf));
    padding: 9px 13px;
  }
  .cliprow.active { border-color: var(--accent-dim); }
  .rowplay {
    all: unset; cursor: pointer; display: grid; place-items: center; flex-shrink: 0;
    width: 30px; height: 30px; border-radius: 999px;
    background: var(--bg-raised); border: 1px solid var(--border-soft); color: var(--accent);
  }
  .rowplay:hover { background: var(--bg-hover); }
  .cmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ctext { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmeta { font-size: 10.5px; color: var(--text-faint); }

  @media (max-width: 900px) {
    .stage { flex-direction: column; }
    .rail { width: 100%; }
  }
</style>
