// Remote providers (OpenAI-compatible: nano-gpt, OpenRouter, …), their
// auto-discovered model catalogs, the per-request cost ledger, and the
// exact-match response cache. See notes/REMOTE-PROVIDERS-PLAN.md.
db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'openai',
  enabled INTEGER NOT NULL DEFAULT 1,
  cache_enabled INTEGER NOT NULL DEFAULT 1,     -- exact response cache for plain turns
  last_sync_at INTEGER,
  last_sync_count INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS provider_models (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  context_length INTEGER,
  max_output INTEGER,
  price_in REAL,            -- USD per 1M input tokens (null = unknown)
  price_out REAL,           -- USD per 1M output tokens
  price_cached_in REAL,     -- USD per 1M cached input tokens (if the provider discounts them)
  enabled INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_pmodels_provider ON provider_models(provider_id);

-- per-request cost ledger: every paid (or would-have-been-paid) call leaves a
-- row; baseline_usd is what the same work would have cost without the saver
-- (reference price for cheap-aux routing, full price for cache hits)
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conv_id INTEGER,
  model_id TEXT NOT NULL,
  provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  baseline_usd REAL NOT NULL DEFAULT 0,
  saved_usd REAL NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_uevents_user ON usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uevents_day ON usage_events(created_at);

-- exact-match reply cache: hash(provider, model, messages, gen params) → the
-- final reply. Only plain remote chat turns (no tool calls, no workspace,
-- no grammar/schema) are cached — anything stateful goes to the API fresh.
CREATE TABLE IF NOT EXISTS response_cache (
  hash TEXT PRIMARY KEY,
  provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  response TEXT NOT NULL,
  thinking TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_hit INTEGER
);
`);

export function nowSec() { return Math.floor(Date.now() / 1000); }
