// DuckPond SQLite — schema, indexes, and additive migrations live here so
// every boot self-heals the DB. Data dir: data/duckpond.db (gitignored).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DUCKPOND_DB ?? path.resolve('data/duckpond.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL,
  username TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  model_id TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  active_leaf_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT,
  model_id TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tok_per_sec REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  covers_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id);

CREATE TABLE IF NOT EXISTS model_settings (
  model_id TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS usage_stats (
  model_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  gen_ms INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, day)
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// additive migrations — ignore "duplicate column" once applied
try { db.exec('ALTER TABLE users ADD COLUMN default_model_id TEXT'); } catch { /* exists */ }

// agent-run link on messages (nullable FK, agent_runs created later)
try { db.exec('ALTER TABLE messages ADD COLUMN run_id INTEGER'); } catch { /* exists */ }

// per-user image-gen toggles (mirrors settings panel)
try { db.exec("ALTER TABLE users ADD COLUMN allow_image_gen INTEGER NOT NULL DEFAULT 1"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN image_quality TEXT NOT NULL DEFAULT 'medium'"); } catch { /* exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN workspace_id INTEGER'); } catch { /* exists */ }

// inline web-search trace + sources, persisted on assistant messages
try { db.exec('ALTER TABLE messages ADD COLUMN search_json TEXT'); } catch { /* exists */ }

// long-term memory master switch (Settings → Memory)
try { db.exec('ALTER TABLE users ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1'); } catch { /* exists */ }

// selected UI theme (community theme id or null = default duckpond theme)
try { db.exec('ALTER TABLE users ADD COLUMN ui_theme TEXT'); } catch { /* exists */ }

// memories: tier (core/durable/context), confidence, repetitions, source
try { db.exec("ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'durable'"); } catch { /* exists */ }
try { db.exec('ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.6'); } catch { /* exists */ }
try { db.exec('ALTER TABLE memories ADD COLUMN repetitions INTEGER NOT NULL DEFAULT 1'); } catch { /* exists */ }
try { db.exec("ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'extracted'"); } catch { /* exists */ }

// per-user preferred image model ('auto' = bridge picks)
try { db.exec("ALTER TABLE users ADD COLUMN image_model TEXT NOT NULL DEFAULT 'auto'"); } catch { /* exists */ }

// content filter: off | standard | strict
try { db.exec("ALTER TABLE users ADD COLUMN content_filter TEXT NOT NULL DEFAULT 'off'"); } catch { /* exists */ }

// images table (created by imagegen at first use); migrate to AUTOINCREMENT if old
db.exec(`CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  model TEXT,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);
try {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='images'`).get();
  if (row && !/AUTOINCREMENT/i.test(row.sql)) {
    const max = db.prepare('SELECT MAX(id) AS m FROM images').get().m ?? 0;
    db.exec(`
      ALTER TABLE images RENAME TO images__ai;
      CREATE TABLE images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        model TEXT,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO images (id, user_id, prompt, model, path, created_at)
        SELECT id, user_id, prompt, model, path, created_at FROM images__ai;
      DROP TABLE images__ai;
    `);
    console.log('[db] migrated images table to AUTOINCREMENT (max id', max, ')');
  }
} catch (e) {
  console.warn('[db] images AUTOINCREMENT migrate skipped:', e.message);
}

// workspaces (agent sandboxes)
db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  container TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);

// agent runs (one per chat turn that reached for tools)
db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  model_id TEXT,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  steps INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER
)`);

// per-user read-aloud voice (Voxtral voice_id incl. emotion suffix)
try { db.exec('ALTER TABLE users ADD COLUMN tts_voice TEXT'); } catch { /* exists */ }

// ordered per-provider model fallback chain (feat/remote-providers, stage 12)
try { db.exec("ALTER TABLE providers ADD COLUMN fallback_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE providers ADD COLUMN free_only INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }

// Theme marketplace: user-published themes (full color map + layout + effects
// + css bundled in theme_json). Seeded by routes/themes.js on first boot.
db.exec(`CREATE TABLE IF NOT EXISTS community_themes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author TEXT NOT NULL,
  name TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  theme_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);

// ---------- remote providers (feat/remote-providers) ----------
// OpenAI-compatible endpoints the owner adds (base URL + key). Catalog rows
// sync from {base}/models with context + pricing; exact-response cache and
// the cost ledger make paid calls cheaper.
db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'openai',
  enabled INTEGER NOT NULL DEFAULT 1,
  cache_enabled INTEGER NOT NULL DEFAULT 1,     -- exact response cache for plain turns
  fallback_json TEXT NOT NULL DEFAULT '[]',     -- ordered model fallback chain (preference order)
  free_only INTEGER NOT NULL DEFAULT 0,          -- sync imports only models detectably free
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
  price_in REAL,            -- USD per 1M input tokens
  price_out REAL,           -- USD per 1M output tokens
  price_cached_in REAL,     -- USD per 1M cached input tokens (provider prompt cache)
  enabled INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_pmodels_provider ON provider_models(provider_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  conv_id INTEGER,
  model_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- chat | cache_hit | compact_savings | aux_* | fallback
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  baseline_usd REAL NOT NULL DEFAULT 0,
  saved_usd REAL NOT NULL DEFAULT 0,  -- baseline - cost (per-kind semantics differ)
  cache_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ue_user_day ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ue_kind ON usage_events(kind);

CREATE TABLE IF NOT EXISTS response_cache (
  hash TEXT PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  response TEXT NOT NULL,
  thinking TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  hits INTEGER NOT NULL DEFAULT 0
);
`);

// conversation document attachments (RAG-lite)
db.exec(`CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conv_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);
db.exec(`CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT
)`);

// long-term memories + per-message vectors
db.exec(`CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  embedding TEXT,
  tier TEXT NOT NULL DEFAULT 'durable',
  confidence REAL NOT NULL DEFAULT 0.6,
  repetitions INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'extracted',
  conv_id INTEGER,
  last_recalled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);
db.exec(`CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  embedding TEXT
)`);

// chat image uploads
db.exec(`CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  mime TEXT,
  desc TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);
db.exec(`CREATE TABLE IF NOT EXISTS conv_uploads (
  conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  upload_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  PRIMARY KEY (conv_id, upload_id)
);
`);
