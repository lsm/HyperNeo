import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  createMemoryConsolidationHandler,
  enqueueMemoryConsolidationIfMissing,
} from '../../../../src/lib/job-handlers/memory-consolidation.handler';
import { MEMORY_CONSOLIDATION } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
		CREATE TABLE job_queue (
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
	`);
  return db;
}

function fakeJob(payload: Record<string, unknown> = {}): Job {
  const now = Date.now();
  return {
    id: 'memory-consolidation-test',
    queue: MEMORY_CONSOLIDATION,
    status: 'processing',
    payload,
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: now,
    createdAt: now,
    startedAt: now,
    completedAt: null,
  };
}

describe('createMemoryConsolidationHandler', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    db = createTestDb();
    jobQueue = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('passes only defined payload options to repository consolidation', async () => {
    const calls: Record<string, unknown>[] = [];
    const memoryRepo = {
      consolidate(options: Record<string, unknown>) {
        calls.push(options);
        return {
          spacesProcessed: 1,
          duplicatesMerged: 2,
          memoriesPruned: 3,
          coreMemoriesWritten: 4,
        };
      },
    };
    const handler = createMemoryConsolidationHandler(memoryRepo as any);

    const result = await handler(
      fakeJob({
        spaceId: ' space-a ',
        staleTtlMs: undefined,
        duplicateJaccardThreshold: 0.75,
        coreLimit: 7,
      })
    );

    expect(calls).toEqual([
      {
        spaceId: 'space-a',
        duplicateJaccardThreshold: 0.75,
        coreLimit: 7,
      },
    ]);
    expect(result.spacesProcessed).toBe(1);
    expect(result.duplicatesMerged).toBe(2);
    expect(result.memoriesPruned).toBe(3);
    expect(result.coreMemoriesWritten).toBe(4);
  });

  it('preserves explicit staleTtlMs zero payload', async () => {
    const calls: Record<string, unknown>[] = [];
    const memoryRepo = {
      consolidate(options: Record<string, unknown>) {
        calls.push(options);
        return {
          spacesProcessed: 0,
          duplicatesMerged: 0,
          memoriesPruned: 0,
          coreMemoriesWritten: 0,
        };
      },
    };
    const handler = createMemoryConsolidationHandler(memoryRepo as any);

    await handler(fakeJob({ staleTtlMs: 0 }));

    expect(calls).toEqual([{ staleTtlMs: 0 }]);
  });

  it('self-schedules next memory consolidation job when queue is provided', async () => {
    const memoryRepo = {
      consolidate() {
        return {
          spacesProcessed: 0,
          duplicatesMerged: 0,
          memoriesPruned: 0,
          coreMemoriesWritten: 0,
        };
      },
    };
    const handler = createMemoryConsolidationHandler(memoryRepo as any, jobQueue);
    const before = Date.now();

    const result = await handler(fakeJob());
    const after = Date.now();

    const pending = jobQueue.listJobs({
      queue: MEMORY_CONSOLIDATION,
      status: 'pending',
      limit: 10,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].runAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(pending[0].runAt).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
    expect(result.nextRunAt).toBe(pending[0].runAt);
  });

  it('schedules next memory consolidation job before repository consolidation runs', async () => {
    const memoryRepo = {
      consolidate() {
        throw new Error('consolidation failed');
      },
    };
    const handler = createMemoryConsolidationHandler(memoryRepo as any, jobQueue);

    await expect(handler(fakeJob())).rejects.toThrow('consolidation failed');

    const pending = jobQueue.listJobs({
      queue: MEMORY_CONSOLIDATION,
      status: 'pending',
      limit: 10,
    });
    expect(pending).toHaveLength(1);
  });

  it('does not enqueue duplicate pending memory consolidation jobs', async () => {
    enqueueMemoryConsolidationIfMissing(jobQueue, Date.now() + 1_000);
    enqueueMemoryConsolidationIfMissing(jobQueue, Date.now() + 2_000);

    const pending = jobQueue.listJobs({
      queue: MEMORY_CONSOLIDATION,
      status: 'pending',
      limit: 10,
    });
    expect(pending).toHaveLength(1);
  });
});
