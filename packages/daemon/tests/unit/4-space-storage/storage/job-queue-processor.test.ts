import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  DeadLetterImmediatelyError,
  JobQueueProcessor,
} from '../../../../src/storage/job-queue-processor';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('JobQueueProcessor', () => {
  let db: Database;
  let repo: JobQueueRepository;
  let processor: JobQueueProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
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
		`);
    repo = new JobQueueRepository(db as any);
    processor = new JobQueueProcessor(repo);
  });

  afterEach(async () => {
    await processor.stop();
    db.close();
  });

  describe('register', () => {
    it('registers a handler for a queue', async () => {
      let called = false;
      processor.register('test-queue', async () => {
        called = true;
      });

      repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      expect(called).toBe(true);
    });

    it('overwrites existing handler', async () => {
      let firstCalled = false;
      let secondCalled = false;

      processor.register('test-queue', async () => {
        firstCalled = true;
      });
      processor.register('test-queue', async () => {
        secondCalled = true;
      });

      repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      expect(firstCalled).toBe(false);
      expect(secondCalled).toBe(true);
    });
  });

  describe('tick', () => {
    it('processes pending jobs and calls handler', async () => {
      let called = false;
      processor.register('test-queue', async () => {
        called = true;
      });

      repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      expect(called).toBe(true);
    });

    it('handler receives the correct job object with payload', async () => {
      let receivedJob: Record<string, unknown> | null = null;
      processor.register('test-queue', async (job) => {
        receivedJob = job as unknown as Record<string, unknown>;
      });

      repo.enqueue({ queue: 'test-queue', payload: { key: 'value', count: 42 } });
      await processor.tick();
      await flush();

      expect(receivedJob).not.toBeNull();
      expect((receivedJob as any).queue).toBe('test-queue');
      expect((receivedJob as any).payload).toEqual({ key: 'value', count: 42 });
      expect((receivedJob as any).status).toBe('processing');
    });

    it('returns number of jobs processed', async () => {
      const multiProcessor = new JobQueueProcessor(repo, { maxConcurrent: 10 });
      multiProcessor.register('q1', async () => {});
      multiProcessor.register('q2', async () => {});

      repo.enqueue({ queue: 'q1', payload: {} });
      repo.enqueue({ queue: 'q2', payload: {} });

      const count = await multiProcessor.tick();
      await multiProcessor.stop();

      expect(count).toBe(2);
    });

    it('returns 0 when no pending jobs', async () => {
      processor.register('test-queue', async () => {});

      const count = await processor.tick();

      expect(count).toBe(0);
    });

    it('returns 0 when no handlers registered for the queue', async () => {
      repo.enqueue({ queue: 'unregistered-queue', payload: {} });

      const count = await processor.tick();

      expect(count).toBe(0);
    });

    it('processes jobs from multiple registered queues in single tick', async () => {
      const processed: string[] = [];
      const multiProcessor = new JobQueueProcessor(repo, { maxConcurrent: 10 });
      multiProcessor.register('queue-a', async (job) => {
        processed.push(job.queue);
      });
      multiProcessor.register('queue-b', async (job) => {
        processed.push(job.queue);
      });

      repo.enqueue({ queue: 'queue-a', payload: {} });
      repo.enqueue({ queue: 'queue-b', payload: {} });

      await multiProcessor.tick();
      await flush();
      await multiProcessor.stop();

      expect(processed).toContain('queue-a');
      expect(processed).toContain('queue-b');
    });
  });

  describe('handler success', () => {
    it('marks job as completed after handler succeeds', async () => {
      processor.register('test-queue', async () => {});

      const job = repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.status).toBe('completed');
    });

    it('stores handler result in job.result', async () => {
      processor.register('test-queue', async () => {
        return { output: 'done', count: 7 };
      });

      const job = repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.result).toEqual({ output: 'done', count: 7 });
    });

    it('marks job completed when handler returns void', async () => {
      processor.register('test-queue', async () => {
        // returns undefined
      });

      const job = repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.result).toBeNull();
    });
  });

  describe('handler failure', () => {
    it('retries job when handler throws and retries remaining', async () => {
      processor.register('test-queue', async () => {
        throw new Error('transient error');
      });

      const job = repo.enqueue({ queue: 'test-queue', payload: {}, maxRetries: 3 });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.retryCount).toBe(1);
    });

    it('marks job as dead when handler throws and no retries remaining', async () => {
      processor.register('test-queue', async () => {
        throw new Error('fatal error');
      });

      const job = repo.enqueue({ queue: 'test-queue', payload: {}, maxRetries: 0 });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.status).toBe('dead');
    });

    it('stores error message in job.error', async () => {
      processor.register('test-queue', async () => {
        throw new Error('something went wrong');
      });

      const job = repo.enqueue({ queue: 'test-queue', payload: {}, maxRetries: 0 });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.error).toBe('something went wrong');
    });

    it('force-dead-letters on DeadLetterImmediatelyError without burning retries', async () => {
      let deadJobId: string | null = null;
      processor.register(
        'test-queue',
        async () => {
          throw new DeadLetterImmediatelyError('non-recoverable turn error');
        },
        {
          onDead: (job) => {
            deadJobId = job.id;
          },
        }
      );

      const job = repo.enqueue({ queue: 'test-queue', payload: {}, maxRetries: 3 });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.status).toBe('dead');
      expect(updated?.retryCount).toBe(0);
      expect(updated?.error).toBe('non-recoverable turn error');
      expect(deadJobId).toBe(job.id);
    });
  });

  describe('steer park accounting (requeueParked / getParkCount)', () => {
    it('getParkCount is 0 for a fresh job and after plain requeue', () => {
      const job = repo.enqueue({ queue: 'steer-q', payload: { role: 'steer' } });
      const [claimed] = repo.dequeue('steer-q', 1);
      expect(claimed).toBeTruthy();
      expect(repo.getParkCount(claimed!.id)).toBe(0);
    });

    it('requeueParked bumps __parkCount without touching retry_count, and getParkCount reads it', () => {
      const job = repo.enqueue({ queue: 'steer-q', payload: { role: 'steer' }, maxRetries: 8 });
      const [claimed] = repo.dequeue('steer-q', 1);
      const token = claimed!.claimToken;

      repo.requeueParked(claimed!.id, Date.now() + 5000, token);
      expect(repo.getParkCount(claimed!.id)).toBe(1);
      let updated = repo.getJob(claimed!.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.retryCount).toBe(0);

      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(claimed!.id);
      const [r2] = repo.dequeue('steer-q', 1);
      repo.requeueParked(r2!.id, Date.now() + 5000, r2!.claimToken);
      expect(repo.getParkCount(claimed!.id)).toBe(2);
      updated = repo.getJob(claimed!.id);
      expect(updated?.retryCount).toBe(0);
    });
  });

  describe('maxConcurrent', () => {
    it('respects concurrency limit on first tick', async () => {
      const blockingProcessor = new JobQueueProcessor(repo, { maxConcurrent: 2 });
      const resolvers: Array<() => void> = [];

      blockingProcessor.register('test-queue', async () => {
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      });

      for (let i = 0; i < 5; i++) {
        repo.enqueue({ queue: 'test-queue', payload: { i } });
      }

      const claimed = await blockingProcessor.tick();

      expect(claimed).toBe(2);

      for (const r of resolvers) r();
      await blockingProcessor.stop();
      db.close();
      (db as any).close = () => {};
      await processor.stop();
    });

    it('processes more jobs after first batch completes', async () => {
      const batchProcessor = new JobQueueProcessor(repo, { maxConcurrent: 2 });
      const completedIds: string[] = [];
      const resolvers: Array<() => void> = [];
      let wave = 0;

      batchProcessor.register('test-queue', async (job) => {
        const currentWave = wave;
        if (currentWave === 0) {
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
        }
        completedIds.push(job.id);
      });

      for (let i = 0; i < 4; i++) {
        repo.enqueue({ queue: 'test-queue', payload: { i } });
      }

      const firstClaimed = await batchProcessor.tick();
      expect(firstClaimed).toBe(2);

      wave = 1;
      for (const r of resolvers) r();
      await flush();

      const secondClaimed = await batchProcessor.tick();
      expect(secondClaimed).toBe(2);
      await flush();

      expect(completedIds.length).toBe(4);

      await batchProcessor.stop();
      db.close();
      (db as any).close = () => {};
      await processor.stop();
    });
  });

  describe('start / stop', () => {
    it('start() begins polling and processes enqueued jobs', async () => {
      const shortProcessor = new JobQueueProcessor(repo, { pollIntervalMs: 50 });
      let called = false;

      shortProcessor.register('poll-queue', async () => {
        called = true;
      });

      repo.enqueue({ queue: 'poll-queue', payload: {} });
      shortProcessor.start();

      await flush();
      await shortProcessor.stop();

      expect(called).toBe(true);
    });

    it('stop() stops polling', async () => {
      let callCount = 0;
      const shortProcessor = new JobQueueProcessor(repo, { pollIntervalMs: 20 });

      shortProcessor.register('stop-queue', async () => {
        callCount++;
      });

      shortProcessor.start();
      await shortProcessor.stop();

      repo.enqueue({ queue: 'stop-queue', payload: {} });
      await new Promise((r) => setTimeout(r, 60));

      expect(callCount).toBe(0);
    });

    it('stop() resolves after in-flight jobs complete', async () => {
      let jobFinished = false;
      let resolveJob!: () => void;

      const slowProcessor = new JobQueueProcessor(repo, { pollIntervalMs: 50 });
      slowProcessor.register('slow-queue', async () => {
        await new Promise<void>((resolve) => {
          resolveJob = resolve;
        });
        jobFinished = true;
      });

      repo.enqueue({ queue: 'slow-queue', payload: {} });
      slowProcessor.start();

      await flush();

      const stopPromise = slowProcessor.stop();

      expect(jobFinished).toBe(false);

      resolveJob();

      await stopPromise;
      expect(jobFinished).toBe(true);
    });
  });

  describe('stale job reclaim', () => {
    it('reclaims stale processing jobs during tick', async () => {
      const staleProcessor = new JobQueueProcessor(repo, { staleThresholdMs: 100 });
      staleProcessor.register('stale-queue', async () => {});

      const job = repo.enqueue({ queue: 'stale-queue', payload: {} });
      repo.dequeue('stale-queue', 1);

      const processing = repo.getJob(job.id);
      expect(processing?.status).toBe('processing');

      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        Date.now() - 10_000,
        Date.now() - 10_000,
        job.id
      );

      await staleProcessor.tick();
      await flush();

      const after = repo.getJob(job.id);
      expect(after?.status).toBe('completed');
    });

    it('aborts a reclaimed predecessor and releases its capped slot', async () => {
      const staleProcessor = new JobQueueProcessor(repo, {
        staleThresholdMs: 100,
        maxConcurrent: 1,
      });
      const signals: AbortSignal[] = [];
      let calls = 0;
      staleProcessor.register('claim-loss', async (_job, context) => {
        calls++;
        signals.push(context!.signal);
        if (calls === 1) {
          await new Promise<void>((_, reject) => {
            context!.signal.addEventListener(
              'abort',
              () => reject(context!.signal.reason ?? new Error('claim lost')),
              { once: true }
            );
          });
        }
      });

      const job = repo.enqueue({ queue: 'claim-loss', payload: {}, maxRetries: 0 });
      await staleProcessor.tick();
      await flush();
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        Date.now() - 10_000,
        Date.now() - 10_000,
        job.id
      );
      (
        staleProcessor as unknown as { reclaimStaleClaims(staleBefore: number): void }
      ).reclaimStaleClaims(Date.now() - 100);
      await flush();
      await staleProcessor.tick();
      await flush();

      expect(signals[0]?.aborted).toBe(true);
      expect(calls).toBe(2);
      expect(repo.getJob(job.id)?.status).toBe('completed');
      expect(repo.getJob(job.id)?.retryCount).toBe(0);
      await staleProcessor.stop();
    });

    it('heartbeats a generic long-running handler so it is not reclaimed', async () => {
      const heartbeatProcessor = new JobQueueProcessor(repo, {
        staleThresholdMs: 90,
        maxConcurrent: 1,
      });
      let resolveHandler!: () => void;
      let calls = 0;
      heartbeatProcessor.register('heartbeat-queue', async () => {
        calls++;
        await new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
      });

      const job = repo.enqueue({ queue: 'heartbeat-queue', payload: {} });
      await heartbeatProcessor.tick();
      const startedAt = repo.getJob(job.id)?.startedAt;
      await new Promise((resolve) => setTimeout(resolve, 160));

      expect(repo.getJob(job.id)?.heartbeatAt).toBeGreaterThan(startedAt ?? 0);
      (heartbeatProcessor as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await heartbeatProcessor.tick();
      expect(calls).toBe(1);
      expect(repo.getJob(job.id)?.status).toBe('processing');

      resolveHandler();
      await flush();
      expect(repo.getJob(job.id)?.status).toBe('completed');
      expect(repo.getJob(job.id)?.heartbeatAt).toBeNull();
      await heartbeatProcessor.stop();
    });

    it('aborts the exact handler when heartbeat renewal loses ownership', async () => {
      const heartbeatProcessor = new JobQueueProcessor(repo, {
        staleThresholdMs: 90,
        maxConcurrent: 1,
      });
      let signal!: AbortSignal;
      heartbeatProcessor.register('lost-heartbeat', async (_job, context) => {
        signal = context!.signal;
        await new Promise<void>((resolve) => {
          context!.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      });

      const job = repo.enqueue({ queue: 'lost-heartbeat', payload: {} });
      await heartbeatProcessor.tick();
      db.prepare(
        `UPDATE job_queue
            SET status = 'pending', started_at = NULL, heartbeat_at = NULL
          WHERE id = ?`
      ).run(job.id);
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(signal.aborted).toBe(true);
      expect(repo.getJob(job.id)?.retryCount).toBe(0);
      await heartbeatProcessor.stop();
    });

    it('does not reclaim jobs that are not old enough', async () => {
      const staleProcessor = new JobQueueProcessor(repo, { staleThresholdMs: 60_000 });
      staleProcessor.register('fresh-queue', async () => {});

      const job = repo.enqueue({ queue: 'fresh-queue', payload: {} });
      repo.dequeue('fresh-queue', 1);

      await staleProcessor.tick();
      await flush();

      const after = repo.getJob(job.id);
      expect(after?.status).toBe('processing');
    });

    it('does not run stale check again within STALE_CHECK_INTERVAL', async () => {
      const throttledProcessor = new JobQueueProcessor(repo, { staleThresholdMs: 100 });
      throttledProcessor.register('throttle-queue', async () => {});

      const job = repo.enqueue({ queue: 'throttle-queue', payload: {} });
      repo.dequeue('throttle-queue', 1);

      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        Date.now() - 10_000,
        Date.now() - 10_000,
        job.id
      );

      await throttledProcessor.tick();
      await flush();

      const afterFirst = repo.getJob(job.id);
      expect(afterFirst?.status).toBe('completed');

      const job2 = repo.enqueue({ queue: 'throttle-queue', payload: {} });
      repo.dequeue('throttle-queue', 1);
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        Date.now() - 10_000,
        Date.now() - 10_000,
        job2.id
      );

      await throttledProcessor.tick();
      await flush();

      const afterSecond = repo.getJob(job2.id);
      expect(afterSecond?.status).toBe('processing');

      await throttledProcessor.stop();
    });
  });

  describe('changeNotifier', () => {
    it('notifier is called after job completes', async () => {
      const notified: string[] = [];
      processor.setChangeNotifier((table) => notified.push(table));
      processor.register('test-queue', async () => {});

      repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      expect(notified.length).toBeGreaterThan(0);
    });

    it('notifier is called after job fails', async () => {
      const notified: string[] = [];
      processor.setChangeNotifier((table) => notified.push(table));
      processor.register('test-queue', async () => {
        throw new Error('fail');
      });

      repo.enqueue({ queue: 'test-queue', payload: {}, maxRetries: 0 });
      await processor.tick();
      await flush();

      expect(notified.length).toBeGreaterThan(0);
    });

    it('notifier is called with "job_queue" as argument', async () => {
      const tables: string[] = [];
      processor.setChangeNotifier((table) => tables.push(table));
      processor.register('test-queue', async () => {});

      repo.enqueue({ queue: 'test-queue', payload: {} });
      await processor.tick();
      await flush();

      expect(tables.every((t) => t === 'job_queue')).toBe(true);
    });

    it('notifier is not called when no jobs processed', async () => {
      const notified: string[] = [];
      processor.setChangeNotifier((table) => notified.push(table));
      processor.register('test-queue', async () => {});

      await processor.tick();
      await flush();

      expect(notified.length).toBe(0);
    });

    it('passes a session-scoped change for jobs whose payload carries a sessionId', async () => {
      const scopes: Array<Record<string, string> | undefined> = [];
      processor.setChangeNotifier((_table, scope) => scopes.push(scope));
      processor.register('message_delivery', async () => {});

      repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u-1', role: 'turn' },
      });
      await processor.tick();
      await flush();

      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes[0]).toEqual({ sessionId: 'sess-a' });
    });

    it('notifies without a scope for jobs whose payload has no sessionId', async () => {
      const scopes: Array<Record<string, string> | undefined> = [];
      processor.setChangeNotifier((_table, scope) => scopes.push(scope));
      processor.register('schedule', async () => {});

      repo.enqueue({ queue: 'schedule', payload: { scheduleId: 's1' } });
      await processor.tick();
      await flush();

      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes[0]).toBeUndefined();
    });
  });
});
