import { DatabaseSync } from "node:sqlite";

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      operation_key TEXT NOT NULL UNIQUE,
      model_ref TEXT NOT NULL,
      prompt_ref TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      error TEXT,
      usage_prompt_tokens INTEGER NOT NULL,
      usage_completion_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steps (
      step_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      run_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function appendAudit(db, eventType, runId = null, payload = {}) {
  db.prepare("INSERT INTO audit_events(event_type, run_id, payload_json, created_at) VALUES(?, ?, ?, ?)")
    .run(eventType, runId, JSON.stringify(payload), new Date().toISOString());
}

export function rowToRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    modelRef: row.model_ref,
    promptRef: row.prompt_ref,
    status: row.status,
    output: row.output,
    error: row.error,
    usage: { promptTokens: row.usage_prompt_tokens, completionTokens: row.usage_completion_tokens },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
