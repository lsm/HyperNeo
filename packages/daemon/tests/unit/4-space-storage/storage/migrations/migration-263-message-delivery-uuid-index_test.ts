import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../../src/storage/schema/index.ts';
import { runMigration263 } from '../../../../../src/storage/schema/m263-message-delivery-uuid-index.ts';

const DELIVERY_LOOKUP_SQL = `SELECT 1 FROM job_queue
   WHERE queue = 'message_delivery'
     AND json_extract(payload, '$.sessionId') = ?
     AND json_extract(payload, '$.messageUuid') = ?
     AND status IN ('pending', 'processing')
   LIMIT 1`;

function planFor(db: Database, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('sess-1', 'uuid-1') as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail).join(' | ');
}

function seedDeliveries(db: Database, count: number): void {
  const insert = db.prepare(
    `INSERT INTO job_queue (id, queue, status, payload, run_at, created_at)
     VALUES (?, 'message_delivery', 'pending', ?, ?, ?)`
  );
  for (let i = 0; i < count; i++) {
    insert.run(
      `job-${i}`,
      JSON.stringify({ sessionId: `sess-${i % 4}`, messageUuid: `uuid-${i}` }),
      i,
      i
    );
  }
}

describe('migration 263 — message-delivery uuid index', () => {
  test('a fresh schema resolves a delivery lookup through the paired index', () => {
    const db = new Database(':memory:');
    createTables(db);
    seedDeliveries(db, 200);

    expect(planFor(db, DELIVERY_LOOKUP_SQL)).toContain(
      'idx_message_delivery_session_message_active'
    );
    db.close();
  });

  test('a database without job_queue is left alone', () => {
    const db = new Database(':memory:');
    expect(() => runMigration263(db)).not.toThrow();
    db.close();
  });

  test('an existing database gains the index through the migration', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_queue (
        id TEXT PRIMARY KEY, queue TEXT NOT NULL, status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', run_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX idx_message_delivery_session_active
        ON job_queue (json_extract(payload, '$.sessionId'))
        WHERE queue = 'message_delivery' AND status IN ('pending', 'processing')
    `);
    seedDeliveries(db, 200);

    expect(planFor(db, DELIVERY_LOOKUP_SQL)).not.toContain(
      'idx_message_delivery_session_message_active'
    );

    runMigration263(db);

    expect(planFor(db, DELIVERY_LOOKUP_SQL)).toContain(
      'idx_message_delivery_session_message_active'
    );
    db.close();
  });
});
