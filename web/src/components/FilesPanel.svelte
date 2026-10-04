<script>
  // Files library: generated images, chat uploads, docs, AI exports,
  // project workspaces — delete anything, respect the 15 GB per-user cap.
  import { api } from '../lib/api.js';
  import { confirmDialog } from '../lib/confirm.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import FileText from '@lucide/svelte/icons/file-text';
  import Folder from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Download from '@lucide/svelte/icons/download';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';

  let data = $state(null);
  let loading = $state(true);
  let tab = $state('images'); // images | uploads | docs | exports | projects
  let lightbox = $state(null);
  async function load() {
    loading = true;
    try {
      data = await api('/api/files');
    } catch (err) {
      toast(err.message ?? 'Could not load files', 'error');
    }
    loading = false;
  }

  $effect(() => { if (app.view === 'files') load(); });

  async function remove(kind, id) {
    const ok = await confirmDialog({
      title: 'Delete this permanently?',
      message: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      if (kind === 'image') await api(`/api/images/${id}`, { method: 'DELETE' });
      else if (kind === 'upload') await api(`/api/uploads/${id}`, { method: 'DELETE' });
      else if (kind === 'doc') await api(`/api/docs/${id}`, { method: 'DELETE' });
      else if (kind === 'export') await api(`/api/files/exports/${encodeURIComponent(id)}`, { method: 'DELETE' });
      else if (kind === 'workspace') await api(`/api/files/workspaces/${id}`, { method: 'DELETE' });
      toast('Deleted', 'ok');
      await load();
    } catch (err) {
      toast(err.message ?? 'delete failed', 'error');
    }
  }

  const counts = $derived({
    images: data?.images?.length ?? 0,
    uploads: data?.uploads?.length ?? 0,
    docs: data?.docs?.length ?? 0,
    exports: data?.exports?.length ?? 0,
    projects: data?.workspaces?.length ?? 0,
  });
  const quota = $derived(data?.quota);
</script>

<div class="files">
  <header class="head">
    <div class="title">
      <div>
        <h1>Files</h1>
        <p>Generated images, uploads, docs, and projects the AI made — 15 GB per account.</p>
      </div>
    </div>
    <button class="ghost refresh" onclick={load} title="Refresh" disabled={loading}>
      <RefreshCw size={15} />
    </button>
  </header>

  {#if quota}
    <div class="quota" class:hot={quota.pct > 90} class:warn={quota.pct > 75 && quota.pct <= 90}>
      <div class="qbar"><div class="qfill" style="width: {Math.min(100, quota.pct)}%"></div></div>
      <span class="qlbl">{quota.used_label} / {quota.limit_label} used ({quota.pct}%)</span>
    </div>
  {/if}

  <div class="tabs">
    <button class:on={tab === 'images'} onclick={() => (tab = 'images')}>
      <ImageIcon size={14} /> Images <em>{counts.images}</em>
    </button>
    <button class:on={tab === 'uploads'} onclick={() => (tab = 'uploads')}>
      <Upload size={14} /> Uploads <em>{counts.uploads}</em>
    </button>
    <button class:on={tab === 'docs'} onclick={() => (tab = 'docs')}>
      <FileText size={14} /> Docs <em>{counts.docs}</em>
    </button>
    <button class:on={tab === 'exports'} onclick={() => (tab = 'exports')}>
      <Download size={14} /> Exports <em>{counts.exports}</em>
    </button>
    <button class:on={tab === 'projects'} onclick={() => (tab = 'projects')}>
      <Folder size={14} /> Projects <em>{counts.projects}</em>
    </button>
  </div>

  {#if loading && !data}
    <div class="empty">Loading…</div>
  {:else if tab === 'images'}
    {#if data?.images?.length}
      <button class="create-link" type="button" onclick={() => (app.view = 'media')}>
        <Sparkles size={16} /> Create images in Media Studio <span aria-hidden="true">→</span>
      </button>
    {/if}

    <div class="gallery">
      {#each data?.images ?? [] as im (im.id)}
        <figure class="card">
          <button class="thumb" onclick={() => (lightbox = im)}>
            <img src={im.url} alt={im.name} loading="lazy" />
          </button>
          <button class="del" onclick={() => remove('image', im.id)} title="Delete"><Trash2 size={13} /></button>
          <figcaption>
            <span class="cap" title={im.prompt}>{im.name}</span>
            <span class="meta">{im.model ?? '—'} · {im.size_label}</span>
          </figcaption>
        </figure>
      {:else}
        <div class="empty image-empty"><ImageIcon size={30} /><h2>Your images will appear here</h2><p>Make an image in Media Studio, then return to browse or remove it.</p><button type="button" onclick={() => (app.view = 'media')}>Open Media Studio <span aria-hidden="true">→</span></button></div>
      {/each}
    </div>
  {:else if tab === 'uploads'}
    <div class="list">
      {#each data?.uploads ?? [] as u (u.id)}
        <div class="row">
          <a class="thumb sm" href={u.url} target="_blank" rel="noreferrer">
            <img src={u.url} alt={u.name} loading="lazy" />
          </a>
          <div class="info">
            <div class="name">{u.name}</div>
            <div class="meta">{u.width_height} · {u.size_label}</div>
            {#if u.description}<div class="desc">{u.description}</div>{/if}
          </div>
          <button class="del" onclick={() => remove('upload', u.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="empty">No chat image uploads yet — attach images from the composer paperclip.</div>
      {/each}
    </div>
  {:else if tab === 'docs'}
    <div class="list">
      {#each data?.docs ?? [] as d (d.id)}
        <div class="row">
          <span class="ico"><FileText size={16} /></span>
          <div class="info">
            <div class="name">{d.name}</div>
            <div class="meta">{d.chunks} sections · {d.size_label}</div>
          </div>
          <button class="del" onclick={() => remove('doc', d.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="empty">No documents attached yet.</div>
      {/each}
    </div>
  {:else if tab === 'exports'}
    <div class="list">
      {#each data?.exports ?? [] as e (e.id)}
        <div class="row">
          <span class="ico"><Download size={16} /></span>
          <div class="info">
            <a class="name" href={e.url} download>{e.name}</a>
            <div class="meta">{e.ext?.toUpperCase()} · {e.size_label}</div>
          </div>
          <button class="del" onclick={() => remove('export', e.id)} title="Delete"><Trash2 size={13} /></button>
        </div>
      {:else}
        <div class="empty">No exports yet — when the AI makes a deck or CSV it lands here.</div>
      {/each}
    </div>
  {:else if tab === 'projects'}
    <div class="list">
      {#each data?.workspaces ?? [] as w (w.id)}
        <div class="row">
          <span class="ico"><Folder size={16} /></span>
          <div class="info">
            <div class="name">{w.name}</div>
            <div class="meta">{w.files} files · {w.size_label} · {w.status}</div>
          </div>
          <button class="del" onclick={() => remove('workspace', w.id)} title="Delete project files">
            <Trash2 size={13} />
          </button>
        </div>
      {:else}
        <div class="empty">No project workspaces yet — start a coding task in chat.</div>
      {/each}
    </div>
  {/if}
</div>

{#if lightbox}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="lb" onclick={() => (lightbox = null)} onkeydown={(e) => { if (e.key === 'Escape') lightbox = null; }} role="dialog" tabindex="-1" aria-label="Image preview">
    <img src={lightbox.url} alt={lightbox.name} />
    <p>{lightbox.prompt}</p>
  </div>
{/if}

<style>
  .files {
    flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 30px 36px 48px; max-width: 1400px; width: 100%; margin: 0 auto;
    padding-bottom: max(48px, calc(24px + env(safe-area-inset-bottom)));
    box-sizing: border-box;
  }

  .head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    margin-bottom: 16px;
  }
  .title { display: flex; align-items: center; gap: 14px; }
  h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.035em; }
  .title p { margin: 3px 0 0; font-size: 13px; color: var(--text-dim); }
  .refresh { padding: 8px; border-radius: 9px; }

  .quota {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 16px; padding: 10px 14px;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf));
  }
  .quota.hot { border-color: var(--red); }
  .quota.warn { border-color: var(--yellow); }
  .qbar {
    flex: 1; height: 8px; border-radius: 999px; background: var(--bg-input); overflow: hidden;
  }
  .qfill {
    height: 100%; border-radius: 999px;
    background: var(--accent);
    transition: width 200ms ease;
  }
  .quota.hot .qfill { background: var(--red); }
  .qlbl { font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); white-space: nowrap; }

  .tabs {
    display: flex; flex-wrap: wrap; gap: 0; margin-bottom: 18px;
    width: fit-content; max-width: 100%;
    border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf));
    overflow: hidden; background: var(--bg-card);
  }
  .tabs button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; font-size: 12.5px; font-weight: 500;
    border-radius: 0; background: transparent; border: none;
    border-right: 1px solid var(--border-soft);
    color: var(--text-dim);
    transition: background 120ms ease, color 120ms ease;
  }
  .tabs button:last-child { border-right: none; }
  .tabs button:hover { color: var(--text); background: var(--bg-hover); }
  .tabs button.on {
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-card));
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .tabs em {
    font-style: normal; font-family: var(--mono); font-size: 11px;
    color: var(--text-faint); font-variant-numeric: tabular-nums;
  }

  .create-link { display:flex; align-items:center; gap:10px; width:fit-content; min-height:44px; margin:0 0 30px; padding:10px 15px; border:1px solid var(--border-soft); border-radius:10px; background:var(--bg-raised); color:var(--text); font-size:13px; cursor:pointer; }
  .create-link:hover { border-color:var(--accent-dim); background:var(--bg-hover); }
  .create-link span { margin-left:12px; color:var(--text-faint); }

  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .card {
    position: relative; margin: 0;
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf)); overflow: hidden;
    transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
  }
  .card:hover {
    transform: translateY(-2px);
    border-color: var(--border);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
  }
  .thumb {
    all: unset; cursor: pointer; display: block; width: 100%;
    aspect-ratio: 1; background: var(--bg-input);
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb.sm {
    width: 56px; height: 56px; aspect-ratio: auto; border-radius: 10px; overflow: hidden; flex-shrink: 0;
  }
  figcaption { padding: 8px 10px 10px; }
  .cap {
    display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .meta { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
  .card .del {
    position: absolute; top: 6px; right: 6px;
    padding: 5px; border-radius: 8px;
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    color: var(--text-dim); border: 1px solid var(--border-soft);
  }
  .card .del:hover { color: var(--red); }

  .list { display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px; border-radius: calc(12px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    transition: background 140ms ease, border-color 140ms ease;
  }
  .row:hover { background: var(--bg-hover); border-color: var(--border); }
  .ico {
    width: 28px; height: 28px; flex-shrink: 0;
    display: grid; place-items: center;
    color: var(--text-faint);
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    border-radius: calc(8px * var(--rf));
  }
  .info { flex: 1; min-width: 0; }
  .name {
    font-size: 13.5px; font-weight: 500; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-decoration: none;
  }
  a.name:hover { color: var(--accent); }
  .desc {
    font-size: 12px; color: var(--text-dim); margin-top: 3px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .row .del {
    padding: 6px; border-radius: 8px; color: var(--text-faint); background: transparent; border: none;
  }
  .row .del:hover { color: var(--red); background: var(--bg-hover); }

  .empty {
    padding: 36px 16px; text-align: center; color: var(--text-faint); font-size: 13.5px;
  }
  .image-empty { grid-column: 1 / -1; display:flex; flex-direction:column; align-items:center; gap:10px; }
  .image-empty :global(svg) { color:var(--accent); }
  .image-empty h2 { margin:0; color:var(--text); font-size:17px; font-weight:600; }
  .image-empty p { margin:0 0 8px; max-width:340px; line-height:1.5; }
  .image-empty button { min-height:40px; padding:0 14px; border:1px solid var(--border); border-radius:9px; background:var(--bg-raised); color:var(--text); }
  .image-empty button:hover { border-color:var(--accent); }

  .lb {
    position: fixed; inset: 0; z-index: 80;
    background: rgba(0,0,0,0.72); display: grid; place-items: center;
    padding: 24px; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    cursor: zoom-out;
    animation: fadeIn 160ms ease;
  }
  .lb img {
    max-width: min(92vw, 960px); max-height: 80vh; max-height: 80dvh;
    border-radius: 12px; box-shadow: var(--shadow);
  }
  .lb p {
    position: absolute; bottom: max(20px, env(safe-area-inset-bottom));
    left: 50%; transform: translateX(-50%);
    max-width: 80vw; margin: 0; font-size: 12.5px; color: #eee;
    background: rgba(0,0,0,0.55); padding: 8px 14px; border-radius: 999px;
  }

  @media (max-width: 768px) {
    .files {
      padding: 12px 12px 28px;
      padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom)));
      max-width: 100%;
      width: 100%;
      box-sizing: border-box;
      overflow-x: hidden;
    }
    .head {
      flex-wrap: nowrap;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 12px;
    }
    .title {
      flex: 1 1 auto;
      min-width: 0;
      gap: 10px;
    }
    .title h1 { font-size: 18px; }
    .title p {
      font-size: 12px;
      line-height: 1.4;
      /* allow multi-line instead of blowing layout */
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .refresh {
      flex-shrink: 0;
      min-width: 40px;
      min-height: 40px;
      align-self: flex-start;
    }
    .quota {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 10px 12px;
    }
    .qlbl {
      white-space: normal;
      font-size: 11px;
      text-align: right;
    }
    .tabs {
      gap: 0;
      width: 100%;
      overflow-x: auto;
      flex-wrap: nowrap;
      -webkit-overflow-scrolling: touch;
      margin-bottom: 14px;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tabs button {
      flex-shrink: 0;
      padding: 10px 12px;
      min-height: 40px;
      font-size: 12.5px;
    }
    .gallery {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .row {
      gap: 10px;
      padding: 10px 0;
    }
    .name {
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  @media (max-width: 380px) {
    .gallery { grid-template-columns: 1fr; }
  }

  .files { max-width: 1180px; }
  .head { margin-bottom: 20px; }
  .title p { margin-top: 8px; line-height: 1.6; }
  .empty { margin: 20px 0; padding: 64px 24px; border: 1px dashed var(--border); border-radius: calc(10px * var(--rf)); line-height: 1.7; }
  @media(max-width: 768px) { .files { padding: 24px 16px; } .title h1 { font-size: 25px; } }
  .quota { background: none; border: 0; padding: 0; gap: 12px; margin-bottom: 20px; }
  .qbar { max-width: 220px; height: 4px; }
  .qlbl { font-family: var(--sans); font-size: 12px; }
  .tabs { width: 100%; flex-wrap: nowrap; overflow-x: auto; border: 0; border-bottom: 1px solid var(--border-soft); border-radius: 0; background: none; gap: 24px; margin-bottom: 18px; }
  .tabs button { flex-shrink: 0; border: 0; border-bottom: 2px solid transparent; padding: 12px 0; gap: 8px; }
  .tabs button.on { box-shadow: none; background: none; border-bottom-color: var(--text); }
  .tabs em { background: var(--bg-raised); padding: 0 5px; border-radius: 4px; }
  .list { border: 1px solid var(--border-soft); border-radius: calc(10px * var(--rf)); overflow: hidden; }
  .row { border-radius: 0; padding: 14px 18px; gap: 14px; border-bottom: 1px solid var(--border-soft); }
  .row:last-child { border-bottom: 0; }
  .ico { width: 38px; height: 42px; display: grid; place-items: center; border: 1px solid var(--border-soft); border-radius: calc(6px * var(--rf)); color: var(--text-dim); }
  .name { font-size: 13px; font-weight: 500; }
  .meta { font-size: 11px; margin-top: 4px; }
  .row .del { opacity: .6; }
  .row:focus-within .del { opacity: 1; }
  @media(max-width: 768px) { .quota { flex-wrap: wrap; } .tabs { gap: 20px; } .row { padding: 16px; } }
</style>
