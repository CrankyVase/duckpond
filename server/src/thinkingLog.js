// Lightweight, append-only thinking logs.
//
// Reasoning traces are useful when a turn goes wrong, but keeping every long
// trace in SQLite (and replay payloads) makes the normal activity log heavy.
// These files are line-delimited JSON so they can be tailed, grepped, or
// shipped without loading the database:
//
//   data/thinking/chat-<convId>.jsonl   one file per conversation
//   data/thinking/run-<runId>.jsonl     one file per agent run (each step)
//
// The database still keeps its `thinking` column for the live UI. These files
// are the durable, lightweight copy for postmortems and log tooling.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './paths.js';

const DIR = process.env.DUCKPOND_THINKING_LOG_DIR ?? join(PROJECT_ROOT, 'data', 'thinking');
const DISABLED = process.env.DUCKPOND_THINKING_LOG === '0';

function scopeName({ convId, runId, scope }) {
  if (scope) return String(scope).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80);
  if (runId != null) return `run-${runId}`;
  if (convId != null) return `chat-${convId}`;
  return 'misc';
}

/**
 * Append one reasoning trace to its lightweight log file.
 * Never throws: a logging failure must not cost the user a reply.
 * @returns {{file:string,name:string}|null} file details, or null when skipped/failed
 */
export function recordThinkingFile({
  thinking, convId = null, messageId = null, runId = null, modelId = null,
  source = 'chat', scope = null,
}) {
  const text = String(thinking ?? '');
  if (DISABLED || !text.trim()) return null;
  try {
    mkdirSync(DIR, { recursive: true });
    const name = `${scopeName({ convId, runId, scope })}.jsonl`;
    const file = join(DIR, name);
    const line = {
      ts: new Date().toISOString(),
      source,
      convId: convId == null ? null : Number(convId),
      messageId: messageId == null ? null : Number(messageId),
      runId: runId == null ? null : Number(runId),
      modelId: modelId ?? null,
      chars: text.length,
      thinking: text,
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return { file, name };
  } catch {
    return null;
  }
}

export const thinkingLogDir = () => DIR;
