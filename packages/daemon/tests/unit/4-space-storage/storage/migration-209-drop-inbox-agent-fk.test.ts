import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigration209 } from '../../../../src/storage/schema/m209-drop-inbox-agent-fk';
import { createTables } from '../../../../src/storage/schema';

function createLegacyInboxTable(db: BunDatabase): void {
  db.exec('DROP TABLE space_agent_inbox_messages');
  db.exec(`
    CREATE TABLE space_agent_inbox_messages (
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
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (target_agent_id) REFERENCES space_agents(id) ON DELETE CASCADE
    )
  `);
}

describe('migration 209 drops the inbox target-agent FK', () => {
  test('removes the space_agents FK and preserves rows', () => {
    const db = new BunDatabase(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      createTables(db);
      createLegacyInboxTable(db);
      db.prepare(
        `INSERT INTO space_agent_inbox_messages
          (id, space_id, target_agent_id, source_actor_id, source_session_id, message, expires_at, created_at)
         VALUES ('row-1', 'space-1', 'space-lh-agent:coordinator:space-1', 'src', NULL, 'hello', 9999, 1)`
      ).run();

      runMigration209(db);

      const table = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'space_agent_inbox_messages'`
        )
        .get() as { sql: string };
      expect(table.sql).not.toContain('REFERENCES space_agents');
      expect(
        db.prepare(`SELECT id FROM space_agent_inbox_messages WHERE id = 'row-1'`).get()
      ).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test('is idempotent when run more than once', () => {
    const db = new BunDatabase(':memory:');
    try {
      createTables(db);
      createLegacyInboxTable(db);
      expect(() => runMigration209(db)).not.toThrow();
      expect(() => runMigration209(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
