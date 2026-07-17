// Theme marketplace: browse community themes, install (counts a download),
// publish your current look, delete your own (owner can delete any).
// Seeds two "community" themes on first boot so the shelf is never empty.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { streamChat } from '../llama.js';
import { withGpu } from '../gpuqueue.js';

// ---------------------------------------------------------------------------
// Seed themes. Full token maps so installs never depend on client presets.
// ---------------------------------------------------------------------------

// tiny pixel starfighters, URL-encoded inline SVG. SMIL <animate> makes the
// blaster bolts blink while the CSS keyframes fly the ships across the app.
const XWING_URI = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 12' shape-rendering='crispEdges'>
    <rect x='1' y='1' width='6' height='1' fill='#d3deee'/>
    <rect x='2' y='2' width='4' height='1' fill='#b9c7dd'/>
    <rect x='1' y='10' width='6' height='1' fill='#d3deee'/>
    <rect x='2' y='9' width='4' height='1' fill='#b9c7dd'/>
    <rect x='1' y='2' width='1' height='8' fill='#d0402f'/>
    <rect x='3' y='5' width='9' height='2' fill='#dde6f4'/>
    <rect x='12' y='5' width='2' height='2' fill='#e6edf7'/>
    <rect x='9' y='4' width='2' height='1' fill='#6fb7ff'/>
    <rect x='0' y='5' width='1' height='2' fill='#ff8c5a'>
      <animate attributeName='opacity' values='1;.3;1' dur='.5s' repeatCount='indefinite'/>
    </rect>
    <rect x='14' y='5.5' width='4' height='1' fill='#ff3b30'>
      <animate attributeName='opacity' values='0;0;1;0;0;0;0;1;0;0' dur='3.4s' repeatCount='indefinite'/>
    </rect>
  </svg>`.replace(/\n\s*/g, ''))}`;

const TIE_URI = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 12' shape-rendering='crispEdges'>
    <rect x='14' y='0' width='1' height='12' fill='#929fb5'/>
    <rect x='1' y='0' width='1' height='12' fill='#929fb5'/>
    <rect x='2' y='5' width='4' height='2' fill='#b9c7dd'/>
    <rect x='10' y='5' width='4' height='2' fill='#b9c7dd'/>
    <rect x='6' y='4' width='4' height='4' fill='#d3deee'/>
    <rect x='7' y='5' width='2' height='2' fill='#222b3a'/>
    <rect x='0' y='5.5' width='4' height='1' fill='#4fdc7b'>
      <animate attributeName='opacity' values='0;0;0;1;0;0;1;0;0;0' dur='2.9s' repeatCount='indefinite'/>
    </rect>
  </svg>`.replace(/\n\s*/g, ''))}`;

const OUTER_RIM_CSS = `/* — dogfight over the Outer Rim — two pixel starfighters cross the pond,
   trading blaster fire. They respect the Animations=Off switch. */
body::before, body::after {
  content: ''; position: fixed; top: 0; left: 0; z-index: 2147483000;
  pointer-events: none; opacity: 0; background: center / contain no-repeat;
  filter: drop-shadow(0 0 3px rgba(160, 190, 255, 0.35));
  will-change: transform;
}
body::before {
  width: 58px; height: 39px;
  background-image: url("${XWING_URI}");
  animation: dpXwing 41s linear infinite;
}
body::after {
  width: 50px; height: 38px;
  background-image: url("${TIE_URI}");
  animation: dpTie 41s linear infinite;
}
@keyframes dpXwing {
  0%   { transform: translate(-10vw, 82vh) rotate(-9deg); opacity: 0; }
  2%   { opacity: .8; }
  40%  { transform: translate(108vw, 14vh) rotate(-9deg); opacity: .8; }
  41%, 100% { transform: translate(-10vw, 82vh) rotate(-9deg); opacity: 0; }
}
@keyframes dpTie {
  0%, 3% { transform: translate(-16vw, 88vh) rotate(-9deg); opacity: 0; }
  5%   { opacity: .75; }
  43%  { transform: translate(102vw, 20vh) rotate(-9deg); opacity: .75; }
  44%, 55% { opacity: 0; }
  56%  { transform: translate(108vw, 30vh) rotate(6deg) scaleX(-1); opacity: .75; }
  92%  { transform: translate(-12vw, 72vh) rotate(6deg) scaleX(-1); opacity: .75; }
  93%, 100% { opacity: 0; }
}
html[data-anim='off'] body::before, html[data-anim='off'] body::after { display: none; }
/* starfield + one faint nebula, behind everything */
#app::before {
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    radial-gradient(50% 34% at 76% 16%, rgba(96, 120, 220, 0.16), transparent 70%),
    radial-gradient(40% 30% at 15% 78%, rgba(140, 90, 200, 0.08), transparent 70%),
    radial-gradient(2px 2px at 12% 22%, rgba(255,255,255,.9) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 34% 74%, rgba(255,255,255,.6) 50%, transparent 51%),
    radial-gradient(2.5px 2.5px at 56% 12%, rgba(210,225,255,.95) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 71% 51%, rgba(255,255,255,.55) 50%, transparent 51%),
    radial-gradient(2px 2px at 88% 83%, rgba(255,255,255,.7) 50%, transparent 51%),
    radial-gradient(2px 2px at 22% 91%, rgba(210,225,255,.65) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 45% 38%, rgba(255,255,255,.5) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 7% 55%, rgba(255,255,255,.6) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 62% 65%, rgba(255,255,255,.5) 50%, transparent 51%),
    radial-gradient(2px 2px at 81% 40%, rgba(210,225,255,.7) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 93% 27%, rgba(255,255,255,.65) 50%, transparent 51%),
    radial-gradient(1px 1px at 27% 45%, rgba(255,255,255,.45) 50%, transparent 51%),
    radial-gradient(1px 1px at 52% 82%, rgba(255,255,255,.4) 50%, transparent 51%),
    radial-gradient(1px 1px at 68% 28%, rgba(255,255,255,.45) 50%, transparent 51%);
}`;

