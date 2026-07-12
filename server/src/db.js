import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.DUCKPOND_DB ?? join(ROOT, 'data', 'duckpond.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'friend' CHECK (role IN ('owner','friend')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- brute-force lockouts, keyed 'ip:<addr>' or 'user:<name>'
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  model_id TEXT,
  active_leaf_id INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

-- Message TREE: edits/regenerations create siblings; the visible thread is the
-- path from root to conversations.active_leaf_id. Rows are never deleted.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES messages(id),
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','compaction')),
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT,
  model_id TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tok_per_sec REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  -- for role='compaction': ids of messages this summary replaces in the prompt
  covers_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id);
CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id);

-- per-model settings overrides (global; per-user later if wanted)
CREATE TABLE IF NOT EXISTS model_settings (
  model_id TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}'
);

-- agent workspaces: one podman container + one host directory each
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  container_id TEXT,
  port_base INTEGER,               -- host port block start; 10 ports → container 3000-3009
  status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped','starting','running','error')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ws_user ON workspaces(user_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','waiting_approval','done','error','stopped')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_ws ON agent_runs(workspace_id, id DESC);

-- typed event stream per run (OpenHands-style): stored for replay, tailed live over SSE
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id, id);

-- global app settings (owner-editable), e.g. the core system prompt
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- one-time account-creation links: the recipient picks their own username +
-- password; the token dies on use (or when expires_at passes / owner revokes)
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at INTEGER
);

-- generated images (files live in data/images/)
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  enhanced_prompt TEXT,
  model TEXT,
  size TEXT,
  steps INTEGER,
  file TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id, id DESC);

-- lifetime + per-day usage aggregates
CREATE TABLE IF NOT EXISTS usage_stats (
  model_id TEXT NOT NULL,
  day TEXT NOT NULL,               -- YYYY-MM-DD
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  gen_ms INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, day)
);
`);

// additive migrations — ignore "duplicate column" once applied
try { db.exec('ALTER TABLE users ADD COLUMN default_model_id TEXT'); } catch { /* exists */ }
// chat agent mode: an assistant message can embed an agent run; a conversation
// keeps one workspace so follow-up tasks continue on the same files
try { db.exec('ALTER TABLE messages ADD COLUMN run_id INTEGER'); } catch { /* exists */ }
// image generation preferences: can the model reach for generate_image at
// all, and which quality/speed preset drives its default step count
try { db.exec("ALTER TABLE users ADD COLUMN allow_image_gen INTEGER NOT NULL DEFAULT 1"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN image_quality TEXT NOT NULL DEFAULT 'medium'"); } catch { /* exists */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN workspace_id INTEGER'); } catch { /* exists */ }

export function nowSec() { return Math.floor(Date.now() / 1000); }
