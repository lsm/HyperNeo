import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isSqliteBusyError } from '../../../../src/storage/busy-retry';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

const DB_SCHEMA = `
	CREATE TABLE IF NOT EXISTS job_queue (
		id TEXT PRIMARY KEY,
		queue TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending'
			CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
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
	CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
	CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

interface FileDb {
  path: string;
  dir: string;
  main: Database;
  other: Database;
}

function openWalFileDb(busyTimeoutMs: number): FileDb {
  const dir = mkdtempSync(join(tmpdir(), 'jobq-contention-'));
  const path = join(dir, 'db.sqlite');
  const main = new Database(path);
  const other = new Database(path);
  main.exec(`PRAGMA journal_mode = WAL`);
  main.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  other.exec(`PRAGMA journal_mode = WAL`);
  other.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  main.exec(DB_SCHEMA);
  other.exec('SELECT COUNT(*) FROM job_queue');
  return { path, dir, main, other };
}

function closeFileDb(db: FileDb): void {
  db.main.close();
  db.other.close();
  rmSync(db.dir, { recursive: true, force: true });
}

describe('JobQueueRepository — WAL contention', () => {
  describe('deferred read-to-write upgrade (the historic crash mechanism)', () => {
    it('fails with a busy-class error when another connection commits mid-transaction', () => {
      const db = openWalFileDb(5000);
      try {
        let upgradeError: unknown = null;
        const txn = db.main.transaction(() => {
          db.main.prepare(`SELECT * FROM job_queue WHERE status = 'pending'`).all();
          db.other.exec(
            `INSERT INTO job_queue (id, queue, status, payload, run_at, created_at)
             VALUES ('intruder', 'message_delivery', 'pending', '{}', 0, 0)`
          );
          try {
            db.main
              .prepare(`UPDATE job_queue SET status = 'processing' WHERE status = 'pending'`)
              .run();
          } catch (error) {
            upgradeError = error;
            throw error;
          }
        });
        expect(() => txn()).toThrow();
        expect(isSqliteBusyError(upgradeError)).toBe(true);
      } finally {
        closeFileDb(db);
      }
    });
  });

  describe('claim transactions', () => {
    it('run every read-modify-write path inside BEGIN IMMEDIATE transactions', () => {
      const db = new Database(':memory:');
      db.exec(DB_SCHEMA);
      const modes: Array<string | undefined> = [];
      const original = db.transaction.bind(db);
      db.transaction = ((fn: (...args: unknown[]) => unknown, mode?: string) => {
        modes.push(mode);
        return original(fn, mode as 'immediate' | undefined);
      }) as typeof db.transaction;
      const repo = new JobQueueRepository(db as any);

      repo.enqueue({ queue: 'message_delivery', payload: { role: 'steer' } });
      repo.dequeue('message_delivery', 1);
      repo.dequeueExempt('message_delivery', { path: '$.role', equals: 'steer' }, 1);
      repo.enqueueUniquePending({
        queue: 'message_delivery',
        payload: { sessionId: 's1' },
        matchPayload: { sessionId: 's1' },
      });
      repo.reclaimStale(0);
      repo.cancelForSessionWithMessages('s1');
      repo.requeueAllProcessing('message_delivery', 0);

      expect(modes.length).toBe(6);
      expect(modes.every((mode) => mode === 'immediate')).toBe(true);
      db.close();
    });

    it('dequeue survives a concurrent writer by retrying and claims after release', () => {
      const db = openWalFileDb(100);
      try {
        const repo = new JobQueueRepository(db.main as any);
        repo.enqueue({ queue: 'message_delivery', payload: { sessionId: 's1' } });

        db.other.exec('BEGIN IMMEDIATE');
        db.other.exec(
          `INSERT INTO job_queue (id, queue, status, payload, run_at, created_at)
           VALUES ('blocked-writer', 'message_delivery', 'pending', '{}', 0, 0)`
        );

        let busyError: unknown = null;
        try {
          repo.dequeue('message_delivery', 1);
        } catch (error) {
          busyError = error;
        }
        expect(isSqliteBusyError(busyError)).toBe(true);

        db.other.exec('COMMIT');
        const claimed = repo.dequeue('message_delivery', 1);
        expect(claimed.length).toBe(1);
        expect(claimed[0].status).toBe('processing');
      } finally {
        closeFileDb(db);
      }
    });
  });
});

describe('JobQueueProcessor — poll resilience', () => {
  let db: Database;
  let repo: JobQueueRepository;
  let processor: JobQueueProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
    processor = new JobQueueProcessor(repo);
  });

  afterEach(async () => {
    await processor.stop();
    db.close();
  });

  it('tick resolves and keeps polling when dequeue throws', async () => {
    let handlerCalls = 0;
    processor.register('resilient-q', async () => {
      handlerCalls++;
    });
    repo.enqueue({ queue: 'resilient-q', payload: {} });

    const original = repo.dequeue.bind(repo);
    let calls = 0;
    repo.dequeue = ((...args: Parameters<typeof original>) => {
      calls++;
      if (calls === 1) throw new Error('database is locked');
      return original(...args);
    }) as typeof repo.dequeue;

    await expect(processor.tick()).resolves.toBe(0);
    const claimed = await processor.tick();
    expect(claimed).toBe(1);
    await flush();
    expect(handlerCalls).toBe(1);
  });

  it('a dequeue failure for one queue does not block other queues in the same tick', async () => {
    let goodCalls = 0;
    processor.register('broken-q', async () => {});
    processor.register('healthy-q', async () => {
      goodCalls++;
    });
    const original = repo.dequeue.bind(repo);
    repo.dequeue = ((...args: Parameters<typeof original>) => {
      if (args[0] === 'broken-q') throw new Error('SQLITE_BUSY');
      return original(...args);
    }) as typeof repo.dequeue;
    repo.enqueue({ queue: 'broken-q', payload: {} });
    repo.enqueue({ queue: 'healthy-q', payload: {} });

    const claimed = await processor.tick();
    expect(claimed).toBe(1);
    await flush();
    expect(goodCalls).toBe(1);
  });

  it('settlement failures inside processJob never surface as unhandled rejections', async () => {
    processor.register('settle-q', async () => ({}));
    repo.enqueue({ queue: 'settle-q', payload: {} });

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    repo.complete = (() => {
      throw new Error('complete failed');
    }) as typeof repo.complete;
    repo.fail = (() => {
      throw new Error('fail failed');
    }) as typeof repo.fail;

    try {
      await processor.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
