import { createHash } from 'node:crypto';

// Durable dispatch receipts. A lost result is NOT permission to repeat a tool.
// Inject the database so the recovery contract can be tested without a server.
export function toolJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_invocations (
    run_id INTEGER NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL,
    arguments_hash TEXT NOT NULL, status TEXT NOT NULL,
    result TEXT, started_at INTEGER NOT NULL DEFAULT (unixepoch()), finished_at INTEGER,
    PRIMARY KEY (run_id, call_id)
  )`);
  const get = db.prepare('SELECT * FROM agent_tool_invocations WHERE run_id = ? AND call_id = ?');
  const begin = db.transaction((runId, callId, name, args) => {
    const hash = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
    const previous = get.get(runId, callId);
    if (previous) {
      if (previous.arguments_hash !== hash) throw new Error('Tool call ID was reused with different arguments');
      if (previous.status !== 'complete') throw new Error('Previous tool outcome is unknown. Inspect the project before continuing; this call will not be replayed.');
      return { replay: true, result: previous.result };
    }
    db.prepare(`INSERT INTO agent_tool_invocations (run_id, call_id, name, arguments_hash, status)
      VALUES (?, ?, ?, ?, 'dispatched')`).run(runId, callId, name, hash);
    return { replay: false };
  });
  return {
    begin,
    complete(runId, callId, result) {
      const updated = db.prepare(`UPDATE agent_tool_invocations SET status = 'complete', result = ?, finished_at = unixepoch()
        WHERE run_id = ? AND call_id = ? AND status = 'dispatched'`).run(result, runId, callId);
      if (updated.changes !== 1) throw new Error('Tool receipt is no longer owned by this invocation');
    },
    interrupt(runId) {
      return db.prepare(`UPDATE agent_tool_invocations SET status = 'unknown'
        WHERE run_id = ? AND status = 'dispatched'`).run(runId).changes;
    },
  };
}
