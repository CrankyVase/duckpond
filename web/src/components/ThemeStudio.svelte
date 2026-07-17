<script>
  // Theme Studio — the full look-and-feel workshop. Everything previews LIVE
  // on the real app behind the dialog: preset gallery, community marketplace,
  // per-token color editing, effects (glass/glow/motion/backgrounds/scale/
  // type), layout styles, and raw custom CSS. Close without saving reverts;
  // Save persists server-side so the theme follows the account.
  import { api } from '../lib/api.js';
  import { applyPrefs, prefs, savePrefs } from '../lib/prefs.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import {
    activePresetMeta, applyTheme, isFavorite, persistTheme, resolveColors, restoreTheme,
    sanitizeEffects, snapshotTheme, theme, toggleFavorite,
  } from '../lib/theme.svelte.js';
  import {
    ALL_PRESETS, ALL_TOKENS, ANIM_MODES, BG_MODES, BROWSE_PRESETS, COLOR_GROUPS,
    DEFAULT_EFFECTS, DEFAULT_LAYOUT, FEATURED_PRESETS, FONT_OPTIONS,
    filterPresets, GLASS_MODES, LAYOUT_OPTIONS, PRESETS, TOKEN_GROUPS,
  } from '../lib/themes.js';
  import { toast } from '../lib/toast.svelte.js';
  import Brush from '@lucide/svelte/icons/brush';
  import Code from '@lucide/svelte/icons/code';
  import Download from '@lucide/svelte/icons/download';
  import Heart from '@lucide/svelte/icons/heart';
  import LayoutTemplate from '@lucide/svelte/icons/layout-template';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Save from '@lucide/svelte/icons/save';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Store from '@lucide/svelte/icons/store';
  import SwatchBook from '@lucide/svelte/icons/swatch-book';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import UploadCloud from '@lucide/svelte/icons/upload-cloud';
  import Wand2 from '@lucide/svelte/icons/wand-2';
  import X from '@lucide/svelte/icons/x';

  const TABS = [
    ['themes', 'Themes', SwatchBook],
    ['designer', 'Designer', Wand2],
    ['market', 'Market', Store],
    ['colors', 'Colors', Brush],
    ['effects', 'Effects', Sparkles],
    ['layout', 'Layout', LayoutTemplate],
    ['css', 'Custom CSS', Code],
  ];
  const PAGE_SIZE = 48;
  let tab = $state('themes');
  let snap = null;               // saved-state snapshot taken when the dialog opens
  let wasOpen = false;
  let saving = $state(false);
  let saveName = $state('');
  let cssDraft = $state('');

  // gallery filters (Dark / Light → color group + search)
  let toneFilter = $state('dark');   // all | dark | light | favorites
  let colorFilter = $state('all');   // all | blue | purple | …
  let themeQuery = $state('');
  let themeLimit = $state(PAGE_SIZE);

  // market
  let market = $state(null);     // null = not loaded yet
  let pubName = $state('');
  let pubBlurb = $state('');
  let publishing = $state(false);

  const dirty = $derived.by(() => {
    void theme.preset; void theme.colors; void theme.layout; void theme.effects;
    void theme.customCss; void theme.custom; void theme.favorites;
    return snap ? JSON.stringify(snapshotTheme()) !== JSON.stringify(snap) : false;
  });

  $effect(() => {
    if (app.themeStudioOpen && !wasOpen) {
      snap = snapshotTheme();
      cssDraft = theme.customCss;
      tab = 'themes';
      wasOpen = true;
    } else if (!app.themeStudioOpen && wasOpen) {
      // closed without saving → back to the last saved look
      if (snap && JSON.stringify(snapshotTheme()) !== JSON.stringify(snap)) restoreTheme(snap);
      wasOpen = false;
    }
  });

  $effect(() => {
    if (tab === 'market' && market === null) {
      api('/api/themes/market').then((rows) => (market = rows)).catch(() => (market = []));
    }
  });

  function pickPreset(id) {
    if (theme.preset === id) return;
    theme.preset = id;
    theme.colors = {}; // tweaks belong to the theme they were made on
    const p = ALL_PRESETS.find((x) => x.id === id);
    if (p) {
      // adopting a preset adopts its whole art direction: effects reset to
      // stock + the preset's signature, scene CSS replaces custom CSS
      theme.effects = sanitizeEffects({ ...DEFAULT_EFFECTS, ...(p.effects ?? {}) });
      theme.customCss = p.css ?? '';
      cssDraft = theme.customCss;
    }
    const c = theme.custom.find((x) => x.id === id);
    if (c) {
      if (c.layout) theme.layout = { ...DEFAULT_LAYOUT, ...c.layout };
      if (c.effects) theme.effects = sanitizeEffects(c.effects);
      if (c.css !== undefined) { theme.customCss = c.css; cssDraft = c.css; }
    }
    applyTheme();
  }

  function setToneFilter(v) { toneFilter = v; themeLimit = PAGE_SIZE; }
  function setColorFilter(v) { colorFilter = v; themeLimit = PAGE_SIZE; }
  function onThemeSearch(e) { themeQuery = e.target.value; themeLimit = PAGE_SIZE; }

  function onHeart(e, id) {
    e.stopPropagation();
    e.preventDefault();
    const on = toggleFavorite(id);
    toast(on ? 'Added to favorites' : 'Removed from favorites', 'ok', 1400);
  }

  const favSet = $derived.by(() => {
    void theme.favorites;
    return new Set(theme.favorites ?? []);
  });

  const favoritePresets = $derived.by(() => {
    void theme.favorites; void theme.custom;
    const ids = theme.favorites ?? [];
    return ids.map((id) => {
      const p = ALL_PRESETS.find((x) => x.id === id);
      if (p) return p;
      const c = theme.custom.find((x) => x.id === id);
      if (c) return { id: c.id, name: c.name, colors: customResolved(c), blurb: 'favorite', dark: true };
      return null;
    }).filter(Boolean);
  });

  /** Currently applied look (preset + live color overrides) for the top pin. */
  const appliedCard = $derived.by(() => {
    void theme.preset; void theme.colors; void theme.custom;
    const meta = activePresetMeta();
    const colors = resolveColors();
    const tweaks = Object.keys(theme.colors || {}).length;
    return {
      id: meta.id,
      name: meta.name,
      colors,
      blurb: tweaks
        ? `${tweaks} color tweak${tweaks === 1 ? '' : 's'} · applied now`
        : (meta.blurb || 'applied now'),
    };
  });

  const filteredBrowse = $derived.by(() => {
    void theme.favorites;
    let list = BROWSE_PRESETS;
    if (toneFilter === 'favorites') {
      const set = new Set(theme.favorites ?? []);
      list = ALL_PRESETS.filter((p) => set.has(p.id));
      // also include custom favorites
      for (const c of theme.custom) {
        if (set.has(c.id) && !list.some((p) => p.id === c.id)) {
          list = [...list, { id: c.id, name: c.name, colors: customResolved(c), blurb: 'your theme', dark: true, group: 'mono' }];
        }
      }
      return filterPresets(list, { mode: 'all', group: colorFilter, q: themeQuery });
    }
    return filterPresets(list, { mode: toneFilter, group: colorFilter, q: themeQuery });
  });
  const visibleBrowse = $derived(filteredBrowse.slice(0, themeLimit));
  const groupCounts = $derived.by(() => {
    void theme.favorites;
    const mode = toneFilter === 'favorites' ? 'all' : toneFilter;
    let list = BROWSE_PRESETS;
    if (toneFilter === 'favorites') {
      const set = new Set(theme.favorites ?? []);
      list = ALL_PRESETS.filter((p) => set.has(p.id));
    }
    const base = filterPresets(list, { mode, group: 'all', q: themeQuery });
    const m = { all: base.length };
    for (const [id] of COLOR_GROUPS) m[id] = 0;
    for (const p of base) m[p.group || 'mono'] = (m[p.group || 'mono'] || 0) + 1;
    return m;
  });

  function setColor(token, value) {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
    theme.colors = { ...theme.colors, [token]: value };
    applyTheme();
  }
  function resetColor(token) {
    const { [token]: _, ...rest } = theme.colors;
    theme.colors = rest;
    applyTheme();
  }

  function setLayout(key, value) {
    theme.layout = { ...theme.layout, [key]: value };
    applyTheme();
  }
  function setFx(key, value) {
    theme.effects = sanitizeEffects({ ...theme.effects, [key]: value });
    applyTheme();
  }

  function applyCss() {
    theme.customCss = cssDraft;
    applyTheme();
  }

  function saveAsCustom() {
    const name = saveName.trim();
    if (!name) return;
    const meta = activePresetMeta();
    const base = meta.custom ? theme.custom.find((c) => c.id === meta.id)?.base ?? 'pond' : meta.id;
    const baseColors = meta.custom ? { ...theme.custom.find((c) => c.id === meta.id)?.colors } : {};
    const id = `c-${Date.now().toString(36)}`;
    theme.custom = [...theme.custom, {
      id, name: name.slice(0, 40), base, colors: { ...baseColors, ...theme.colors },
      layout: { ...theme.layout }, effects: { ...theme.effects }, css: theme.customCss,
    }];
    theme.preset = id;
    theme.colors = {};
    saveName = '';
    applyTheme();
    toast(`Saved “${name}” to your themes`, 'ok');
  }

  function deleteCustom(id) {
    const c = theme.custom.find((c) => c.id === id);
    theme.custom = theme.custom.filter((c) => c.id !== id);
    if (theme.preset === id) { theme.preset = c?.base ?? 'pond'; theme.colors = {}; }
    applyTheme();
  }

  // ---- AI designer: a pinned server-side model writes themes from a brief ----
  let dMsgs = $state([]);       // { role: 'user'|'assistant', content, palette? }[]
  let dInput = $state('');
  let dBusy = $state(false);
  let dScroll = $state(null);

  const D_EXAMPLES = [
    'Rainy midnight marina — deep teal, brass lantern light',
    'Warm library at dusk, oxblood leather and reading-lamp gold',
    'Brutalist concrete with one safety-orange accent',
  ];

  function designScroll() {
    queueMicrotask(() => { if (dScroll) dScroll.scrollTop = dScroll.scrollHeight; });
  }

  /** Validate + adopt a designer theme as a custom theme, live.
   *  Reuses the current AI design entry when iterating so the shelf doesn't fill up. */
  function applyDesign(t) {
    const colors = {};
    for (const [k, v] of Object.entries(t?.colors ?? {})) {
      if (ALL_TOKENS.includes(k) && /^#[0-9a-fA-F]{6}$/.test(v)) colors[k] = v.toLowerCase();
    }
    if (Object.keys(colors).length < 10) return null;
    const layout = {};
    for (const [key, opts] of Object.entries(LAYOUT_OPTIONS)) {
      if (opts.some(([id]) => id === t?.layout?.[key])) layout[key] = t.layout[key];
    }
    const name = String(t.name ?? 'AI design').slice(0, 40) || 'AI design';
    const entry = {
      name, base: 'pond', colors,
      ...(Object.keys(layout).length ? { layout: { ...DEFAULT_LAYOUT, ...layout } } : {}),
      ...(t.effects ? { effects: sanitizeEffects(t.effects) } : {}),
      ...(typeof t.css === 'string' && t.css.trim() ? { css: t.css.slice(0, 20000) } : {}),
    };
    // iterating on an AI design: update that entry in place (pickPreset early-outs
    // when the id is unchanged, so re-apply layout/effects/css + applyTheme here)
    const curId = theme.preset;
    if (typeof curId === 'string' && curId.startsWith('ai-') && theme.custom.some((c) => c.id === curId)) {
      const next = { id: curId, ...entry };
      theme.custom = theme.custom.map((c) => (c.id === curId ? next : c));
      theme.colors = {};
      if (next.layout) theme.layout = { ...DEFAULT_LAYOUT, ...next.layout };
      if (next.effects) theme.effects = sanitizeEffects(next.effects);
      if (next.css !== undefined) { theme.customCss = next.css; cssDraft = next.css; }
      else if (!next.css) { theme.customCss = ''; cssDraft = ''; }
      applyTheme();
      return { name, colors };
    }
    const id = `ai-${Date.now().toString(36)}`;
    theme.custom = [...theme.custom, { id, ...entry }];
    pickPreset(id); // adopts the custom entry's layout/effects/css and applies live
    return { name, colors };
  }

  async function designSend(text) {
    const promptText = String(text ?? dInput).trim();
    if (!promptText || dBusy) return;
    dInput = '';
    dBusy = true;
    dMsgs = [...dMsgs, { role: 'user', content: promptText }];
    designScroll();
    try {
      const current = {
        name: activePresetMeta().name,
        colors: resolveColors(),
        layout: { ...theme.layout },
        effects: { ...theme.effects },
        ...(theme.customCss.trim() ? { css: theme.customCss } : {}),
      };
      const r = await api('/api/theme/assist', {
        method: 'POST',
        body: { prompt: promptText, history: dMsgs.slice(0, -1), current },
      });
      const applied = applyDesign(r.theme);
      dMsgs = [...dMsgs, {
        role: 'assistant',
        content: r.reply ?? 'Done.',
        palette: applied ? Object.values(applied.colors).slice(0, 8) : null,
        appliedName: applied?.name ?? null,
      }];
      if (applied) toast(`“${applied.name}” applied — Save theme to keep it`, 'ok');
    } catch (e) {
      dMsgs = [...dMsgs, { role: 'assistant', content: `Sorry — ${e.message ?? e}`, failed: true }];
    }
    dBusy = false;
    designScroll();
  }

  // ---- market ----
  async function installTheme(entry) {
    try {
      const { theme: t } = await api(`/api/themes/market/${entry.id}/install`, { method: 'POST' });
      const id = `m-${entry.id}-${Date.now().toString(36)}`;
      theme.custom = [...theme.custom.filter((c) => !c.marketId || c.marketId !== entry.id), {
        id, marketId: entry.id, name: t.name ?? entry.name, base: t.base ?? 'pond',
        colors: t.colors ?? {}, layout: t.layout, effects: t.effects, css: t.css ?? '',
      }];
      theme.preset = id;
      theme.colors = {};
      if (t.layout) theme.layout = { ...DEFAULT_LAYOUT, ...t.layout };
      if (t.effects) theme.effects = sanitizeEffects(t.effects);
      cssDraft = t.css ?? '';
      theme.customCss = cssDraft;
      applyTheme();
      market = market?.map((m) => (m.id === entry.id ? { ...m, downloads: m.downloads + 1 } : m));
      toast(`“${entry.name}” installed — Save to keep it`, 'ok');
    } catch (e) { toast(String(e.message ?? e), 'error'); }
  }

  async function publishTheme() {
    const name = pubName.trim();
    if (!name) return;
    publishing = true;
    try {
      const payload = {
        name, blurb: pubBlurb.trim(),
        theme: {
          name, base: activePresetMeta().custom ? theme.custom.find((c) => c.id === theme.preset)?.base ?? 'pond' : theme.preset,
          colors: resolveColors(), layout: { ...theme.layout }, effects: { ...theme.effects }, css: theme.customCss,
        },
      };
      const row = await api('/api/themes/market', { method: 'POST', body: payload });
      market = [row, ...(market ?? [])];
      pubName = ''; pubBlurb = '';
      toast('Published to the market', 'ok');
    } catch (e) { toast(String(e.message ?? e), 'error'); }
    publishing = false;
  }

  async function deleteMarket(entry) {
    try {
      await api(`/api/themes/market/${entry.id}`, { method: 'DELETE' });
      market = market?.filter((m) => m.id !== entry.id);
    } catch (e) { toast(String(e.message ?? e), 'error'); }
  }

  async function save() {
    saving = true;
    try {
      await persistTheme();
      snap = snapshotTheme();
      toast('Theme saved — it follows your account everywhere', 'ok');
    } catch (e) { toast(String(e.message ?? e), 'error'); }
    saving = false;
  }

  function revert() {
    if (snap) restoreTheme(snap);
    cssDraft = theme.customCss;
  }

  function resetAll() {
    theme.layout = { ...DEFAULT_LAYOUT };
    theme.effects = { ...DEFAULT_EFFECTS };
    theme.colors = {};
    theme.customCss = '';
    cssDraft = '';
    theme.preset = 'pond';
    applyTheme();
  }

  // inline style string that paints a preview card with a theme's own colors
  function previewStyle(colors) {
    return `--p-bg:${colors.bg};--p-side:${colors['bg-sidebar']};--p-card:${colors['bg-card']};`
      + `--p-raised:${colors['bg-raised']};--p-border:${colors['border-soft']};--p-text:${colors.text};`
      + `--p-dim:${colors['text-dim']};--p-accent:${colors.accent};`;
  }
  const customResolved = (c) => ({ ...(ALL_PRESETS.find((p) => p.id === c.base) ?? PRESETS[0]).colors, ...c.colors });
  const marketResolved = (m) => customResolved({ base: m.theme.base ?? 'pond', colors: m.theme.colors ?? {} });

  const resolved = $derived.by(() => {
    void theme.preset; void theme.colors; void theme.custom;
    return resolveColors();
  });
  const fx = $derived.by(() => { void theme.effects; return sanitizeEffects(theme.effects); });
  const fmtDl = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
</script>

{#snippet mock()}
  <span class="pmock">
    <span class="pside"></span>
    <span class="pmain">
      <span class="pbub u"></span>
      <span class="pbub a"></span>
      <span class="prow"><span class="pdot"></span><span class="pline"></span></span>
    </span>
  </span>
{/snippet}

{#if app.themeStudioOpen}
  <div class="overlay fade-in" onclick={() => (app.themeStudioOpen = false)} role="presentation"></div>
  <div class="studio slide-up" role="dialog" aria-label="Theme Studio">
    <div class="head">
      <div class="titles">
        <h2>Theme Studio</h2>
        <span class="sub">everything previews live — Save makes it stick</span>
      </div>
      {#if dirty}<span class="dirtydot" title="Unsaved changes">unsaved</span>{/if}
      <button class="ghost iconb" onclick={() => (app.themeStudioOpen = false)} title="Close (reverts unsaved changes)">
        <X size={16} />
      </button>
    </div>

    <div class="cols">
      <nav class="rail">
        {#each TABS as [id, label, Icon] (id)}
          <button class="railbtn" class:on={tab === id} onclick={() => (tab = id)}>
            <Icon size={15} />
            <span>{label}</span>
          </button>
        {/each}
      </nav>

      <div class="content">
        {#if tab === 'themes'}
          <div class="subhead">Applied now</div>
          <div class="gallery">
            <button class="pcard on applied" style={previewStyle(appliedCard.colors)}
              onclick={() => pickPreset(appliedCard.id)} title="Your current look">
              {@render mock()}
              <span class="pname">{appliedCard.name}<em class="nowtag">now</em></span>
              <span class="pblurb">{appliedCard.blurb}</span>
              <span class="pfav" class:on={favSet.has(appliedCard.id)} role="button" tabindex="0"
                title={favSet.has(appliedCard.id) ? 'Remove favorite' : 'Favorite'}
                onclick={(e) => onHeart(e, appliedCard.id)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onHeart(e, appliedCard.id); }}>
                <Heart size={13} fill={favSet.has(appliedCard.id) ? 'currentColor' : 'none'} />
              </span>
            </button>
          </div>

          <div class="subhead">Default</div>
          <div class="gallery">
            {#each FEATURED_PRESETS as p (p.id)}
              <button class="pcard" class:on={theme.preset === p.id} style={previewStyle(p.colors)}
                onclick={() => pickPreset(p.id)}>
                {@render mock()}
                <span class="pname">{p.name}{#if p.effects}<em class="fxdot" title="ships with effects"></em>{/if}</span>
                <span class="pblurb">{p.blurb}</span>
                <span class="pfav" class:on={favSet.has(p.id)} role="button" tabindex="0"
                  title={favSet.has(p.id) ? 'Remove favorite' : 'Favorite'}
                  onclick={(e) => onHeart(e, p.id)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onHeart(e, p.id); }}>
                  <Heart size={13} fill={favSet.has(p.id) ? 'currentColor' : 'none'} />
                </span>
              </button>
            {/each}
          </div>

          {#if favoritePresets.length}
            <div class="subhead">Favorites · {favoritePresets.length}</div>
            <div class="gallery">
              {#each favoritePresets as p (p.id)}
                <button class="pcard" class:on={theme.preset === p.id} style={previewStyle(p.colors)}
                  onclick={() => pickPreset(p.id)}>
                  {@render mock()}
                  <span class="pname">{p.name}</span>
                  <span class="pblurb">{p.blurb || 'favorite'}</span>
                  <span class="pfav on" role="button" tabindex="0" title="Remove favorite"
                    onclick={(e) => onHeart(e, p.id)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onHeart(e, p.id); }}>
                    <Heart size={13} fill="currentColor" />
                  </span>
                </button>
              {/each}
            </div>
          {/if}

          {#if theme.custom.length}
            <div class="subhead">Your themes</div>
            <div class="gallery">
              {#each theme.custom as c (c.id)}
                <button class="pcard" class:on={theme.preset === c.id} style={previewStyle(customResolved(c))}
                  onclick={() => pickPreset(c.id)}>
                  {@render mock()}
                  <span class="pname">{c.name}</span>
                  <span class="pblurb">{c.marketId ? 'from the market' : `based on ${ALL_PRESETS.find((p) => p.id === c.base)?.name ?? PRESETS.find((p) => p.id === c.base)?.name ?? '?'}`}</span>
                  <span class="pfav" class:on={favSet.has(c.id)} role="button" tabindex="0"
                    title={favSet.has(c.id) ? 'Remove favorite' : 'Favorite'}
                    onclick={(e) => onHeart(e, c.id)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onHeart(e, c.id); }}>
                    <Heart size={13} fill={favSet.has(c.id) ? 'currentColor' : 'none'} />
                  </span>
                  <span class="pdel" role="button" tabindex="0" title="Delete this theme"
                    onclick={(e) => { e.stopPropagation(); deleteCustom(c.id); }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); deleteCustom(c.id); } }}>
                    <Trash2 size={12} />
                  </span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="subhead">Browse · {filteredBrowse.length} themes</div>
          <div class="tfilters">
            <input class="tsearch" type="search" placeholder="Search themes…" value={themeQuery} oninput={onThemeSearch} />
            <div class="chiprow">
              {#each [['all', 'All'], ['dark', 'Dark'], ['light', 'Light'], ['favorites', '♥ Favorites']] as [id, label]}
                <button type="button" class="chip" class:on={toneFilter === id} onclick={() => setToneFilter(id)}>{label}</button>
              {/each}
            </div>
            <div class="chiprow wrap">
              <button type="button" class="chip" class:on={colorFilter === 'all'} onclick={() => setColorFilter('all')}>
                All colors · {groupCounts.all ?? 0}
              </button>
              {#each COLOR_GROUPS as [id, label]}
                {#if (groupCounts[id] ?? 0) > 0}
                  <button type="button" class="chip" class:on={colorFilter === id} onclick={() => setColorFilter(id)}>
                    {label} · {groupCounts[id]}
                  </button>
                {/if}
              {/each}
            </div>
          </div>

          {#if !visibleBrowse.length}
            <div class="none">
              {toneFilter === 'favorites'
                ? 'No favorites yet — tap the heart on any theme.'
                : 'No themes match — try another color or clear the search.'}
            </div>
          {:else}
            <div class="gallery">
              {#each visibleBrowse as p (p.id)}
                <button class="pcard" class:on={theme.preset === p.id} style={previewStyle(p.colors)}
                  onclick={() => pickPreset(p.id)}>
                  {@render mock()}
                  <span class="pname">{p.name}{#if p.effects}<em class="fxdot" title="ships with effects"></em>{/if}</span>
                  <span class="pblurb">{p.blurb || `${p.group || ''} · ${p.dark ? 'dark' : 'light'}`}</span>
                  <span class="pfav" class:on={favSet.has(p.id)} role="button" tabindex="0"
                    title={favSet.has(p.id) ? 'Remove favorite' : 'Favorite'}
                    onclick={(e) => onHeart(e, p.id)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onHeart(e, p.id); }}>
                    <Heart size={13} fill={favSet.has(p.id) ? 'currentColor' : 'none'} />
                  </span>
                </button>
              {/each}
            </div>
            {#if themeLimit < filteredBrowse.length}
              <button type="button" class="morebtn" onclick={() => (themeLimit += PAGE_SIZE)}>
                Show more · {filteredBrowse.length - themeLimit} left
              </button>
            {/if}
          {/if}
          <p class="hint">Heart themes to pin them under Favorites. Picking a theme clears color tweaks — save them as your own theme first (Colors tab) if you want to keep them.</p>

        {:else if tab === 'designer'}
          <div class="designer">
            <div class="dthread" bind:this={dScroll}>
              {#if !dMsgs.length}
                <div class="dhero">
                  <span class="dwand"><Wand2 size={18} /></span>
                  <div class="dherotitle">Describe a look — get a theme</div>
                  <p class="dherosub">A pinned coding model with fixed design rules writes a complete Duck Pond
                    theme from your brief and applies it live. Iterate in plain words: “darker”, “more teal”, “softer contrast”.</p>
                  <div class="dexamples">
                    {#each D_EXAMPLES as ex (ex)}
                      <button type="button" class="dex" onclick={() => designSend(ex)} disabled={dBusy}>{ex}</button>
                    {/each}
                  </div>
                </div>
              {/if}
              {#each dMsgs as m, i (i)}
                {#if m.role === 'user'}
                  <div class="dmsg user">{m.content}</div>
                {:else}
                  <div class="dmsg ai" class:failed={m.failed}>
                    <div class="dreply">{m.content}</div>
                    {#if m.palette}
                      <div class="dpal" title={m.appliedName ?? 'applied palette'}>
                        {#each m.palette as hex (hex)}
                          <span class="dsw" style="background:{hex}"></span>
                        {/each}
                        {#if m.appliedName}<span class="dname">{m.appliedName} — applied</span>{/if}
                      </div>
                    {/if}
                  </div>
                {/if}
              {/each}
              {#if dBusy}
                <div class="dmsg ai"><span class="dthinking">Designing<span class="ddots"><i>.</i><i>.</i><i>.</i></span></span></div>
              {/if}
            </div>
            <div class="dcomposer">
              <input
                placeholder={dMsgs.length ? 'Refine it… (“darker”, “more teal”, “softer contrast”)' : 'Describe a look…'}
                bind:value={dInput}
                onkeydown={(e) => { if (e.key === 'Enter') designSend(); }}
                disabled={dBusy}
              />
              <button class="primary" onclick={() => designSend()} disabled={dBusy || !dInput.trim()}>
                {dBusy ? 'Designing…' : 'Design'}
              </button>
            </div>
            <p class="hint">Everything applies live so you can look around — hit <b>Save theme</b> below to keep one.
              It lands in “Your themes” on the Themes tab, and you can fine-tune it in Colors.</p>
          </div>

        {:else if tab === 'market'}
          <div class="pubbox">
            <div class="pubfields">
              <input placeholder="theme name" bind:value={pubName} maxlength="40" />
              <input class="grow" placeholder="one-line description" bind:value={pubBlurb} maxlength="200" />
              <button class="primary" disabled={publishing || !pubName.trim()} onclick={publishTheme}>
                <UploadCloud size={14} />{publishing ? 'Publishing…' : 'Publish current look'}
              </button>
            </div>
            <p class="hint">Publishing shares your exact current look — colors, layout, effects, and custom CSS — with everyone on this pond.</p>
          </div>

          {#if market === null}
            <div class="none">Loading the market…</div>
          {:else if !market.length}
            <div class="none">Nothing published yet — be the first.</div>
          {:else}
            <div class="mgrid">
              {#each market as m (m.id)}
                <div class="mcard" style={previewStyle(marketResolved(m))}>
                  {@render mock()}
                  <div class="mmeta">
                    <span class="mname">{m.name}</span>
                    <span class="mby">by {m.author}</span>
                    <span class="mblurb">{m.blurb}</span>
                  </div>
                  <div class="mfoot">
                    <span class="mdl" title="installs"><Download size={11} /> {fmtDl(m.downloads)}</span>
                    {#if m.mine || app.user?.role === 'owner'}
                      <button class="ghost mdel" title="Remove from market" onclick={() => deleteMarket(m)}><Trash2 size={12} /></button>
                    {/if}
                    <button class="primary msml" onclick={() => installTheme(m)}>Install</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

        {:else if tab === 'colors'}
          <div class="colorhead">
            <span>Editing <b>{activePresetMeta().name}</b>{#if Object.keys(theme.colors).length}
              <em class="tweaked">{Object.keys(theme.colors).length} tweaked</em>{/if}</span>
            <div class="saveas">
              <input placeholder="save as… (name)" bind:value={saveName} maxlength="40"
                onkeydown={(e) => e.key === 'Enter' && saveAsCustom()} />
              <button disabled={!saveName.trim()} onclick={saveAsCustom}>Save theme</button>
            </div>
          </div>
          {#each TOKEN_GROUPS as g (g.label)}
            <div class="subhead">{g.label}</div>
            <div class="tokens">
              {#each g.tokens as [token, label] (token)}
                <div class="tokrow" class:tweaked={token in theme.colors}>
                  <input class="swatch" type="color" value={resolved[token]}
                    oninput={(e) => setColor(token, e.target.value)} title={`--${token}`} />
                  <span class="toklabel">{label}</span>
                  <input class="hex mono" value={resolved[token]} maxlength="7" spellcheck="false"
                    onchange={(e) => setColor(token, e.target.value.trim())} />
                  {#if token in theme.colors}
                    <button class="ghost tokreset" onclick={() => resetColor(token)} title="Back to the theme's value">
                      <RotateCcw size={12} />
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}

        {:else if tab === 'effects'}
          <div class="fxblock">
            <div class="subhead">Glass</div>
            <div class="seg" role="group" aria-label="Glass">
              {#each GLASS_MODES as [id, label, blurb] (id)}
                <button type="button" class="segbtn" class:on={fx.glass === id} onclick={() => setFx('glass', id)} title={blurb}>
                  <span class="seglabel">{label}</span>
                  <span class="segblurb">{blurb}</span>
                </button>
              {/each}
            </div>
            {#if fx.glass !== 'off'}
              <div class="sliders">
                <label>Blur <span class="val mono">{fx.glassBlur}px</span>
                  <input type="range" min="4" max="32" step="1" value={fx.glassBlur}
                    oninput={(e) => setFx('glassBlur', +e.target.value)} />
                </label>
                <label>Tint <span class="val mono">{Math.round(fx.glassOpacity * 100)}%</span>
                  <input type="range" min="0.3" max="0.92" step="0.01" value={fx.glassOpacity}
                    oninput={(e) => setFx('glassOpacity', +e.target.value)} />
                </label>
              </div>
              <p class="hint">Glass shows best over a Gradient or Animated background.</p>
            {/if}
          </div>

          <div class="fxblock">
            <div class="subhead">Background</div>
            <div class="seg" role="group" aria-label="Background">
              {#each BG_MODES as [id, label, blurb] (id)}
                <button type="button" class="segbtn" class:on={fx.bg === id} onclick={() => setFx('bg', id)} title={blurb}>
                  <span class="seglabel">{label}</span>
                  <span class="segblurb">{blurb}</span>
                </button>
              {/each}
            </div>
            {#if fx.bg !== 'solid'}
              <div class="sliders">
                <label class="colorlab">From
                  <input class="swatch" type="color" value={fx.bgA || resolved.bg}
                    oninput={(e) => setFx('bgA', e.target.value)} />
                </label>
                <label class="colorlab">To
                  <input class="swatch" type="color" value={fx.bgB || resolved['accent-dim']}
                    oninput={(e) => setFx('bgB', e.target.value)} />
                </label>
                <label>Angle <span class="val mono">{fx.bgAngle}°</span>
                  <input type="range" min="0" max="360" step="5" value={fx.bgAngle}
                    oninput={(e) => setFx('bgAngle', +e.target.value)} />
                </label>
              </div>
            {/if}
          </div>

          <div class="fxblock">
            <div class="subhead">Motion</div>
            <div class="seg" role="group" aria-label="Motion">
              {#each ANIM_MODES as [id, label, blurb] (id)}
                <button type="button" class="segbtn" class:on={fx.anim === id} onclick={() => setFx('anim', id)} title={blurb}>
                  <span class="seglabel">{label}</span>
                  <span class="segblurb">{blurb}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Experimental</div>
            <div class="seg" role="group" aria-label="Experimental">
              <button type="button" class="segbtn" class:on={!fx.lab} onclick={() => setFx('lab', false)}>
                <span class="seglabel">Off</span>
                <span class="segblurb">stock behavior</span>
              </button>
              <button type="button" class="segbtn" class:on={fx.lab} onclick={() => setFx('lab', true)}>
                <span class="seglabel">Premium motion</span>
                <span class="segblurb">entrances, soft lifts, gentle crossfades</span>
              </button>
            </div>
            <p class="hint">Early access — a quiet layer of polish: messages rise in, cards lift under the pointer, the composer breathes on focus, and theme switches crossfade. Motion: off still wins.</p>
          </div>

          <div class="fxblock">
            <div class="subhead">Accent glow</div>
            <div class="seg" role="group" aria-label="Accent glow">
              <button type="button" class="segbtn" class:on={!fx.glow} onclick={() => setFx('glow', false)}>
                <span class="seglabel">Off</span>
                <span class="segblurb">flat controls</span>
              </button>
              <button type="button" class="segbtn" class:on={fx.glow} onclick={() => setFx('glow', true)}>
                <span class="seglabel">On</span>
                <span class="segblurb">neon edges</span>
              </button>
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">UI scale</div>
            <div class="sliders">
              <label>Everything <span class="val mono">{Math.round(fx.uiScale * 100)}%</span>
                <input type="range" min="0.85" max="1.25" step="0.05" value={fx.uiScale}
                  oninput={(e) => setFx('uiScale', +e.target.value)} />
              </label>
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Typeface</div>
            <div class="seg" role="group" aria-label="Typeface">
              {#each FONT_OPTIONS as [id, label, stack] (id)}
                <button type="button" class="segbtn" class:on={fx.font === id} onclick={() => setFx('font', id)}>
                  <span class="seglabel" style={`font-family:${stack}`}>{label}</span>
                </button>
              {/each}
            </div>
          </div>

        {:else if tab === 'layout'}
          <div class="fxblock">
            <div class="subhead">Chat width</div>
            <div class="seg" role="group" aria-label="Chat width">
              {#each LAYOUT_OPTIONS.chatWidth as [id, label] (id)}
                <button type="button" class="segbtn" class:on={theme.layout.chatWidth === id}
                  onclick={() => setLayout('chatWidth', id)}>
                  <span class="seglabel">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Sidebar</div>
            <div class="seg" role="group" aria-label="Sidebar">
              {#each LAYOUT_OPTIONS.sidebar as [id, label] (id)}
                <button type="button" class="segbtn" class:on={theme.layout.sidebar === id}
                  onclick={() => setLayout('sidebar', id)}>
                  <span class="seglabel">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Corners</div>
            <div class="seg" role="group" aria-label="Corners">
              {#each LAYOUT_OPTIONS.radius as [id, label] (id)}
                <button type="button" class="segbtn" class:on={theme.layout.radius === id}
                  onclick={() => setLayout('radius', id)}>
                  <span class="seglabel">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Your messages</div>
            <div class="seg" role="group" aria-label="Your messages">
              {#each LAYOUT_OPTIONS.bubbles as [id, label] (id)}
                <button type="button" class="segbtn" class:on={theme.layout.bubbles === id}
                  onclick={() => setLayout('bubbles', id)}>
                  <span class="seglabel">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Font size</div>
            <div class="seg" role="group" aria-label="Font size">
              {#each [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] as [id, label]}
                <button type="button" class="segbtn" class:on={prefs.fontSize === id}
                  onclick={() => { prefs.fontSize = id; savePrefs(); applyPrefs(); }}>
                  <span class="seglabel">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Message spacing</div>
            <div class="seg" role="group" aria-label="Message spacing">
              {#each [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']] as [id, label]}
                <button type="button" class="segbtn" class:on={prefs.density === id}
                  onclick={() => { prefs.density = id; savePrefs(); applyPrefs(); }}>
                  <span class="seglabel">{label}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="fxblock">
            <div class="subhead">Typing caret</div>
            <div class="seg" role="group" aria-label="Typing caret">
              {#each [['beam', 'Beam', 'a thin line after the last letter'], ['block', 'Block', 'a solid block, terminal style'], ['dot', 'Dot', 'a small round pulse']] as [id, label, blurb]}
                <button type="button" class="segbtn" class:on={(prefs.caret ?? 'beam') === id}
                  onclick={() => { prefs.caret = id; savePrefs(); applyPrefs(); }} title={blurb}>
                  <span class="seglabel">{label}</span>
                  <span class="segblurb">{blurb}</span>
                </button>
              {/each}
            </div>
          </div>

        {:else}
          <p class="hint">Raw CSS appended after everything else — override any token
            (<span class="mono">--accent</span>, <span class="mono">--bg</span>, …) or any element.
            Applied on this account only; a broken rule can't outlive Reset.</p>
          <textarea class="cssbox mono" rows="14" bind:value={cssDraft} spellcheck="false"
            placeholder={':root { --accent: hotpink; }\n.ububble { border: 1px dashed var(--accent); }'}></textarea>
          <div class="cssbtns">
            <button onclick={() => { cssDraft = ''; applyCss(); }}>Clear</button>
            <button class="primary" disabled={cssDraft === theme.customCss} onclick={applyCss}>Apply CSS</button>
          </div>
        {/if}
      </div>
    </div>

    <div class="foot">
      <button onclick={revert} disabled={!dirty}><RotateCcw size={14} />Revert</button>
      <span class="grow"></span>
      <button onclick={resetAll} title="Back to stock DuckPond">Reset all</button>
      <button class="primary" onclick={save} disabled={saving || !dirty}>
        <Save size={14} />{saving ? 'Saving…' : 'Save theme'}
      </button>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; background: rgba(8, 7, 6, 0.55); z-index: 95; }
  .studio {
    position: fixed; z-index: 96; inset: 0; margin: auto;
    width: min(980px, 95vw); height: min(700px, 93vh); height: min(700px, 93dvh);
    display: flex; flex-direction: column;
    background: var(--bg-sidebar); border: 1px solid var(--border);
    border-radius: calc(16px * var(--rf)); box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px 12px; border-bottom: 1px solid var(--border-soft);
  }
  .titles { flex: 1; min-width: 0; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .sub { font-size: 11.5px; color: var(--text-faint); }
  .dirtydot {
    font-size: 10.5px; color: var(--yellow); font-family: var(--mono);
    border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent);
    padding: 2px 8px; border-radius: 999px;
  }
  .iconb { padding: 6px; display: grid; place-items: center; }

  .cols { flex: 1; min-height: 0; display: flex; }
  .rail {
    width: 152px; flex-shrink: 0; padding: 12px 10px;
    border-right: 1px solid var(--border-soft);
    display: flex; flex-direction: column; gap: 4px;
  }
  .railbtn {
    all: unset; cursor: pointer;
    display: flex; align-items: center; gap: 9px;
    padding: 8px 11px; border-radius: calc(9px * var(--rf));
    font-size: 13px; color: var(--text-dim);
    transition: background 110ms ease, color 110ms ease;
  }
  .railbtn:hover { background: var(--bg-hover); color: var(--text); }
  .railbtn.on { background: var(--bg-raised); color: var(--text); }
  .railbtn.on :global(svg) { color: var(--accent); }

  .content { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px 20px; }
  .hint { font-size: 12px; color: var(--text-faint); line-height: 1.55; margin: 12px 0 0; }
  .mono { font-family: var(--mono); }
  .none { padding: 20px 4px; color: var(--text-faint); font-size: 12.5px; }
  .subhead {
    font-size: 11px; font-weight: 600; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin: 18px 0 9px;
  }
  .subhead:first-child, .gallery:first-child { margin-top: 0; }

  .tfilters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .tsearch {
    width: 100%; font-size: 12.5px; padding: 8px 12px;
    border-radius: calc(10px * var(--rf)); border: 1px solid var(--border-soft);
    background: var(--bg-input); color: var(--text);
  }
  .tsearch::placeholder { color: var(--text-faint); }
  .chiprow { display: flex; flex-wrap: nowrap; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
  .chiprow.wrap { flex-wrap: wrap; overflow: visible; }
  .chip {
    all: unset; cursor: pointer; flex-shrink: 0;
    font-size: 11.5px; padding: 5px 10px; border-radius: 999px;
    border: 1px solid var(--border-soft); background: var(--bg-raised);
    color: var(--text-dim); transition: border-color 100ms ease, color 100ms ease, background 100ms ease;
  }
  .chip:hover { color: var(--text); border-color: var(--border); }
  .chip.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
  .morebtn {
    all: unset; cursor: pointer; display: block; width: 100%; margin-top: 12px;
    text-align: center; font-size: 12.5px; padding: 10px;
    border-radius: calc(10px * var(--rf)); border: 1px dashed var(--border);
    color: var(--text-dim); background: var(--bg-raised);
  }
  .morebtn:hover { color: var(--text); border-color: var(--accent); }

  /* ---- theme gallery ---- */
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
  .pcard {
    all: unset; cursor: pointer; position: relative;
    display: flex; flex-direction: column; gap: 3px;
    padding: 10px; border-radius: calc(10px * var(--rf));
    border: 1px solid var(--border-soft); background: var(--bg-card);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .pcard:hover { border-color: var(--border); transform: translateY(-1px); }
  .pcard.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pmock {
    display: flex; height: 88px; border-radius: 6px; overflow: hidden;
    border: 1px solid var(--p-border); background: var(--p-bg);
    margin-bottom: 7px;
  }
  .pside { width: 24%; background: var(--p-side); border-right: 1px solid var(--p-border); }
  .pmain { flex: 1; padding: 9px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .pbub { display: block; height: 12px; border-radius: 4px; }
  .pbub.u { width: 55%; align-self: flex-end; background: var(--p-card); border: 1px solid var(--p-border); }
  .pbub.a { width: 78%; background: color-mix(in srgb, var(--p-text) 14%, transparent); }
  .prow { display: flex; align-items: center; gap: 5px; width: 100%; margin-top: auto; }
  .pdot { width: 11px; height: 11px; border-radius: 50%; background: var(--p-accent); flex-shrink: 0; }
  .pline { flex: 1; height: 7px; border-radius: 3px; background: var(--p-raised); }
  .pname {
    font-size: 12.5px; font-weight: 600; color: var(--text);
    display: flex; align-items: center; gap: 6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .fxdot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent); flex-shrink: 0; }
  .pblurb {
    font-size: 10.5px; color: var(--text-faint); line-height: 1.35;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pdel {
    position: absolute; top: 7px; right: 7px;
    display: grid; place-items: center; width: 20px; height: 20px;
    border-radius: 6px; color: var(--text-faint); background: var(--bg-raised);
    opacity: 0; transition: opacity 120ms ease;
  }
  .pcard:hover .pdel { opacity: 0.9; }
  .pdel:hover { color: var(--red); background: var(--red-soft); }
  .pfav {
    position: absolute; top: 7px; left: 7px;
    display: grid; place-items: center; width: 22px; height: 22px;
    border-radius: 6px; color: var(--text-faint);
    background: color-mix(in srgb, var(--bg-raised) 85%, transparent);
    opacity: 0.55; transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
  }
  .pcard:hover .pfav { opacity: 1; }
  .pfav:hover { color: var(--red); }
  .pfav.on {
    opacity: 1; color: #e85d6a;
    background: color-mix(in srgb, #e85d6a 16%, var(--bg-raised));
  }
  .pcard:has(.pdel) .pfav { /* heart left, delete right */ }
  .pcard.applied { max-width: 200px; }
  .nowtag {
    font-style: normal; font-size: 10px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--on-accent); background: var(--accent);
    padding: 1px 6px; border-radius: 999px; line-height: 1.4;
  }

  /* ---- AI designer ---- */
  .designer { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .dthread {
    display: flex; flex-direction: column; gap: 8px;
    min-height: 260px; max-height: 380px; overflow-y: auto;
    padding: 4px 2px;
  }
  .dhero { text-align: center; padding: 28px 18px 18px; margin: auto; }
  .dwand {
    display: inline-grid; place-items: center;
    width: 40px; height: 40px; border-radius: calc(12px * var(--rf));
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
    margin-bottom: 12px;
  }
  .dherotitle { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .dherosub { font-size: 12.5px; color: var(--text-faint); line-height: 1.55; max-width: 420px; margin: 0 auto 14px; }
  .dexamples { display: flex; flex-direction: column; gap: 6px; max-width: 380px; margin: 0 auto; }
  .dex {
    all: unset; cursor: pointer;
    font-size: 12px; color: var(--text-dim); text-align: left;
    padding: 8px 12px; border-radius: calc(10px * var(--rf));
    background: var(--bg-raised); border: 1px solid var(--border-soft);
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .dex:hover { color: var(--text); background: var(--bg-hover); border-color: var(--border); }
  .dmsg { max-width: 85%; font-size: 13px; line-height: 1.5; }
  .dmsg.user {
    align-self: flex-end;
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--accent-dim) 22%, var(--border-soft));
    border-radius: calc(14px * var(--rf)) calc(14px * var(--rf)) calc(5px * var(--rf)) calc(14px * var(--rf));
    padding: 8px 13px;
  }
  .dmsg.ai {
    align-self: flex-start;
    background: var(--bg-raised);
    border: 1px solid var(--border-soft);
    border-radius: calc(14px * var(--rf)) calc(14px * var(--rf)) calc(14px * var(--rf)) calc(5px * var(--rf));
    padding: 9px 13px;
  }
  .dmsg.ai.failed { border-color: color-mix(in srgb, var(--red) 30%, var(--border-soft)); color: var(--text-dim); }
  .dpal { display: flex; align-items: center; gap: 5px; margin-top: 8px; }
  .dsw {
    width: 18px; height: 18px; border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .dpal .dname { font-size: 11px; color: var(--text-faint); margin-left: 4px; }
  .dthinking { color: var(--text-faint); font-family: var(--mono); font-size: 12px; }
  .ddots i { animation: ddot 1.2s ease-in-out infinite; font-style: normal; }
  .ddots i:nth-child(2) { animation-delay: 0.18s; }
  .ddots i:nth-child(3) { animation-delay: 0.36s; }
  @keyframes ddot { 0%, 60%, 100% { opacity: 0.2; } 30% { opacity: 1; } }
  .dcomposer { display: flex; gap: 8px; }
  .dcomposer input { flex: 1; min-width: 0; font-size: 13px; }
  .dcomposer .primary { flex-shrink: 0; }
  .designer .hint b { color: var(--text-dim); font-weight: 600; }

  /* ---- market ---- */
  .pubbox {
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(12px * var(--rf)); padding: 12px 14px; margin-bottom: 16px;
  }
  .pubfields { display: flex; gap: 8px; flex-wrap: wrap; }
  .pubfields input { font-size: 12.5px; padding: 7px 11px; }
  .pubfields .grow { flex: 1; min-width: 160px; }
  .pubfields button { display: flex; align-items: center; gap: 7px; font-size: 12.5px; }
  .pubbox .hint { margin-top: 8px; }
  .mgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
  .mcard {
    display: flex; flex-direction: column; gap: 2px;
    padding: 10px; border-radius: calc(12px * var(--rf));
    border: 1px solid var(--border-soft); background: var(--bg-card);
  }
  .mmeta { display: flex; flex-direction: column; gap: 1px; padding: 2px 2px 6px; }
  .mname { font-size: 13px; font-weight: 600; }
  .mby { font-size: 10.5px; color: var(--accent); font-family: var(--mono); }
  .mblurb { font-size: 11px; color: var(--text-faint); line-height: 1.45; margin-top: 3px; min-height: 2.7em; }
  .mfoot { display: flex; align-items: center; gap: 8px; margin-top: auto; }
  .mdl {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--text-dim); font-family: var(--mono); flex: 1;
  }
  .msml { font-size: 12px; padding: 5px 12px; }
  .mdel { padding: 5px; display: grid; place-items: center; color: var(--text-faint); }
  .mdel:hover { color: var(--red); }

  /* ---- colors ---- */
  .colorhead {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    font-size: 13px; color: var(--text-dim); flex-wrap: wrap;
  }
  .colorhead b { color: var(--text); }
  .tweaked {
    font-style: normal; font-size: 10.5px; color: var(--accent);
    border: 1px solid var(--accent-dim); border-radius: 999px; padding: 1px 7px; margin-left: 8px;
  }
  .saveas { display: flex; gap: 7px; }
  .saveas input { font-size: 12.5px; padding: 6px 10px; width: 150px; }
  .saveas button { font-size: 12.5px; }
  .tokens { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; }
  @media (max-width: 700px) { .tokens { grid-template-columns: 1fr; } }
  .tokrow {
    display: flex; align-items: center; gap: 9px;
    padding: 4px 6px; border-radius: 8px;
  }
  .tokrow:hover { background: var(--bg-hover); }
  .tokrow.tweaked .toklabel { color: var(--accent); }
  .swatch {
    -webkit-appearance: none; appearance: none;
    width: 26px; height: 26px; padding: 0; border: 1px solid var(--border);
    border-radius: 7px; background: none; cursor: pointer; flex-shrink: 0;
  }
  .swatch::-webkit-color-swatch-wrapper { padding: 2px; }
  .swatch::-webkit-color-swatch { border: none; border-radius: 5px; }
  .swatch::-moz-color-swatch { border: none; border-radius: 5px; }
  .toklabel { flex: 1; font-size: 12.5px; color: var(--text-dim); }
  .hex { width: 76px; font-size: 11.5px; padding: 4px 8px; text-align: center; }
  .tokreset { padding: 4px; display: grid; place-items: center; color: var(--text-faint); }
  .tokreset:hover { color: var(--text); }

  /* ---- layout option cards (compact, not soft blobs) ---- */
  .optrow { display: flex; gap: 8px; flex-wrap: wrap; }
  .opt {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 10px 14px 8px; font-size: 12px; color: var(--text-dim);
    background: var(--bg-card); border: 1px solid var(--border-soft);
    border-radius: calc(8px * var(--rf)); min-width: 86px;
  }
  .opt.on { border-color: var(--accent); color: var(--text); box-shadow: 0 0 0 1px var(--accent); }
  .opt.wide { min-width: 118px; }
  .opt small { font-size: 10px; color: var(--text-faint); line-height: 1.3; }
  .diagram {
    width: 54px; height: 34px; border-radius: 4px;
    background: var(--bg-input); border: 1px solid var(--border-soft);
    display: flex; align-items: center; justify-content: center;
    padding: 5px; gap: 3px; position: relative; overflow: hidden;
  }
  .dcol { height: 100%; background: var(--accent-dim); border-radius: 2px; }
  .w-narrow { width: 34%; } .w-normal { width: 52%; } .w-wide { width: 74%; } .w-full { width: 96%; }
  .side-left, .side-right { justify-content: stretch; }
  .side-right { flex-direction: row-reverse; }
  .dside { width: 26%; height: 100%; background: var(--accent-dim); border-radius: 2px; }
  .dbody { flex: 1; height: 100%; background: var(--bg-hover); border-radius: 2px; }
  .dbox { width: 60%; height: 80%; background: var(--bg-hover); border: 1.5px solid var(--accent-dim); }
  .r-sharp { border-radius: 1px; } .r-soft { border-radius: 6px; } .r-round { border-radius: 12px; }
  .dbub { width: 70%; height: 55%; }
  .b-bubbles { background: var(--bg-hover); border: 1.5px solid var(--accent-dim); border-radius: 8px 8px 3px 8px; }
  .b-minimal { background: transparent; border-left: 3px solid var(--accent-dim); border-radius: 0; }
  .selrow { display: flex; gap: 22px; flex-wrap: wrap; }
  .selrow label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-dim); }
  .selrow select { font-size: 13px; padding: 6px 10px; }

  /* Effects: crisp segmented rows — no soft glass-blob previews */
  .fxblock { margin-bottom: 4px; }
  .fxblock .subhead { margin-top: 14px; }
  .fxblock:first-child .subhead { margin-top: 0; }
  .seg {
    display: flex; flex-wrap: wrap; gap: 0;
    border: 1px solid var(--border-soft); border-radius: calc(8px * var(--rf));
    overflow: hidden; background: var(--bg-card);
  }
  .segbtn {
    all: unset; cursor: pointer; flex: 1 1 0; min-width: 96px;
    display: flex; flex-direction: column; gap: 2px;
    padding: 10px 12px; text-align: left;
    border-right: 1px solid var(--border-soft);
    color: var(--text-dim); transition: background 100ms ease, color 100ms ease;
  }
  .segbtn:last-child { border-right: none; }
  .segbtn:hover { background: var(--bg-hover); color: var(--text); }
  .segbtn.on {
    background: color-mix(in srgb, var(--accent) 16%, var(--bg-card));
    color: var(--text);
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .seglabel { font-size: 12.5px; font-weight: 600; line-height: 1.25; }
  .segblurb { font-size: 10.5px; color: var(--text-faint); line-height: 1.3; }
  .segbtn.on .segblurb { color: var(--text-dim); }

  .sliders { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 10px; align-items: flex-end; }
  .sliders label {
    display: flex; flex-direction: column; gap: 7px;
    font-size: 12px; color: var(--text-dim); min-width: 170px;
  }
  .sliders .val { color: var(--text); float: right; margin-left: 8px; }
  .sliders .colorlab { min-width: 0; flex-direction: row; align-items: center; gap: 9px; }

  /* ---- custom css ---- */
  .cssbox {
    width: 100%; margin-top: 12px; resize: vertical;
    font-size: 12px; line-height: 1.55; min-height: 220px;
  }
  .cssbtns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
  .cssbtns button { font-size: 12.5px; }

  .foot {
    display: flex; align-items: center; gap: 9px;
    padding: 12px 18px; border-top: 1px solid var(--border-soft);
  }
  .foot button { display: flex; align-items: center; gap: 7px; font-size: 13px; }
  .grow { flex: 1; }

  @media (max-width: 768px) {
    .studio {
      width: 100%;
      max-width: 100vw;
      height: 100%;
      height: 100dvh;
      max-height: 100dvh;
      border-radius: 0;
      border: none;
      margin: 0;
      inset: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      overflow: hidden;
      box-sizing: border-box;
    }
    .head {
      padding: 10px 12px;
      gap: 8px;
      flex-shrink: 0;
      min-width: 0;
    }
    h2 { font-size: 15px; }
    .sub { display: none; } /* reclaim header height */
    .iconb { min-width: 40px; min-height: 40px; flex-shrink: 0; }

    .cols {
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    /* 2×3 tab grid so every tab fits — no horizontal hang-off */
    .rail {
      width: 100%;
      max-width: 100%;
      display: grid !important;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px;
      overflow: visible;
      border-right: none;
      border-bottom: 1px solid var(--border-soft);
      padding: 8px;
      box-sizing: border-box;
      flex-shrink: 0;
    }
    .railbtn {
      flex: none;
      width: 100%;
      min-width: 0;
      justify-content: center;
      white-space: nowrap;
      padding: 8px 4px;
      min-height: 40px;
      font-size: 11px;
      gap: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .railbtn span {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .content {
      padding: 12px 12px 16px;
      -webkit-overflow-scrolling: touch;
      min-width: 0;
      max-width: 100%;
      overflow-x: hidden;
    }

    /* fill the phone width — single cards span full; many use 2-col */
    .gallery {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .gallery:has(> :only-child) {
      grid-template-columns: 1fr;
    }
    .pcard {
      padding: 8px; min-width: 0; width: 100%;
      max-width: none !important; /* undo .pcard.applied desktop cap */
      box-sizing: border-box;
    }
    .pcard.applied { max-width: none; }
    .pmock { height: 72px; }
    .pname { font-size: 12px; }
    .pblurb { font-size: 10px; }
    .pfav, .pdel { opacity: 0.85; }

    .mgrid {
      grid-template-columns: 1fr;
      gap: 10px;
    }

    /* color editor: full-width rows, full 7-char hex */
    .tokens { grid-template-columns: 1fr; gap: 2px; }
    .tokrow { padding: 8px 4px; gap: 10px; }
    .hex {
      width: 5.6em;
      min-width: 5.6em;
      font-size: 12.5px;
      padding: 6px 6px;
    }
    .swatch { width: 32px; height: 32px; }
    .saveas { width: 100%; }
    .saveas input { flex: 1; width: auto; min-width: 0; }

    /* segmented option grids: clean 2-column on phones */
    .seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
    }
    .segbtn {
      min-width: 0;
      flex: none;
      border-right: 1px solid var(--border-soft);
      border-bottom: 1px solid var(--border-soft);
      padding: 12px 10px;
    }
    .segbtn:nth-child(2n) { border-right: none; }
    .segbtn:last-child { border-right: none; }
    /* drop bottom border on last row */
    .segbtn:nth-last-child(-n+2) { border-bottom: none; }
    .seg:has(> .segbtn:only-child),
    .seg:has(> .segbtn:nth-child(2):last-child) .segbtn { border-bottom: none; }

    .sliders { flex-direction: column; gap: 12px; }
    .sliders label { min-width: 0; width: 100%; }

    .chiprow { gap: 6px; padding-bottom: 4px; }
    .chip { padding: 7px 11px; font-size: 12px; min-height: 34px; }

    .foot {
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 10px;
      padding-bottom: max(8px, env(safe-area-inset-bottom));
      flex-shrink: 0;
      min-width: 0;
    }
    .foot button {
      font-size: 12px;
      padding: 10px 10px;
      min-height: 42px;
      flex: 1 1 auto;
      justify-content: center;
    }
    .foot .grow { display: none; } /* free space between buttons on phone */
    .pubfields { flex-direction: column; }
    .pubfields .grow { min-width: 0; width: 100%; }
    .tsearch { font-size: 16px; box-sizing: border-box; }
    .cssbox { min-height: 160px; max-width: 100%; box-sizing: border-box; }
  }

  @media (max-width: 380px) {
    .gallery { grid-template-columns: 1fr; }
    .rail { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .railbtn { font-size: 10.5px; padding: 8px 2px; }
    /* "Custom CSS" is long — keep icon + short if needed */
    .segbtn { padding: 10px 8px; }
    .seglabel { font-size: 12px; }
    .segblurb { font-size: 10px; }
  }
</style>
