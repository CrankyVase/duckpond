<script>
  // Quick-add presets: curated OpenAI-compatible providers that all have free
  // models — paste an API key, click Add, the catalog syncs itself.
  // Backend: GET /api/providers/presets + POST /api/providers { preset, api_key }.
  import { api } from '../lib/api.js';
  import { toast } from '../lib/toast.svelte.js';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Plus from '@lucide/svelte/icons/plus';
  import Sparkles from '@lucide/svelte/icons/sparkles';

  let { isOwner = false, onadded } = $props();

  let presets = $state(null);
  let keys = $state({});    // preset key → api key input value
  let adding = $state({});  // preset key → bool

  $effect(() => {
    api('/api/providers/presets')
      .then((rows) => { presets = rows; })
      .catch(() => { presets = []; });
  });

  const remaining = $derived((presets ?? []).filter((pr) => !pr.added));

  async function add(pr) {
    const api_key = String(keys[pr.key] ?? '').trim();
    if (!api_key || adding[pr.key]) return;
    adding = { ...adding, [pr.key]: true };
    try {
      const r = await api('/api/providers', { method: 'POST', body: { preset: pr.key, api_key } });
      if (r.sync?.ok) toast(`${pr.name} added — ${r.sync.count} models imported`, 'ok');
      else if (r.sync?.error) toast(`${pr.name} added, but the first sync failed: ${r.sync.error}`, 'error', 6000);
      else toast(`${pr.name} added`, 'ok');
      keys = { ...keys, [pr.key]: '' };
      presets = (presets ?? []).map((x) => (x.key === pr.key ? { ...x, added: true } : x));
      onadded?.(r);
    } catch (e) {
      toast(`Couldn't add ${pr.name}: ${e.error ?? e.message ?? e}`, 'error', 5000);
    } finally {
      adding = { ...adding, [pr.key]: false };
    }
  }
</script>

{#if isOwner && remaining.length}
  <section class="presets">
    <h2 class="subhead"><Sparkles size={13} /> Quick add — free-model starters</h2>
    <p class="hint">Curated OpenAI-compatible providers with free models. Paste an API key and you're
      done — the catalog imports itself, grouped in the picker under the provider's name.</p>
    <div class="presetgrid">
      {#each remaining as pr (pr.key)}
        <div class="preset">
          <div class="ptop">
            <span class="pname">{pr.name}</span>
            {#if pr.freeOnly}<span class="freebadge">free-only import</span>{/if}
            <a class="keylink" href={pr.keyUrl} target="_blank" rel="noreferrer">
              get a key <ExternalLink size={11} />
            </a>
          </div>
          <p class="pblurb">{pr.blurb}</p>
          <div class="pform">
            <input type="password" placeholder="API key" autocomplete="off"
              value={keys[pr.key] ?? ''}
              oninput={(e) => { keys = { ...keys, [pr.key]: e.target.value }; }} />
            <button class="addb" onclick={() => add(pr)}
              disabled={adding[pr.key] || !String(keys[pr.key] ?? '').trim()}>
              <Plus size={13} />{adding[pr.key] ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .presets {
    background: var(--bg-card);
    border: 1px solid var(--border-soft);
    border-radius: var(--rf, 12px);
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .subhead {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; font-weight: 600; color: var(--text);
    margin: 0 0 6px;
  }
  .hint { font-size: 12px; color: var(--text-faint); margin: 0 0 12px; }
  .presetgrid {
    display: grid; gap: 10px;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }
  .preset {
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--bg-hover) 30%, transparent);
  }
  .ptop { display: flex; align-items: center; gap: 8px; }
  .pname { font-size: 13px; font-weight: 600; color: var(--text); }
  .freebadge {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 40%, transparent);
    border-radius: 999px; padding: 1px 7px;
  }
  .keylink {
    margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
    font-size: 11px; color: var(--accent); text-decoration: none;
  }
  .keylink:hover { text-decoration: underline; }
  .pblurb { font-size: 11.5px; color: var(--text-dim); margin: 6px 0 10px; line-height: 1.45; }
  .pform { display: flex; gap: 6px; }
  .pform input {
    flex: 1; min-width: 0;
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 6px 9px;
    color: var(--text); font-size: 12px;
  }
  .pform input:focus { outline: none; border-color: var(--accent); }
  .addb {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--accent); color: var(--bg-card, #111);
    border: none; border-radius: 8px; padding: 6px 12px;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .addb:hover:not(:disabled) { background: var(--accent-deep, var(--accent)); }
  .addb:disabled { opacity: 0.45; cursor: default; }
</style>