const ARCADE_CSS = `/* — insert coin — square everything, scanlines, chunky press-down buttons */
:root { --rf: 0 !important; }
body::after {
  content: ''; position: fixed; inset: 0; z-index: 2147483001; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,.13) 0 1px, transparent 1px 3px);
}
#app::before {
  content: ''; position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
  background: radial-gradient(135% 100% at 50% 50%, transparent 70%, rgba(0, 0, 0, 0.30));
}
button { box-shadow: 2px 2px 0 rgba(0,0,0,.55) !important; }
button:active { transform: translate(2px, 2px) !important; box-shadow: none !important; }
button.primary { box-shadow: 3px 3px 0 rgba(0,0,0,.6) !important; }
img { image-rendering: pixelated; }
::selection { background: #e83b3b; color: #fff; }`;

const SEEDS = [
  {
    author: 'wedge_antilles', name: 'Outer Rim', downloads: 1287, days_ago: 41,
    blurb: 'A galaxy far, far away. Starfield, glass cockpit chrome, and an X-wing hunting a TIE across your pond.',
    theme: {
      name: 'Outer Rim', base: 'slate',
      colors: {
        'bg': '#0a1220', 'bg-sidebar': '#0d1626', 'bg-raised': '#182338', 'bg-card': '#19253c',
        'bg-hover': '#22304a', 'bg-input': '#111c2e', 'bg-code': '#081020', 'bg-code-inline': '#1c2942',
        'border': '#2e4060', 'border-soft': '#213048',
        'text': '#e8eef8', 'text-dim': '#a4b4cc', 'text-faint': '#6d7f99',
        'accent': '#f5d94a', 'accent-deep': '#cbb02f', 'accent-dim': '#8a7a24', 'on-accent': '#1a1400',
        'green': '#6fdc8c', 'yellow': '#ffd93b', 'red': '#ff5449',
        'scrollbar': '#24304a',
      },
      layout: { chatWidth: 'normal', sidebar: 'left', radius: 'soft', bubbles: 'bubbles' },
      effects: {
        glass: 'frosted', glassBlur: 16, glassOpacity: 0.55, glow: true, anim: 'full',
        bg: 'animated', bgA: '#060b18', bgB: '#152448', bgAngle: 155, uiScale: 1, font: 'default',
      },
      css: OUTER_RIM_CSS,
    },
  },
  {
    author: 'pixl_pond', name: '8-Bit Arcade', downloads: 946, days_ago: 26,
    blurb: 'Cabinet-grade: zero corner radius, scanlines, chunky press-down buttons, NES reds and coin golds.',
    theme: {
      name: '8-Bit Arcade', base: 'pond',
      colors: {
        'bg': '#0f0f1b', 'bg-sidebar': '#131322', 'bg-raised': '#1c1c30', 'bg-card': '#1e1e33',
        'bg-hover': '#29294a', 'bg-input': '#16162a', 'bg-code': '#0a0a14', 'bg-code-inline': '#23233c',
        'border': '#34345c', 'border-soft': '#26264a',
        'text': '#eaeaf5', 'text-dim': '#a8a8c8', 'text-faint': '#6c6c8e',
        'accent': '#e83b3b', 'accent-deep': '#c02c2c', 'accent-dim': '#7e2020', 'on-accent': '#fff4f4',
        'green': '#3bd63b', 'yellow': '#ffd93b', 'red': '#e83b3b',
        'scrollbar': '#2c2c50',
      },
      layout: { chatWidth: 'normal', sidebar: 'left', radius: 'sharp', bubbles: 'bubbles' },
      effects: {
        glass: 'off', glassBlur: 14, glassOpacity: 0.6, glow: false, anim: 'subtle',
        bg: 'solid', bgA: '', bgB: '', bgAngle: 160, uiScale: 1, font: 'mono',
      },
      css: ARCADE_CSS,
    },
  },
];

