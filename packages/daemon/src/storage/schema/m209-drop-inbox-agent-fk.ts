import type { Database as BunDatabase } from '../sqlite-compat';

function tableExists(db: BunDatabase, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return !!row;
}

export function runMigration209(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_inbox_messages')) return;
  db.exec(`
    CREATE TABLE space_agent_inbox_messages_new (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      source_actor_id TEXT NOT NULL,
      source_session_id TEXT,
      message TEXT NOT NULL,
      message_record_json TEXT,
      idempotency_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_attempt_at INTEGER,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delivered', 'expired', 'failed')),
      delivered_at INTEGER,
      delivered_session_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    INSERT INTO space_agent_inbox_messages_new (
      id, space_id, target_agent_id, source_actor_id, source_session_id, message,
      message_record_json, idempotency_key, attempts, max_attempts, last_attempt_at,
      last_error, status, delivered_at, delivered_session_id, expires_at, created_at
    ) SELECT
      id, space_id, target_agent_id, source_actor_id, source_session_id, message,
      message_record_json, idempotency_key, attempts, max_attempts, last_attempt_at,
      last_error, status, delivered_at, delivered_session_id, expires_at, created_at
    FROM space_agent_inbox_messages
  `);
  db.exec(`DROP TABLE space_agent_inbox_messages`);
  db.exec(`ALTER TABLE space_agent_inbox_messages_new RENAME TO space_agent_inbox_messages`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_inbox_target_status ` +
      `ON space_agent_inbox_messages(space_id, target_agent_id, status, created_at)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agent_inbox_idempotency ` +
      `ON space_agent_inbox_messages(space_id, target_agent_id, idempotency_key) ` +
      `WHERE idempotency_key IS NOT NULL AND status = 'pending'`
  );
}
