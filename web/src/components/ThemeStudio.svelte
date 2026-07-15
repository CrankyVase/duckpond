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
    activePresetMeta, applyTheme, persistTheme, resolveColors, restoreTheme,
    sanitizeEffects, snapshotTheme, theme,
  } from '../lib/theme.svelte.js';
  import {
    ANIM_MODES, BG_MODES, DEFAULT_EFFECTS, DEFAULT_LAYOUT, FONT_OPTIONS,
    GLASS_MODES, LAYOUT_OPTIONS, PRESETS, TOKEN_GROUPS,
  } from '../lib/themes.js';
  import { toast } from '../lib/toast.svelte.js';
  import Brush from '@lucide/svelte/icons/brush';
  import Code from '@lucide/svelte/icons/code';
  import Download from '@lucide/svelte/icons/download';
  import LayoutTemplate from '@lucide/svelte/icons/layout-template';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Save from '@lucide/svelte/icons/save';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Store from '@lucide/svelte/icons/store';
  import SwatchBook from '@lucide/svelte/icons/swatch-book';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import UploadCloud from '@lucide/svelte/icons/upload-cloud';
  import X from '@lucide/svelte/icons/x';

  const TABS = [
    ['themes', 'Themes', SwatchBook],
    ['market', 'Market', Store],
    ['colors', 'Colors', Brush],
    ['effects', 'Effects', Sparkles],
    ['layout', 'Layout', LayoutTemplate],
    ['css', 'Custom CSS', Code],
  ];
  let tab = $state('themes');
  let snap = null;               // saved-state snapshot taken when the dialog opens
  let wasOpen = false;
  let saving = $state(false);
  let saveName = $state('');
  let cssDraft = $state('');

  // market
  let market = $state(null);     // null = not loaded yet
  let pubName = $state('');
  let pubBlurb = $state('');
  let publishing = $state(false);

  const dirty = $derived.by(() => {
    void theme.preset; void theme.colors; void theme.layout; void theme.effects;
    void theme.customCss; void theme.custom;
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
    const p = PRESETS.find((x) => x.id === id);
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
  const customResolved = (c) => ({ ...(PRESETS.find((p) => p.id === c.base) ?? PRESETS[0]).colors, ...c.colors });
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
          <div class="gallery">
            {#each PRESETS as p (p.id)}
              <button class="pcard" class:on={theme.preset === p.id} style={previewStyle(p.colors)}
                onclick={() => pickPreset(p.id)}>
                {@render mock()}
                <span class="pname">{p.name}{#if p.effects}<em class="fxdot" title="ships with effects"></em>{/if}</span>
                <span class="pblurb">{p.blurb}</span>
              </button>
            {/each}
          </div>

          {#if theme.custom.length}
            <div class="subhead">Your themes</div>
            <div class="gallery">
              {#each theme.custom as c (c.id)}
                <button class="pcard" class:on={theme.preset === c.id} style={previewStyle(customResolved(c))}
                  onclick={() => pickPreset(c.id)}>
                  {@render mock()}
                  <span class="pname">{c.name}</span>
                  <span class="pblurb">{c.marketId ? 'from the market' : `based on ${PRESETS.find((p) => p.id === c.base)?.name ?? '?'}`}</span>
                  <span class="pdel" role="button" tabindex="0" title="Delete this theme"
                    onclick={(e) => { e.stopPropagation(); deleteCustom(c.id); }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); deleteCustom(c.id); } }}>
                    <Trash2 size={12} />
                  </span>
                </button>
              {/each}
            </div>
          {/if}
          <p class="hint">Picking a theme clears color tweaks — save them as your own theme first (Colors tab) if you want to keep them.</p>

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
          <div class="subhead">Glass</div>
          <div class="optrow">
            {#each GLASS_MODES as [id, label, blurb] (id)}
              <button class="opt wide" class:on={fx.glass === id} onclick={() => setFx('glass', id)}>
                <span class="diagram glassd g-{id}"><span class="gback"></span><span class="gpane"></span></span>
                <span>{label}</span><small>{blurb}</small>
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
            <p class="hint">Glass shows best over a Gradient or Animated background (below).</p>
          {/if}

          <div class="subhead">Background</div>
          <div class="optrow">
            {#each BG_MODES as [id, label, blurb] (id)}
              <button class="opt wide" class:on={fx.bg === id} onclick={() => setFx('bg', id)}>
                <span class="diagram bgd b-{id}"></span>
                <span>{label}</span><small>{blurb}</small>
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

          <div class="subhead">Motion</div>
          <div class="optrow">
            {#each ANIM_MODES as [id, label, blurb] (id)}
              <button class="opt wide" class:on={fx.anim === id} onclick={() => setFx('anim', id)}>
                <span class="diagram animd a-{id}"><span class="aball"></span></span>
                <span>{label}</span><small>{blurb}</small>
              </button>
            {/each}
          </div>

          <div class="subhead">Accent glow</div>
          <div class="optrow">
            <button class="opt wide" class:on={!fx.glow} onclick={() => setFx('glow', false)}>
              <span class="diagram"><span class="gbtn"></span></span><span>Off</span><small>flat controls</small>
            </button>
            <button class="opt wide" class:on={fx.glow} onclick={() => setFx('glow', true)}>
              <span class="diagram"><span class="gbtn lit"></span></span><span>On</span><small>neon edges</small>
            </button>
          </div>

          <div class="subhead">UI scale</div>
          <div class="sliders">
            <label>Everything <span class="val mono">{Math.round(fx.uiScale * 100)}%</span>
              <input type="range" min="0.85" max="1.25" step="0.05" value={fx.uiScale}
                oninput={(e) => setFx('uiScale', +e.target.value)} />
            </label>
          </div>

          <div class="subhead">Typeface</div>
          <div class="optrow">
            {#each FONT_OPTIONS as [id, label, stack] (id)}
              <button class="opt wide" class:on={fx.font === id} onclick={() => setFx('font', id)}>
                <span class="diagram fontd" style={`font-family:${stack}`}>Aa</span>
                <span>{label}</span>
              </button>
            {/each}
          </div>

        {:else if tab === 'layout'}
          <div class="subhead">Chat width</div>
          <div class="optrow">
            {#each LAYOUT_OPTIONS.chatWidth as [id, label] (id)}
              <button class="opt" class:on={theme.layout.chatWidth === id} onclick={() => setLayout('chatWidth', id)}>
                <span class="diagram"><span class="dcol w-{id}"></span></span>{label}
              </button>
            {/each}
          </div>
          <div class="subhead">Sidebar</div>
          <div class="optrow">
            {#each LAYOUT_OPTIONS.sidebar as [id, label] (id)}
              <button class="opt" class:on={theme.layout.sidebar === id} onclick={() => setLayout('sidebar', id)}>
                <span class="diagram side-{id}"><span class="dside"></span><span class="dbody"></span></span>{label}
              </button>
            {/each}
          </div>
          <div class="subhead">Corners</div>
          <div class="optrow">
            {#each LAYOUT_OPTIONS.radius as [id, label] (id)}
              <button class="opt" class:on={theme.layout.radius === id} onclick={() => setLayout('radius', id)}>
                <span class="diagram"><span class="dbox r-{id}"></span></span>{label}
              </button>
            {/each}
          </div>
          <div class="subhead">Your messages</div>
          <div class="optrow">
            {#each LAYOUT_OPTIONS.bubbles as [id, label] (id)}
              <button class="opt" class:on={theme.layout.bubbles === id} onclick={() => setLayout('bubbles', id)}>
                <span class="diagram"><span class="dbub b-{id}"></span></span>{label}
              </button>
            {/each}
          </div>
          <div class="subhead">Type</div>
          <div class="selrow">
            <label>Font size
              <select bind:value={prefs.fontSize} onchange={() => { savePrefs(); applyPrefs(); }}>
                <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
              </select>
            </label>
            <label>Message spacing
              <select bind:value={prefs.density} onchange={() => { savePrefs(); applyPrefs(); }}>
                <option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option>
              </select>
            </label>
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
    width: min(980px, 95vw); height: min(700px, 93vh);
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

  /* ---- theme gallery ---- */
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 10px; }
  .pcard {
    all: unset; cursor: pointer; position: relative;
    display: flex; flex-direction: column; gap: 2px;
    padding: 9px; border-radius: calc(12px * var(--rf));
    border: 1px solid var(--border-soft); background: var(--bg-card);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .pcard:hover { border-color: var(--border); transform: translateY(-1px); }
  .pcard.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pmock {
    display: flex; height: 74px; border-radius: 8px; overflow: hidden;
    border: 1px solid var(--p-border); background: var(--p-bg);
    margin-bottom: 6px;
  }
  .pside { width: 26%; background: var(--p-side); border-right: 1px solid var(--p-border); }
  .pmain { flex: 1; padding: 8px; display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .pbub { display: block; height: 11px; border-radius: 5px; }
  .pbub.u { width: 55%; align-self: flex-end; background: var(--p-card); border: 1px solid var(--p-border); }
  .pbub.a { width: 78%; background: color-mix(in srgb, var(--p-text) 14%, transparent); }
  .prow { display: flex; align-items: center; gap: 5px; width: 100%; margin-top: auto; }
  .pdot { width: 12px; height: 12px; border-radius: 50%; background: var(--p-accent); flex-shrink: 0; }
  .pline { flex: 1; height: 7px; border-radius: 4px; background: var(--p-raised); }
  .pname { font-size: 12.5px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
  .fxdot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent); }
  .pblurb { font-size: 10.5px; color: var(--text-faint); line-height: 1.35; }
  .pdel {
    position: absolute; top: 7px; right: 7px;
    display: grid; place-items: center; width: 20px; height: 20px;
    border-radius: 6px; color: var(--text-faint); background: var(--bg-raised);
    opacity: 0; transition: opacity 120ms ease;
  }
  .pcard:hover .pdel { opacity: 0.9; }
  .pdel:hover { color: var(--red); background: var(--red-soft); }

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

  /* ---- layout + effects option cards ---- */
  .optrow { display: flex; gap: 8px; flex-wrap: wrap; }
  .opt {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 10px 14px 8px; font-size: 12px; color: var(--text-dim);
    background: var(--bg-card); border: 1px solid var(--border-soft);
    min-width: 86px;
  }
  .opt.on { border-color: var(--accent); color: var(--text); box-shadow: 0 0 0 1px var(--accent); }
  .opt.wide { min-width: 118px; }
  .opt small { font-size: 10px; color: var(--text-faint); line-height: 1.3; }
  .diagram {
    width: 54px; height: 34px; border-radius: 6px;
    background: var(--bg-input); border: 1px solid var(--border-soft);
    display: flex; align-items: center; justify-content: center;
    padding: 5px; gap: 3px; position: relative; overflow: hidden;
  }
  .dcol { height: 100%; background: var(--accent-dim); border-radius: 3px; }
  .w-narrow { width: 34%; } .w-normal { width: 52%; } .w-wide { width: 74%; } .w-full { width: 96%; }
  .side-left, .side-right { justify-content: stretch; }
  .side-right { flex-direction: row-reverse; }
  .dside { width: 26%; height: 100%; background: var(--accent-dim); border-radius: 3px; }
  .dbody { flex: 1; height: 100%; background: var(--bg-hover); border-radius: 3px; }
  .dbox { width: 60%; height: 80%; background: var(--bg-hover); border: 1.5px solid var(--accent-dim); }
  .r-sharp { border-radius: 1px; } .r-soft { border-radius: 6px; } .r-round { border-radius: 12px; }
  .dbub { width: 70%; height: 55%; }
  .b-bubbles { background: var(--bg-hover); border: 1.5px solid var(--accent-dim); border-radius: 8px 8px 3px 8px; }
  .b-minimal { background: transparent; border-left: 3px solid var(--accent-dim); border-radius: 0; }
  .selrow { display: flex; gap: 22px; flex-wrap: wrap; }
  .selrow label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-dim); }
  .selrow select { font-size: 13px; padding: 6px 10px; }

  /* effects diagrams */
  .glassd .gback {
    position: absolute; inset: 4px 22px 4px 5px;
    background: linear-gradient(135deg, var(--accent-dim), var(--bg-hover)); border-radius: 4px;
  }
  .glassd .gpane { position: absolute; inset: 6px 5px 6px 18px; border-radius: 4px; border: 1px solid var(--border); }
  .g-off .gpane { background: var(--bg-card); }
  .g-frosted .gpane { background: color-mix(in srgb, var(--bg-card) 55%, transparent); backdrop-filter: blur(3px); }
  .g-liquid .gpane {
    background: color-mix(in srgb, var(--bg-card) 38%, transparent); backdrop-filter: blur(6px) saturate(1.5);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  .bgd { padding: 0; }
  .b-solid { background: var(--bg-hover); }
  .b-gradient { background: linear-gradient(135deg, var(--accent-dim), var(--bg-hover)); }
  .b-animated {
    background: linear-gradient(135deg, var(--accent-dim), var(--bg-hover), var(--accent-dim));
    background-size: 300% 300%; animation: dstudioDrift 3s ease-in-out infinite alternate;
  }
  @keyframes dstudioDrift { from { background-position: 0% 0%; } to { background-position: 100% 100%; } }
  .animd .aball { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .a-off .aball { opacity: 0.4; }
  .a-subtle .aball { animation: dstudioPulse 2s ease infinite; }
  .a-full .aball { animation: dstudioBounce 1.1s cubic-bezier(0.5, 0, 0.5, 1) infinite alternate; }
  @keyframes dstudioPulse { 50% { opacity: 0.35; } }
  @keyframes dstudioBounce { from { transform: translateX(-14px); } to { transform: translateX(14px); } }
  .gbtn { width: 26px; height: 12px; border-radius: 4px; background: var(--accent-deep); }
  .gbtn.lit { box-shadow: 0 0 10px var(--accent), 0 0 3px var(--accent); background: var(--accent); }
  .fontd { font-size: 16px; color: var(--text); font-weight: 600; }

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
</style>
