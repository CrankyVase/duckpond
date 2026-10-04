// Theme definitions for the Theme Studio. A theme is a flat map of color
// tokens (CSS custom properties, sans the -- prefix). Presets are complete;
// user customization stores per-token OVERRIDES on top of a preset, so a
// preset can evolve without wiping everyone's tweaks.

// token metadata drives the color editor UI — order here is display order
export const TOKEN_GROUPS = [
  {
    label: 'Backgrounds',
    tokens: [
      ['bg', 'App background'],
      ['bg-sidebar', 'Sidebar'],
      ['bg-raised', 'Buttons & chips'],
      ['bg-card', 'Cards & bubbles'],
      ['bg-hover', 'Hover'],
      ['bg-input', 'Inputs'],
      ['bg-code', 'Code blocks'],
      ['bg-code-inline', 'Inline code'],
    ],
  },
  {
    label: 'Borders',
    tokens: [
      ['border', 'Border'],
      ['border-soft', 'Soft border'],
    ],
  },
  {
    label: 'Text',
    tokens: [
      ['text', 'Text'],
      ['text-dim', 'Dim text'],
      ['text-faint', 'Faint text'],
    ],
  },
  {
    label: 'Accent',
    tokens: [
      ['accent', 'Accent'],
      ['accent-deep', 'Accent deep'],
      ['accent-dim', 'Accent dim'],
      ['on-accent', 'Text on accent'],
    ],
  },
  {
    label: 'Status',
    tokens: [
      ['green', 'Good / alive'],
      ['yellow', 'Warning'],
      ['red', 'Error / danger'],
    ],
  },
];

export const ALL_TOKENS = TOKEN_GROUPS.flatMap((g) => g.tokens.map(([t]) => t));

// non-color extras a preset can set (fall back to the dark default)
export const DARK_SHADOW = '0 16px 48px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.35)';
export const LIGHT_SHADOW = '0 16px 48px rgba(70, 55, 30, 0.16), 0 4px 12px rgba(70, 55, 30, 0.10)';


// ---- signature scene CSS, baked into showcase presets (picking the preset
// adopts these into Custom CSS where the user can read/tweak/delete them) ----

export const SCENE_SYNTHWAVE = '';

export const SCENE_ABYSS = '';

export const SCENE_EMBER = '';

export const SCENE_NIGHTSHADE = '';

export const SCENE_PHOSPHOR = '';

// Built-in handcrafted presets. `pond` is the default/featured original.
// Everything else is browsable under Dark/Light → color group.
export const PRESETS = [
  {
    id: 'pond',
    name: 'Duck Pond',
    dark: true,
    group: 'mono',
    featured: true,
    category: 'featured',
    blurb: 'Flat graphite with a warm duck-bill accent',
    colors: {
      'bg': '#212121', 'bg-sidebar': '#171717', 'bg-raised': '#2f2f2f', 'bg-card': '#2a2a2a',
      'bg-hover': '#2c2c2c', 'bg-input': '#2f2f2f', 'bg-code': '#161616', 'bg-code-inline': '#303030',
      'border': '#3d3d3d', 'border-soft': '#2e2e2e',
      'text': '#ececec', 'text-dim': '#b4b4b4', 'text-faint': '#8a8a8a',
      'accent': '#ffb23e', 'accent-deep': '#f29a1a', 'accent-dim': '#7a5a24', 'on-accent': '#1a1200',
      'green': '#4ade80', 'yellow': '#fbbf24', 'red': '#f87171',
      'scrollbar': '#454545',
    },
  },
];

// Bulk catalog from scripts/import-vsc-themes.mjs (popular marketplace packs → tokens).

/** Color-group labels for the gallery filters (order = display order). */
export const COLOR_GROUPS = [
  ['blue', 'Blue'],
  ['teal', 'Teal'],
  ['green', 'Green'],
  ['purple', 'Purple'],
  ['pink', 'Pink'],
  ['red', 'Red'],
  ['orange', 'Orange'],
  ['gold', 'Gold'],
  ['mono', 'Mono'],
  ['oled', 'OLED'],
];

/** Default featured theme (original Duck Pond look). */
export const DEFAULT_PRESET_ID = 'pond';

/** Every selectable preset: handcrafted + catalog. */
export const ALL_PRESETS = PRESETS;

/** Featured only (shown pinned at top). */
export const FEATURED_PRESETS = ALL_PRESETS.filter((p) => p.featured || p.id === DEFAULT_PRESET_ID);

/** Everything else, for Dark/Light → color browsing. */
export const BROWSE_PRESETS = ALL_PRESETS.filter((p) => !p.featured && p.id !== DEFAULT_PRESET_ID);

export const LAYOUT_OPTIONS = {
  chatWidth: [
    ['narrow', 'Narrow', '640px'],
    ['normal', 'Normal', '780px'],
    ['wide', 'Wide', '1000px'],
    ['full', 'Full', 'min(96%, 1600px)'],
  ],
  sidebar: [
    ['left', 'Left'],
    ['right', 'Right'],
  ],
  radius: [
    ['sharp', 'Sharp', 0.35],
    ['soft', 'Soft', 1],
    ['round', 'Round', 1.5],
  ],
  bubbles: [
    ['bubbles', 'Bubbles'],
    ['minimal', 'Minimal'],
  ],
};

export const DEFAULT_LAYOUT = { chatWidth: 'normal', sidebar: 'left', radius: 'soft', bubbles: 'bubbles' };

// ---- effects: glass, glow, motion, backgrounds, scale, type ----
export const GLASS_MODES = [
  ['off', 'Off', 'solid surfaces'],
  ['frosted', 'Frosted', 'soft blur, quiet tint'],
  ['liquid', 'Liquid', 'deep blur, wet shine'],
];
export const ANIM_MODES = [
  ['off', 'Off', 'no motion at all'],
  ['subtle', 'Subtle', 'the stock fades'],
  ['full', 'Full', 'lively hovers & entrances'],
];
export const BG_MODES = [
  ['solid', 'Solid', 'flat theme background'],
];
export const FONT_OPTIONS = [
  ['default', 'Pond', "'Inter Variable', 'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif"],
  ['rounded', 'Rounded', "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Quicksand', sans-serif"],
  ['serif', 'Serif', "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif"],
  ['mono', 'Terminal', "'JetBrains Mono', ui-monospace, Menlo, monospace"],
];

export const DEFAULT_EFFECTS = {
  glass: 'off',        // off | frosted | liquid
  glassBlur: 14,       // px, 4..32
  glassOpacity: 0.6,   // surface tint strength, 0.3..0.92
  glow: false,         // accent glow on primary controls
  anim: 'subtle',      // off | subtle | full
  lab: false,          // experimental premium motion pack
  bg: 'solid',         // flat background
  bgA: '', bgB: '',    // gradient stops ('' → derived from the theme)
  bgAngle: 160,        // degrees
  uiScale: 1,          // 0.85..1.25
  font: 'default',
};

export const presetById = (id) => ALL_PRESETS.find((p) => p.id === id) ?? PRESETS[0];

/** Filter browse presets by mode (all|dark|light), color group, and free-text. */
export function filterPresets(list, { mode = 'all', group = 'all', q = '' } = {}) {
  const query = String(q || '').trim().toLowerCase();
  return list.filter((p) => {
    if (mode === 'dark' && !p.dark) return false;
    if (mode === 'light' && p.dark) return false;
    if (group !== 'all' && (p.group || 'mono') !== group) return false;
    if (query && !`${p.name} ${p.blurb || ''} ${p.group || ''}`.toLowerCase().includes(query)) return false;
    return true;
  });
}
