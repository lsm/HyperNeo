import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration236 } from '../../../../../src/storage/schema/m236-deferred-message-partial-index.ts';

function createSdkMessagesTable(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      message_type TEXT NOT NULL,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sdk_uuid TEXT,
      send_status TEXT DEFAULT 'consumed'
    )
  `);
}

function queryPlanDetail(db: BunDatabase, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail).join('\n');
}

describe('Migration 236: deferred-message partial index', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSdkMessagesTable(db);
  });

  afterEach(() => {
    db.close();
  });

  test('creates the partial deferred-uuid index', () => {
    runMigration236(db);

    const indexes = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .all('idx_sdk_messages_deferred_uuid') as Array<{ name: string; sql: string }>;

    expect(indexes).toHaveLength(1);
    expect(indexes[0].sql).toContain("WHERE send_status = 'deferred'");
  });

  test('is idempotent', () => {
    runMigration236(db);
    runMigration236(db);

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_sdk_messages_deferred_uuid') as { n: number };
    expect(count.n).toBe(1);
  });

  test('is a no-op on a fresh database where sdk_messages does not exist yet', () => {
    const fresh = new BunDatabase(':memory:');
    try {
      runMigration236(fresh);

      const count = fresh
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get('idx_sdk_messages_deferred_uuid') as { n: number };
      expect(count.n).toBe(0);
    } finally {
      fresh.close();
    }
  });

  test('digest handoff debt scan resolves through the partial index', () => {
    runMigration236(db);

    const plan = queryPlanDetail(
      db,
      `SELECT id, session_id, sdk_message, task_id FROM sdk_messages
       WHERE send_status = 'deferred' AND sdk_uuid LIKE ? || '%'`,
      'digest-'
    );

    expect(plan).toContain('idx_sdk_messages_deferred_uuid');
    expect(plan).not.toMatch(/^SCAN sdk_messages$/m);
  });

  test('returns the deferred digest rows it indexes', () => {
    runMigration236(db);

    db.exec(`
      INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, sdk_uuid, send_status)
        VALUES ('m1', 's1', 'user', '{}', '1', 'digest-aaaa', 'deferred'),
               ('m2', 's1', 'user', '{}', '2', 'regular-uuid', 'deferred'),
               ('m3', 's1', 'user', '{}', '3', 'digest-bbbb', 'consumed')
    `);

    const rows = db
      .prepare(
        `SELECT id FROM sdk_messages WHERE send_status = 'deferred' AND sdk_uuid LIKE ? || '%'`
      )
      .all('digest-') as Array<{ id: string }>;

    expect(rows.map((row) => row.id)).toEqual(['m1']);
  });
});
