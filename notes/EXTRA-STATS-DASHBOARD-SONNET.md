# Stats dashboard — handoff for SONNET (frontend only)

Backend is DONE. This is a pure UI build, ~1 session. Duck-app house rules apply:
**no emoji icons — draw custom pixel-art SVG sprites** (see pixel.js / Pixel.svelte),
core-first (user does the visual polish pass afterward), warm theme vars in app.css.

## What already exists
- `usage_stats` table: `(model_id, day, tokens_in, tokens_out, gen_ms, requests)`,
  written by `recordUsage()` in `routes/chat.js` after every turn.
- `GET /api/stats` (`routes/stats.js`) returns:
  ```
  { totals: {tokens_in, tokens_out, requests},
    perModel: [{ model_id, tokens_in, tokens_out, gen_ms, requests,
                 avg_tok_s, rolling_tok_s }] }
  ```

## Build
1. New `web/src/components/StatsPanel.svelte` — mirror `ImageStudio.svelte`'s
   shape (full view, own scroll). Sections: big totals row (tokens in/out,
   requests); per-model table/bars sorted by tokens_out; avg vs rolling-7d tok/s.
2. Charts: **hand-rolled SVG only** (CSP blocks external chart libs). Simple
   horizontal bars for per-model tokens, a small tok/s comparison. Keep it clean.
3. Wire the view like the others: add `app.view === 'stats'` branch in
   `App.svelte`, a topbar toggle button in `Topbar.svelte` (custom sprite, not a
   lucide emoji-ish icon if the user objects — a BarChart lucide is probably ok
   as it's linework, confirm), and a `viewtitle` case.
4. Load on open: `fetch('/api/stats')` via the `api()` helper.

## Optional backend add (only if you want time-series charts)
`usage_stats.day` exists but the API doesn't expose the daily series. Add
`GET /api/stats/daily` → `SELECT day, SUM(tokens_out)... GROUP BY day ORDER BY
day` for a tokens-over-time line. Small addition to `routes/stats.js`.
