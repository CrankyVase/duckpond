<script>
  // Theme Studio — the full look-and-feel workshop. Everything previews LIVE
  // on the real app behind the dialog: preset gallery (mini mock previews),
  // per-token color editing, layout styles, and raw custom CSS. Close without
  // saving reverts to the last saved look; Save persists server-side so the
  // theme follows the account (and into Duck Pond Control).
  import { applyPrefs, prefs, savePrefs } from '../lib/prefs.svelte.js';
  import { app } from '../lib/state.svelte.js';
  import {
    activePresetMeta, applyTheme, persistTheme, resolveColors, restoreTheme, snapshotTheme, theme,
  } from '../lib/theme.svelte.js';
  import { DEFAULT_LAYOUT, LAYOUT_OPTIONS, PRESETS, TOKEN_GROUPS } from '../lib/themes.js';
  import { toast } from '../lib/toast.svelte.js';
  import Brush from '@lucide/svelte/icons/brush';
  import Code from '@lucide/svelte/icons/code';
  import LayoutTemplate from '@lucide/svelte/icons/layout-template';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Save from '@lucide/svelte/icons/save';
  import SwatchBook from '@lucide/svelte/icons/swatch-book';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import X from '@lucide/svelte/icons/x';

  const TABS = [
    ['themes', 'Themes', SwatchBook],
    ['colors', 'Colors', Brush],
    ['layout', 'Layout', LayoutTemplate],
    ['css', 'Custom CSS', Code],
  ];
  let tab = $state('themes');
  let snap = null;               // saved-state snapshot taken when the dialog opens
  let wasOpen = false;
  let saving = $state(false);
  let saveName = $state('');
  let cssDraft = $state('');

  const dirty = $derived.by(() => {
    void theme.preset; void theme.colors; void theme.layout; void theme.customCss; void theme.custom;
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

  function pickPreset(id) {
    if (theme.preset === id) return;
    theme.preset = id;
    theme.colors = {}; // tweaks belong to the theme they were made on
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
    theme.custom = [...theme.custom, { id, name: name.slice(0, 40), base, colors: { ...baseColors, ...theme.colors } }];
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

  // inline style string that paints a preview card with a theme's own colors
  function previewStyle(colors) {
    return `--p-bg:${colors.bg};--p-side:${colors['bg-sidebar']};--p-card:${colors['bg-card']};`
      + `--p-raised:${colors['bg-raised']};--p-border:${colors['border-soft']};--p-text:${colors.text};`
      + `--p-dim:${colors['text-dim']};--p-accent:${colors.accent};`;
  }
  const customResolved = (c) => ({ ...(PRESETS.find((p) => p.id === c.base) ?? PRESETS[0]).colors, ...c.colors });

  const resolved = $derived.by(() => {
    void theme.preset; void theme.colors; void theme.custom;
    return resolveColors();
  });
</script>

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
                <span class="pmock">
                  <span class="pside"></span>
                  <span class="pmain">
                    <span class="pbub u"></span>
                    <span class="pbub a"></span>
                    <span class="prow"><span class="pdot"></span><span class="pline"></span></span>
                  </span>
                </span>
                <span class="pname">{p.name}</span>
                <span class="pblurb">{p.blurb}</span>
              </button>
            {/each}
          </div>

          {#if theme.custom.length}
            <div class="subhead">Your themes</div>
            <div class="gallery">
              {#each theme.custom as c (c.id)}
                {@const cc = customResolved(c)}
                <button class="pcard" class:on={theme.preset === c.id} style={previewStyle(cc)}
                  onclick={() => pickPreset(c.id)}>
                  <span class="pmock">
                    <span class="pside"></span>
                    <span class="pmain">
                      <span class="pbub u"></span>
                      <span class="pbub a"></span>
                      <span class="prow"><span class="pdot"></span><span class="pline"></span></span>
                    </span>
                  </span>
                  <span class="pname">{c.name}</span>
                  <span class="pblurb">based on {PRESETS.find((p) => p.id === c.base)?.name ?? '?'}</span>
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
      <button onclick={() => { theme.layout = { ...DEFAULT_LAYOUT }; theme.colors = {}; theme.customCss = ''; cssDraft = ''; theme.preset = 'pond'; applyTheme(); }}
        title="Back to stock DuckPond">Reset all</button>
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
    width: min(880px, 94vw); height: min(640px, 92vh);
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
  .pname { font-size: 12.5px; font-weight: 600; color: var(--text); }
  .pblurb { font-size: 10.5px; color: var(--text-faint); line-height: 1.35; }
  .pdel {
    position: absolute; top: 7px; right: 7px;
    display: grid; place-items: center; width: 20px; height: 20px;
    border-radius: 6px; color: var(--text-faint); background: var(--bg-raised);
    opacity: 0; transition: opacity 120ms ease;
  }
  .pcard:hover .pdel { opacity: 0.9; }
  .pdel:hover { color: var(--red); background: var(--red-soft); }

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

  /* ---- layout ---- */
  .optrow { display: flex; gap: 8px; flex-wrap: wrap; }
  .opt {
    display: flex; flex-direction: column; align-items: center; gap: 7px;
    padding: 10px 14px 8px; font-size: 12px; color: var(--text-dim);
    background: var(--bg-card); border: 1px solid var(--border-soft);
    min-width: 86px;
  }
  .opt.on { border-color: var(--accent); color: var(--text); box-shadow: 0 0 0 1px var(--accent); }
  .diagram {
    width: 54px; height: 34px; border-radius: 6px;
    background: var(--bg-input); border: 1px solid var(--border-soft);
    display: flex; align-items: center; justify-content: center;
    padding: 5px; gap: 3px;
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
