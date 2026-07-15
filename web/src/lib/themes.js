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

export const PRESETS = [
  {
    id: 'pond',
    name: 'Pond at Dusk',
    dark: true,
    blurb: 'the original — warm near-black, duck-bill tan',
    colors: {
      'bg': '#0e0d0c', 'bg-sidebar': '#141312', 'bg-raised': '#1b1917', 'bg-card': '#1d1b19',
      'bg-hover': '#262320', 'bg-input': '#191817', 'bg-code': '#11100e', 'bg-code-inline': '#201d1a',
      'border': '#2c2925', 'border-soft': '#221f1c',
      'text': '#ede8dc', 'text-dim': '#a59d8e', 'text-faint': '#6f695e',
      'accent': '#c89968', 'accent-deep': '#a67c52', 'accent-dim': '#7d5f3e', 'on-accent': '#16110a',
      'green': '#6b9e5a', 'yellow': '#cfa74f', 'red': '#c0604f',
      'scrollbar': '#35312c',
    },
  },
  {
    id: 'mallard',
    name: 'Mallard',
    dark: true,
    blurb: 'deep pond greens, jade accent',
    colors: {
      'bg': '#0a100e', 'bg-sidebar': '#0e1512', 'bg-raised': '#16201b', 'bg-card': '#182219',
      'bg-hover': '#222d26', 'bg-input': '#131c17', 'bg-code': '#0b110e', 'bg-code-inline': '#1a241e',
      'border': '#2a382f', 'border-soft': '#1f2b24',
      'text': '#e4ece5', 'text-dim': '#9cab9e', 'text-faint': '#6b7a6e',
      'accent': '#7fc796', 'accent-deep': '#5aa274', 'accent-dim': '#40745a', 'on-accent': '#071009',
      'green': '#7fb069', 'yellow': '#c9b458', 'red': '#c0604f',
      'scrollbar': '#2c3a31',
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    dark: true,
    blurb: 'cool graphite, steel-blue accent',
    colors: {
      'bg': '#0e1013', 'bg-sidebar': '#12151a', 'bg-raised': '#191d24', 'bg-card': '#1b2028',
      'bg-hover': '#242a34', 'bg-input': '#161a21', 'bg-code': '#0d1014', 'bg-code-inline': '#1d222b',
      'border': '#2b323e', 'border-soft': '#202631',
      'text': '#e6e9ee', 'text-dim': '#9aa3b2', 'text-faint': '#656e7e',
      'accent': '#7aa2d6', 'accent-deep': '#5580b4', 'accent-dim': '#3d5f8a', 'on-accent': '#0a1017',
      'green': '#6fae72', 'yellow': '#cbb35c', 'red': '#c9645c',
      'scrollbar': '#313a48',
    },
  },
  {
    id: 'nightshade',
    name: 'Nightshade',
    dark: true,
    blurb: 'dark violet, soft neon accent',
    colors: {
      'bg': '#100d14', 'bg-sidebar': '#15111b', 'bg-raised': '#1d1826', 'bg-card': '#201a29',
      'bg-hover': '#2a2336', 'bg-input': '#181420', 'bg-code': '#0f0c13', 'bg-code-inline': '#221c2c',
      'border': '#322a42', 'border-soft': '#251f31',
      'text': '#eae5f0', 'text-dim': '#a89fb8', 'text-faint': '#6f6680',
      'accent': '#b48ae0', 'accent-deep': '#8f63c0', 'accent-dim': '#674691', 'on-accent': '#120a1a',
      'green': '#77a86a', 'yellow': '#cfa74f', 'red': '#c65f74',
      'scrollbar': '#3a3149',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    dark: true,
    blurb: 'char-black, burnt-orange glow',
    colors: {
      'bg': '#0d0b0a', 'bg-sidebar': '#131009', 'bg-raised': '#1b1512', 'bg-card': '#1d1713',
      'bg-hover': '#281f19', 'bg-input': '#171210', 'bg-code': '#100d0b', 'bg-code-inline': '#211a15',
      'border': '#33261e', 'border-soft': '#241b15',
      'text': '#ece5df', 'text-dim': '#a99c90', 'text-faint': '#71655c',
      'accent': '#e08a4e', 'accent-deep': '#bb6a33', 'accent-dim': '#8a4d24', 'on-accent': '#180d05',
      'green': '#8aa25c', 'yellow': '#d9a441', 'red': '#cd5844',
      'scrollbar': '#3a2d23',
    },
  },
  {
    id: 'duckling',
    name: 'Duckling',
    dark: false,
    blurb: 'light warm cream, golden accent',
    shadow: LIGHT_SHADOW,
    colors: {
      'bg': '#faf6ee', 'bg-sidebar': '#f3ecdd', 'bg-raised': '#efe7d6', 'bg-card': '#fffdf7',
      'bg-hover': '#e9dfc9', 'bg-input': '#fffdf7', 'bg-code': '#f1ead9', 'bg-code-inline': '#efe7d3',
      'border': '#d8cbb2', 'border-soft': '#e5dbc6',
      'text': '#2e2618', 'text-dim': '#6e6350', 'text-faint': '#9c8f77',
      'accent': '#c08a3e', 'accent-deep': '#a06f28', 'accent-dim': '#d9c49a', 'on-accent': '#fff8ec',
      'green': '#5c8f4a', 'yellow': '#a8842a', 'red': '#b34a38',
      'scrollbar': '#d4c7ad',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    dark: false,
    blurb: 'clean neutral light, ink & blue',
    shadow: LIGHT_SHADOW,
    colors: {
      'bg': '#f7f7f5', 'bg-sidebar': '#efefec', 'bg-raised': '#e9e9e5', 'bg-card': '#ffffff',
      'bg-hover': '#e3e3de', 'bg-input': '#ffffff', 'bg-code': '#eeeeea', 'bg-code-inline': '#e9e9e3',
      'border': '#d3d3cc', 'border-soft': '#e2e2db',
      'text': '#23241f', 'text-dim': '#5f6158', 'text-faint': '#8f9188',
      'accent': '#4478c0', 'accent-deep': '#2f5c9e', 'accent-dim': '#b9cbe6', 'on-accent': '#f5f9ff',
      'green': '#4f8a45', 'yellow': '#a3822c', 'red': '#b04a3e',
      'scrollbar': '#cfcfc7',
    },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    dark: true,
    blurb: 'CRT black on green, terminal soul',
    colors: {
      'bg': '#050705', 'bg-sidebar': '#070a07', 'bg-raised': '#0d120d', 'bg-card': '#0e140e',
      'bg-hover': '#152015', 'bg-input': '#0a0f0a', 'bg-code': '#030503', 'bg-code-inline': '#101a10',
      'border': '#1f2f1f', 'border-soft': '#142014',
      'text': '#cfe8cf', 'text-dim': '#8fb08f', 'text-faint': '#5a7a5a',
      'accent': '#4fdc7b', 'accent-deep': '#2fae59', 'accent-dim': '#1d7a3d', 'on-accent': '#031007',
      'green': '#4fdc7b', 'yellow': '#d0d05a', 'red': '#e0604f',
      'scrollbar': '#1e321e',
    },
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    dark: true,
    blurb: 'neon magenta on midnight, glow it up',
    effects: { glow: true, anim: 'full', bg: 'animated', bgA: '#170b2b', bgB: '#0b1d33', bgAngle: 160 },
    colors: {
      'bg': '#120a20', 'bg-sidebar': '#160d27', 'bg-raised': '#221338', 'bg-card': '#24153b',
      'bg-hover': '#301c4d', 'bg-input': '#1b1030', 'bg-code': '#0e081a', 'bg-code-inline': '#281845',
      'border': '#3d2660', 'border-soft': '#2c1b47',
      'text': '#f2e7ff', 'text-dim': '#b49fd4', 'text-faint': '#7d6a9e',
      'accent': '#ff5ec4', 'accent-deep': '#d63aa2', 'accent-dim': '#8e2d6f', 'on-accent': '#1c0514',
      'green': '#4fe3c1', 'yellow': '#ffd166', 'red': '#ff5a6a',
      'scrollbar': '#3d2a5c',
    },
  },
  {
    id: 'abyss',
    name: 'Abyss',
    dark: true,
    blurb: 'deep-ocean blues, made for glass',
    effects: { glass: 'liquid', glassBlur: 22, glassOpacity: 0.52, bg: 'gradient', bgA: '#02060d', bgB: '#0a2438', bgAngle: 170 },
    colors: {
      'bg': '#040a12', 'bg-sidebar': '#061019', 'bg-raised': '#0d1c2a', 'bg-card': '#0e1f2f',
      'bg-hover': '#14293c', 'bg-input': '#091724', 'bg-code': '#030910', 'bg-code-inline': '#102334',
      'border': '#1c3850', 'border-soft': '#122839',
      'text': '#dcebf5', 'text-dim': '#8fadc2', 'text-faint': '#5b7a8e',
      'accent': '#3fc1de', 'accent-deep': '#2596b3', 'accent-dim': '#1a6a83', 'on-accent': '#03141c',
      'green': '#4ec98f', 'yellow': '#d9b95c', 'red': '#d95f65',
      'scrollbar': '#1d3a52',
    },
  },
];

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
  ['solid', 'Solid', 'theme background'],
  ['gradient', 'Gradient', 'two-color blend'],
  ['animated', 'Animated', 'slow drifting blend'],
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
  bg: 'solid',         // solid | gradient | animated
  bgA: '', bgB: '',    // gradient stops ('' → derived from the theme)
  bgAngle: 160,        // degrees
  uiScale: 1,          // 0.85..1.25
  font: 'default',
};

export const presetById = (id) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];
