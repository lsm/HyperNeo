import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../../src/storage/schema';
import { runMigration182, runMigration194 } from '../../../../../src/storage/schema/migrations';
import { runMigration221 } from '../../../../../src/storage/schema/m221-drop-message-delivery-active-turn-index';
import { JobQueueRepository } from '../../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../../src/lib/job-queue-constants';
import { deliverMessage } from '../../../../../src/lib/agent/message-delivery';

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

function makeJobQueue(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      completed_at INTEGER
    );
  `);
}

describe('Migration 194: job_queue heartbeat_at', () => {
  test('adds the nullable column idempotently without backfilling in-flight rows', () => {
    const db = new BunDatabase(':memory:');
    try {
      makeJobQueue(db);
      db.exec(`ALTER TABLE job_queue DROP COLUMN heartbeat_at`);
      db.exec(`
        INSERT INTO job_queue (
          id, queue, status, payload, run_at, created_at, started_at
        ) VALUES ('legacy', 'q', 'processing', '{}', 0, 0, 123)
      `);

      runMigration194(db);
      runMigration194(db);

      const row = db.prepare(`SELECT started_at, heartbeat_at FROM job_queue`).get() as {
        started_at: number;
        heartbeat_at: number | null;
      };
      expect(row).toEqual({ started_at: 123, heartbeat_at: null });
    } finally {
      db.close();
    }
  });
});

describe('Migration 182/221: uq_message_delivery_active_turn lifecycle', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });
  afterEach(() => db.close());

  test('FRESH-DB path: createTables no longer creates the role-arbiter index (FIFO)', () => {
    createTables(db);
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(false);

    const repo = new JobQueueRepository(db as never);
    deliverMessage(repo, 'sess-fresh', 'msg-a', { origin: 'chat' });
    deliverMessage(repo, 'sess-fresh', 'msg-b', { origin: 'chat' });
    const jobs = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 10 });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.payload.role === undefined)).toBe(true);
    const [head] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 2);
    expect(head?.payload.messageUuid).toBe('msg-a');
    repo.complete(head!.id, { ok: true });
    const [tail] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 2);
    expect(tail?.payload.messageUuid).toBe('msg-b');
  });

  test('existing-DB upgrade: runMigration182 creates the index once job_queue exists', () => {
    makeJobQueue(db);
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(false);
    runMigration182(db);
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(true);
  });

  test('runMigration182 is a no-op (idempotent) when run twice', () => {
    makeJobQueue(db);
    runMigration182(db);
    expect(() => runMigration182(db)).not.toThrow();
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(true);
  });

  test('runMigration182 is a guarded no-op before the table exists (fresh-DB migration order)', () => {
    expect(() => runMigration182(db)).not.toThrow();
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(false);
  });

  test('runMigration221 drops the historical index on an upgraded database', () => {
    makeJobQueue(db);
    runMigration182(db);
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(true);
    runMigration221(db);
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(false);
  });

  test('runMigration221 is idempotent and safe before the index ever existed', () => {
    expect(() => runMigration221(db)).not.toThrow();
    expect(() => runMigration221(db)).not.toThrow();
    expect(indexExists(db, 'uq_message_delivery_active_turn')).toBe(false);
  });
});
