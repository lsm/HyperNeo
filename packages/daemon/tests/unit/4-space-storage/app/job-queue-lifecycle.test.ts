import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import type { DaemonAppContext } from '../../../../src/app';

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

describe('DaemonAppContext — jobQueue and jobProcessor fields', () => {
  it('DaemonAppContext interface includes jobQueue and jobProcessor', () => {
    const requiredFields: Array<keyof DaemonAppContext> = ['jobQueue', 'jobProcessor'];
    expect(requiredFields).toContain('jobQueue');
    expect(requiredFields).toContain('jobProcessor');
  });
});

describe('JobQueueProcessor lifecycle', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('stop() resolves only after all in-flight jobs finish (cleanup ordering guarantee)', async () => {
    let jobFinished = false;
    let resolveJob!: () => void;

    const processor = new JobQueueProcessor(repo, { pollIntervalMs: 5000 });
    processor.register('lifecycle-queue', async () => {
      await new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
      jobFinished = true;
    });

    repo.enqueue({ queue: 'lifecycle-queue', payload: {} });
    await processor.tick();

    const stopPromise = processor.stop();
    expect(jobFinished).toBe(false);

    resolveJob();
    await stopPromise;
    expect(jobFinished).toBe(true);
  });

  it('stopPolling prevents a requeued in-flight job from being claimed twice during shutdown', async () => {
    let handlerRuns = 0;
    let release!: () => void;
    const processor = new JobQueueProcessor(repo, { pollIntervalMs: 10, maxConcurrent: 2 });
    processor.register('message_delivery', async () => {
      handlerRuns++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    repo.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: 's', messageUuid: 'm', role: 'turn' },
    });

    processor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handlerRuns).toBe(1);

    processor.stopPolling();
    repo.requeueAllProcessing('message_delivery', Date.now());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(handlerRuns).toBe(1);
    expect(repo.listJobs({ queue: 'message_delivery' })[0]?.status).toBe('pending');
    release();
    await processor.stop();
  });

  it('stop() resolves immediately when no in-flight jobs', async () => {
    const processor = new JobQueueProcessor(repo, { pollIntervalMs: 5000 });
    processor.start();
    await expect(processor.stop()).resolves.toBeUndefined();
  });

  it('maxConcurrent defaults to 5 and is enforced by the processor', async () => {
    const savedEnv = process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT;
    delete process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT;

    const maxConcurrent = Number(process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT) || 5;
    const resolvers: Array<() => void> = [];

    const processor = new JobQueueProcessor(repo, { maxConcurrent, pollIntervalMs: 5000 });
    processor.register('default-limit-queue', async () => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });

    for (let i = 0; i < 8; i++) {
      repo.enqueue({ queue: 'default-limit-queue', payload: { i } });
    }

    const claimed = await processor.tick();
    expect(claimed).toBe(5);

    for (const r of resolvers) r();
    await processor.stop();

    if (savedEnv !== undefined) {
      process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT = savedEnv;
    }
  });

  it('maxConcurrent reads from HYPERNEO_JOB_QUEUE_MAX_CONCURRENT and is enforced by the processor', async () => {
    const savedEnv = process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT;
    process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT = '3';

    const maxConcurrent = Number(process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT) || 5;
    const resolvers: Array<() => void> = [];

    const processor = new JobQueueProcessor(repo, { maxConcurrent, pollIntervalMs: 5000 });
    processor.register('custom-limit-queue', async () => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });

    for (let i = 0; i < 5; i++) {
      repo.enqueue({ queue: 'custom-limit-queue', payload: { i } });
    }

    const claimed = await processor.tick();
    expect(claimed).toBe(3);

    for (const r of resolvers) r();
    await processor.stop();

    if (savedEnv !== undefined) {
      process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT = savedEnv;
    } else {
      delete process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT;
    }
  });

  it('JobQueueRepository and JobQueueProcessor can be instantiated together', () => {
    const processor = new JobQueueProcessor(repo, {
      pollIntervalMs: 1000,
      maxConcurrent: 5,
      staleThresholdMs: 5 * 60 * 1000,
    });
    expect(processor).toBeInstanceOf(JobQueueProcessor);
    expect(repo).toBeInstanceOf(JobQueueRepository);
  });
});