function seed() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM community_themes').get().n;
  if (n === 0) {
    const ins = db.prepare(`INSERT INTO community_themes (user_id, author, name, blurb, theme_json, downloads, created_at)
                            VALUES (NULL, ?, ?, ?, ?, ?, unixepoch() - ? * 86400)`);
    for (const s of SEEDS) ins.run(s.author, s.name, s.blurb, JSON.stringify(s.theme), s.downloads, s.days_ago);
  }
  // keep the built-in seeds current across releases (user themes untouched)
  const upd = db.prepare('UPDATE community_themes SET blurb = ?, theme_json = ? WHERE user_id IS NULL AND name = ?');
  for (const s of SEEDS) upd.run(s.blurb, JSON.stringify(s.theme), s.name);
}
seed();

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI theme designer. A pinned coder model writes Duck Pond themes from a
// plain-English brief. The system prompt lives HERE, server-side — clients
// can't edit it. Multi-turn: the client sends prior turns as history plus the
// current theme JSON, the model returns { reply, theme } (schema-enforced).
// ---------------------------------------------------------------------------

const THEME_MODEL = process.env.THEME_MODEL ?? 'qwen3-coder-next-q4-k-m';

const THEME_TOKENS = ['bg', 'bg-sidebar', 'bg-raised', 'bg-card', 'bg-hover', 'bg-input',
  'bg-code', 'bg-code-inline', 'border', 'border-soft', 'text', 'text-dim', 'text-faint',
  'accent', 'accent-deep', 'accent-dim', 'on-accent', 'green', 'yellow', 'red', 'scrollbar'];

const THEME_SYSTEM_PROMPT = `You are the Duck Pond theme designer — a specialist that designs color themes for a dark, quiet, premium chat app. You output ONLY JSON matching the required schema. Never explain the JSON, never use markdown fences.

A theme is:
- name: short evocative name (2–4 words).
- colors: EVERY one of these tokens as #rrggbb hex: ${THEME_TOKENS.join(', ')}.
  Semantics: bg = app background; bg-sidebar = left rail; bg-raised = buttons/chips; bg-card = cards & bubbles; bg-hover = hover state; bg-input = text fields; bg-code / bg-code-inline = code surfaces; border / border-soft = outlines; text / text-dim / text-faint = the reading ramp; accent / accent-deep / accent-dim = one accent family (deep = pressed, dim = quiet tint); on-accent = text drawn ON accent; green/yellow/red = status; scrollbar.
- layout (optional): { chatWidth: narrow|normal|wide|full, sidebar: left|right, radius: sharp|soft|round, bubbles: bubbles|minimal }.
- effects (optional): { glass: off|frosted|liquid, glassBlur: 4–32, glassOpacity: 0.3–0.92, glow: bool, anim: off|subtle|full, bg: solid|gradient|animated|aurora, bgA/bgB: #rrggbb gradient stops, bgAngle: 0–360, uiScale: 0.85–1.25, font: default|rounded|serif|mono }.
- css (optional): extra custom CSS for a signature scene. Keep it SUBTLE: fixed-position, pointer-events:none, low-opacity. Always respect motion preferences by adding: html[data-anim='off'] <selector> { display:none; } for anything animated. Never restyle layout-critical properties (no display/position changes on app chrome).

Design rules:
- Premium means restrained: near-black backgrounds with a warm or cool cast, one accent family, generous contrast between text and bg (aim for WCAG AA on text/bg), dim/faint steps that read as a ramp, borders barely lighter than the surface they divide.
- Match the brief's mood. If the user asks for loud/retro/neon, deliver it with conviction — but keep text legible.
- Dark themes unless asked for light. Light themes: paper-like, soft borders, ink-dark text, on-accent usually near-white.
- green/yellow/red should harmonize with the palette (muted, never pure #0f0/#ff0/#f00 unless the brief screams terminal).
- reply: one or two warm sentences describing the look you made (no technical token talk — talk about the feeling). If the user is iterating ("make it bluer"), say what changed.`;

