// Theme marketplace: browse community themes, install (counts a download),
// publish your current look, delete your own (owner can delete any).
// Seeds two "community" themes on first boot so the shelf is never empty.
import { requireAuth } from '../auth.js';
import { db } from '../db.js';

// ---------------------------------------------------------------------------
// Seed themes. Full token maps so installs never depend on client presets.
// ---------------------------------------------------------------------------

// tiny pixel starfighters, URL-encoded inline SVG. SMIL <animate> makes the
// blaster bolts blink while the CSS keyframes fly the ships across the app.
const XWING_URI = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 12' shape-rendering='crispEdges'>
    <rect x='1' y='1' width='6' height='1' fill='%23aeb9cc'/>
    <rect x='2' y='2' width='4' height='1' fill='%238f9cb3'/>
    <rect x='1' y='10' width='6' height='1' fill='%23aeb9cc'/>
    <rect x='2' y='9' width='4' height='1' fill='%238f9cb3'/>
    <rect x='1' y='2' width='1' height='8' fill='%23d0402f'/>
    <rect x='3' y='5' width='9' height='2' fill='%23c7d2e4'/>
    <rect x='12' y='5' width='2' height='2' fill='%23e6edf7'/>
    <rect x='9' y='4' width='2' height='1' fill='%236fb7ff'/>
    <rect x='0' y='5' width='1' height='2' fill='%23ff8c5a'>
      <animate attributeName='opacity' values='1;.3;1' dur='.5s' repeatCount='indefinite'/>
    </rect>
    <rect x='14' y='5.5' width='4' height='1' fill='%23ff3b30'>
      <animate attributeName='opacity' values='0;0;1;0;0;0;0;1;0;0' dur='3.4s' repeatCount='indefinite'/>
    </rect>
  </svg>`.replace(/\n\s*/g, ''))}`;

const TIE_URI = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 12' shape-rendering='crispEdges'>
    <rect x='14' y='0' width='1' height='12' fill='%236a7688'/>
    <rect x='1' y='0' width='1' height='12' fill='%236a7688'/>
    <rect x='2' y='5' width='4' height='2' fill='%238f9cb3'/>
    <rect x='10' y='5' width='4' height='2' fill='%238f9cb3'/>
    <rect x='6' y='4' width='4' height='4' fill='%23aeb9cc'/>
    <rect x='7' y='5' width='2' height='2' fill='%23343e4e'/>
    <rect x='0' y='5.5' width='4' height='1' fill='%234fdc7b'>
      <animate attributeName='opacity' values='0;0;0;1;0;0;1;0;0;0' dur='2.9s' repeatCount='indefinite'/>
    </rect>
  </svg>`.replace(/\n\s*/g, ''))}`;

const OUTER_RIM_CSS = `/* — dogfight over the Outer Rim — two pixel starfighters cross the pond,
   trading blaster fire. They respect the Animations=Off switch. */
body::before, body::after {
  content: ''; position: fixed; top: 0; left: 0; z-index: 2147483000;
  pointer-events: none; opacity: 0; background: center / contain no-repeat;
  will-change: transform;
}
body::before {
  width: 46px; height: 31px;
  background-image: url("${XWING_URI}");
  animation: dpXwing 47s linear infinite;
}
body::after {
  width: 40px; height: 30px;
  background-image: url("${TIE_URI}");
  animation: dpTie 47s linear infinite;
}
@keyframes dpXwing {
  0%   { transform: translate(-10vw, 82vh) rotate(-9deg); opacity: 0; }
  2%   { opacity: .55; }
  40%  { transform: translate(108vw, 14vh) rotate(-9deg); opacity: .55; }
  41%, 100% { transform: translate(-10vw, 82vh) rotate(-9deg); opacity: 0; }
}
@keyframes dpTie {
  0%, 3% { transform: translate(-16vw, 88vh) rotate(-9deg); opacity: 0; }
  5%   { opacity: .5; }
  43%  { transform: translate(102vw, 20vh) rotate(-9deg); opacity: .5; }
  44%, 55% { opacity: 0; }
  56%  { transform: translate(108vw, 30vh) rotate(6deg) scaleX(-1); opacity: .5; }
  92%  { transform: translate(-12vw, 72vh) rotate(6deg) scaleX(-1); opacity: .5; }
  93%, 100% { opacity: 0; }
}
html[data-anim='off'] body::before, html[data-anim='off'] body::after { display: none; }
/* starfield behind everything */
#app::before {
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    radial-gradient(1px 1px at 12% 22%, rgba(255,255,255,.7) 50%, transparent 51%),
    radial-gradient(1px 1px at 34% 74%, rgba(255,255,255,.5) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 56% 12%, rgba(200,220,255,.8) 50%, transparent 51%),
    radial-gradient(1px 1px at 71% 51%, rgba(255,255,255,.45) 50%, transparent 51%),
    radial-gradient(1px 1px at 88% 83%, rgba(255,255,255,.6) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 22% 91%, rgba(200,220,255,.5) 50%, transparent 51%),
    radial-gradient(1px 1px at 45% 38%, rgba(255,255,255,.4) 50%, transparent 51%),
    radial-gradient(1px 1px at 93% 27%, rgba(255,255,255,.55) 50%, transparent 51%);
}`;

const ARCADE_CSS = `/* — insert coin — square everything, scanlines, chunky press-down buttons */
:root { --rf: 0 !important; }
body::after {
  content: ''; position: fixed; inset: 0; z-index: 2147483001; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,.15) 0 1px, transparent 1px 3px);
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
        'bg': '#04060a', 'bg-sidebar': '#070a12', 'bg-raised': '#101624', 'bg-card': '#111828',
        'bg-hover': '#1a2436', 'bg-input': '#0b111d', 'bg-code': '#030509', 'bg-code-inline': '#131c2e',
        'border': '#263450', 'border-soft': '#1a2438',
        'text': '#e6edf7', 'text-dim': '#9fb0c8', 'text-faint': '#66788f',
        'accent': '#f5d94a', 'accent-deep': '#cbb02f', 'accent-dim': '#8a7a24', 'on-accent': '#1a1400',
        'green': '#6fdc8c', 'yellow': '#ffd93b', 'red': '#ff5449',
        'scrollbar': '#24304a',
      },
      layout: { chatWidth: 'normal', sidebar: 'left', radius: 'soft', bubbles: 'bubbles' },
      effects: {
        glass: 'frosted', glassBlur: 16, glassOpacity: 0.55, glow: true, anim: 'full',
        bg: 'animated', bgA: '#02030a', bgB: '#0a1530', bgAngle: 155, uiScale: 1, font: 'default',
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
  if (n > 0) return;
  const ins = db.prepare(`INSERT INTO community_themes (user_id, author, name, blurb, theme_json, downloads, created_at)
                          VALUES (NULL, ?, ?, ?, ?, ?, unixepoch() - ? * 86400)`);
  for (const s of SEEDS) ins.run(s.author, s.name, s.blurb, JSON.stringify(s.theme), s.downloads, s.days_ago);
}
seed();

// ---------------------------------------------------------------------------

export default async function themeRoutes(app) {
  app.addHook('preHandler', requireAuth);

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
