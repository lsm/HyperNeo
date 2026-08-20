import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration197 } from '../../../../../src/storage/schema/migrations.ts';

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function indexColumns(db: BunDatabase, name: string): Array<{ name: string; desc: boolean }> {
  return (
    db.prepare(`PRAGMA index_xinfo('${name}')`).all() as Array<{
      cid: number;
      name: string | null;
      desc: number;
    }>
  )
    .filter((row) => row.cid >= 0 && !!row.name)
    .map((row) => ({ name: row.name as string, desc: row.desc === 1 }));
}

function createPre197SdkMessages(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT CHECK(send_status IN ('deferred', 'enqueued', 'submitted', 'consumed', 'failed')),
      sdk_uuid TEXT
    )
  `);
  db.exec(`CREATE INDEX idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`);
}

function seedSdkMessages(db: BunDatabase): void {
  const insert = db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const statuses = ['deferred', 'enqueued', 'submitted', 'consumed', 'failed'];
  for (let i = 0; i < 50; i++) {
    insert.run(
      `id-${i}`,
      'session-1',
      i % 5 === 0 ? 'user' : 'assistant',
      '{"type":"text","text":"x"}',
      new Date(1_700_000_000_000 + i * 1000).toISOString(),
      statuses[i % statuses.length],
      `uuid-${i}`
    );
  }
}

function explainQueryPlan(db: BunDatabase, sql: string, params: unknown[]): string[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

describe('Migration 197: ordered sdk_messages (session_id, send_status, timestamp, id) index', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      runMigrations(db, () => {});
      createTables(db);
    }, 30_000);

    test('replaces the unordered status index with the ordered composite', () => {
      expect(indexExists(db, 'idx_sdk_messages_send_status')).toBe(false);
      expect(indexExists(db, 'idx_sdk_messages_send_status_timestamp')).toBe(true);
      const cols = indexColumns(db, 'idx_sdk_messages_send_status_timestamp');
      expect(cols.map((c) => c.name)).toEqual(['session_id', 'send_status', 'timestamp']);
      expect(cols.map((c) => c.desc)).toEqual([false, false, false]);
    });
  });

  describe('pre-197 schema', () => {
    beforeEach(() => {
      createPre197SdkMessages(db);
      seedSdkMessages(db);
    });

    test('creates the ordered index and drops the superseded unordered one', () => {
      expect(indexExists(db, 'idx_sdk_messages_send_status')).toBe(true);
      runMigration197(db);
      expect(indexExists(db, 'idx_sdk_messages_send_status')).toBe(false);
      expect(indexExists(db, 'idx_sdk_messages_send_status_timestamp')).toBe(true);
      const cols = indexColumns(db, 'idx_sdk_messages_send_status_timestamp');
      expect(cols.map((c) => c.name)).toEqual(['session_id', 'send_status', 'timestamp']);
    });

    test('getMessagesByStatus uses the index without a temp sort', () => {
      runMigration197(db);
      const plan = explainQueryPlan(
        db,
        `SELECT id, sdk_message, timestamp FROM sdk_messages
         WHERE session_id = ? AND send_status = ?
         ORDER BY timestamp ASC, rowid ASC`,
        ['session-1', 'enqueued']
      );
      const joined = plan.join(' | ');
      expect(joined).toContain('idx_sdk_messages_send_status_timestamp');
      expect(joined).not.toMatch(/USE TEMP B-TREE/);
      expect(joined).not.toMatch(/SCAN sdk_messages/);
    });

    test('equal timestamps are returned in insertion (rowid) order, not id order', () => {
      runMigration197(db);
      const insert = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, 'session-fifo', 'user', '{"type":"text"}', ?, 'enqueued', ?)`
      );
      insert.run('z-id', '2024-01-01T00:00:00.000Z', 'uuid-z');
      insert.run('a-id', '2024-01-01T00:00:00.000Z', 'uuid-a');
      insert.run('m-id', '2024-01-01T00:00:01.000Z', 'uuid-m');
      const rows = db
        .prepare(
          `SELECT id FROM sdk_messages WHERE session_id = 'session-fifo' AND send_status = 'enqueued'
           ORDER BY timestamp ASC, rowid ASC`
        )
        .all() as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(['z-id', 'a-id', 'm-id']);
    });

    test('getMessageCountByStatus is a covering index scan', () => {
      runMigration197(db);
      const plan = explainQueryPlan(
        db,
        `SELECT COUNT(*) FROM sdk_messages WHERE session_id = ? AND send_status = ?`,
        ['session-1', 'consumed']
      );
      const joined = plan.join(' | ');
      expect(joined).toContain('COVERING INDEX idx_sdk_messages_send_status_timestamp');
    });

    test('is idempotent — running twice does not throw or duplicate', () => {
      runMigration197(db);
      expect(() => runMigration197(db)).not.toThrow();
      const count = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_sdk_messages_send_status_timestamp'`
          )
          .get() as { n: number }
      ).n;
      expect(count).toBe(1);
    });
  });

  describe('no-op guards', () => {
    test('does not throw when sdk_messages does not exist', () => {
      expect(() => runMigration197(db)).not.toThrow();
    });
  });
});