const THEME_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    theme: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        colors: {
          type: 'object',
          properties: Object.fromEntries(THEME_TOKENS.map((t) => [t, { type: 'string' }])),
          required: THEME_TOKENS,
        },
        layout: {
          type: 'object',
          properties: {
            chatWidth: { enum: ['narrow', 'normal', 'wide', 'full'] },
            sidebar: { enum: ['left', 'right'] },
            radius: { enum: ['sharp', 'soft', 'round'] },
            bubbles: { enum: ['bubbles', 'minimal'] },
          },
        },
        effects: {
          type: 'object',
          properties: {
            glass: { enum: ['off', 'frosted', 'liquid'] },
            glassBlur: { type: 'integer' },
            glassOpacity: { type: 'number' },
            glow: { type: 'boolean' },
            anim: { enum: ['off', 'subtle', 'full'] },
            bg: { enum: ['solid', 'gradient', 'animated', 'aurora'] },
            bgA: { type: 'string' },
            bgB: { type: 'string' },
            bgAngle: { type: 'integer' },
            uiScale: { type: 'number' },
            font: { enum: ['default', 'rounded', 'serif', 'mono'] },
          },
        },
        css: { type: 'string' },
      },
      required: ['name', 'colors'],
    },
  },
  required: ['reply', 'theme'],
};

function parseThemeReply(content) {
  // schema-constrained output should be pure JSON; stay tolerant anyway
  const s = String(content ?? '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the designer returned no JSON');
  const out = JSON.parse(s.slice(start, end + 1));
  if (!out || typeof out.reply !== 'string' || !out.theme?.colors) {
    throw new Error('the designer returned an incomplete theme');
  }
  return out;
}

export default async function themeRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/theme/assist', async (req, reply) => {
    const prompt = String(req.body?.prompt ?? '').trim().slice(0, 1500);
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    // prior turns: clean roles only, short, capped — this is a side-chat, not RAG
    const history = (Array.isArray(req.body?.history) ? req.body.history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
    const current = req.body?.current && typeof req.body.current === 'object'
      ? JSON.stringify(req.body.current).slice(0, 6000)
      : null;
    const ask = current
      ? `Current theme (iterate on it):\n${current}\n\nRequest: ${prompt}`
      : `Request: ${prompt}`;
    try {
      const out = await withGpu(() => streamChat({
        model: THEME_MODEL,
        messages: [
          { role: 'system', content: THEME_SYSTEM_PROMPT },
          ...history,
          { role: 'user', content: ask },
        ],
        params: {
          max_tokens: 2400,
          temperature: 0.55,
          json_schema: THEME_JSON_SCHEMA,
          chat_template_kwargs: { enable_thinking: false },
        },
      }));
      return parseThemeReply(out.content);
    } catch (err) {
      req.log.warn({ err }, 'theme assist failed');
      return reply.code(502).send({
        error: `The designer model couldn't answer (${String(err.message ?? err).slice(0, 140)}). It may still be loading — try again in a moment.`,
      });
    }
  });

  app.get('/api/themes/market', async (req) => {
    const rows = db.prepare('SELECT * FROM community_themes ORDER BY downloads DESC, id DESC LIMIT 100').all();
    return rows.map((r) => ({
      id: r.id, author: r.author, name: r.name, blurb: r.blurb,
      downloads: r.downloads, created_at: r.created_at,
      mine: r.user_id === req.user.id, theme: JSON.parse(r.theme_json),
    }));
  });

  app.post('/api/themes/market', async (req, reply) => {
    const { name, blurb, theme } = req.body ?? {};
    const n = String(name ?? '').trim().slice(0, 40);
    if (!n) return reply.code(400).send({ error: 'name required' });
    if (!theme || typeof theme !== 'object') return reply.code(400).send({ error: 'theme required' });
    const json = JSON.stringify(theme);
    if (json.length > 40_000) return reply.code(413).send({ error: 'theme too large' });
    const mine = db.prepare('SELECT COUNT(*) AS n FROM community_themes WHERE user_id = ?').get(req.user.id).n;
    if (mine >= 20) return reply.code(429).send({ error: 'you have 20 published themes — delete one first' });
    const row = db.prepare(`INSERT INTO community_themes (user_id, author, name, blurb, theme_json)
                            VALUES (?, ?, ?, ?, ?) RETURNING *`)
      .get(req.user.id, req.user.username, n, String(blurb ?? '').trim().slice(0, 200), json);
    return { ...row, mine: true, theme: JSON.parse(row.theme_json), theme_json: undefined };
  });

  app.post('/api/themes/market/:id/install', async (req, reply) => {
    const row = db.prepare(`UPDATE community_themes SET downloads = downloads + 1 WHERE id = ? RETURNING *`)
      .get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'no such theme' });
    return { id: row.id, name: row.name, theme: JSON.parse(row.theme_json) };
  });

  app.delete('/api/themes/market/:id', async (req, reply) => {
    const row = db.prepare('SELECT user_id FROM community_themes WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'no such theme' });
    if (row.user_id !== req.user.id && req.user.role !== 'owner') return reply.code(403).send({ error: 'not yours' });
    db.prepare('DELETE FROM community_themes WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
}
