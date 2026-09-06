import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration234 } from '../../../../../src/storage/schema/m234-drop-space-agent-inbox-messages.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

const INBOX_TABLE = 'space_agent_inbox_messages';

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = ?`).get(name);
}

function markerExists(db: BunDatabase, key: string): boolean {
  return !!db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(key);
}

function makeRecreatedInboxDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createTables(db);
  db.exec(`
    CREATE TABLE ${INBOX_TABLE} (
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
  db.exec(
    `CREATE INDEX idx_space_agent_inbox_target_status ` +
      `ON ${INBOX_TABLE}(space_id, target_agent_id, status, created_at)`
  );
  db.exec(
    `CREATE UNIQUE INDEX idx_space_agent_inbox_idempotency ` +
      `ON ${INBOX_TABLE}(space_id, target_agent_id, idempotency_key) ` +
      `WHERE idempotency_key IS NOT NULL AND status = 'pending'`
  );
  return db;
}

function insertSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, id, `/tmp/${id}`, id);
}

function seedInboxRow(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO ${INBOX_TABLE}
       (id, space_id, target_agent_id, source_actor_id, message, expires_at, created_at)
     VALUES (?, ?, 'agent-1', 'src', 'hello', 9999, 1)`
  ).run(id, spaceId);
}

describe('migration 234 — drop space_agent_inbox_messages', () => {
  test('drops the table and its indexes from an upgraded database', () => {
    const db = makeRecreatedInboxDb();
    insertSpace(db, 'space-a');
    seedInboxRow(db, 'row-1', 'space-a');

    runMigration234(db);

    expect(tableExists(db, INBOX_TABLE)).toBe(false);
    expect(indexExists(db, 'idx_space_agent_inbox_target_status')).toBe(false);
    expect(indexExists(db, 'idx_space_agent_inbox_idempotency')).toBe(false);
    db.close();
  });

  test('is idempotent when the table is already gone', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    createTables(db);

    expect(() => runMigration234(db)).not.toThrow();
    expect(tableExists(db, INBOX_TABLE)).toBe(false);
    db.close();
  });

  test('a fresh database never creates the table and createTables does not restore it', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    createTables(db);

    expect(tableExists(db, INBOX_TABLE)).toBe(false);
    expect(markerExists(db, 'migration_234')).toBe(true);
    db.close();
  });

  test('runMigrations drops a pre-existing table on upgrade and it stays dropped', () => {
    const db = makeRecreatedInboxDb();
    insertSpace(db, 'space-a');
    seedInboxRow(db, 'row-1', 'space-a');
    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_234'`).run();

    runMigrations(db, () => {});
    createTables(db);

    expect(tableExists(db, INBOX_TABLE)).toBe(false);
    db.close();
  });
});
