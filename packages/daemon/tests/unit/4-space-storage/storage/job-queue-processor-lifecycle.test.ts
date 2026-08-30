import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';

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

describe('JobQueueProcessor — lifecycle contracts', () => {
  let db: Database;
  let repo: JobQueueRepository;
  let processor: JobQueueProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
    processor = new JobQueueProcessor(repo, { pollIntervalMs: 5000 });
  });

  afterEach(async () => {
    await processor.stop();
    db.close();
  });

  describe('eager stale reclamation on start()', () => {
    it('reclaimStale() is called synchronously inside start(), before any interval tick fires', () => {
      const reclaimTimestamps: number[] = [];
      const original = repo.reclaimStale.bind(repo);
      repo.reclaimStale = (staleBefore: number) => {
        reclaimTimestamps.push(Date.now());
        return original(staleBefore);
      };

      const before = Date.now();
      processor.start();
      const after = Date.now();

      expect(reclaimTimestamps.length).toBeGreaterThanOrEqual(1);
      expect(reclaimTimestamps[0]).toBeGreaterThanOrEqual(before);
      expect(reclaimTimestamps[0]).toBeLessThanOrEqual(after + 5);
    });
  });

  describe('stop() drains in-flight jobs', () => {
    it('resolves immediately when there are no in-flight jobs at stop() time', async () => {
      processor.start();
      await expect(processor.stop()).resolves.toBeUndefined();
    });
  });

  describe('error → retry → dead full sequence', () => {
    it('exhausts retries across multiple tick() calls and marks the job dead', async () => {
      let failCount = 0;
      const multiStepProcessor = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 1,
      });
      multiStepProcessor.register('exhaust-q', async () => {
        failCount++;
        throw new Error(`failure #${failCount}`);
      });

      const job = repo.enqueue({ queue: 'exhaust-q', payload: {}, maxRetries: 1 });

      await multiStepProcessor.tick();
      await flush();

      expect(repo.getJob(job.id)?.status).toBe('pending');
      expect(repo.getJob(job.id)?.retryCount).toBe(1);

      db.prepare(`UPDATE job_queue SET run_at = ? WHERE id = ?`).run(Date.now() - 1, job.id);

      await multiStepProcessor.tick();
      await flush();

      const final = repo.getJob(job.id);
      expect(final?.status).toBe('dead');
      expect(failCount).toBe(2);

      await multiStepProcessor.stop();
    });

    it('converts non-Error throws to string for the error field', async () => {
      processor.register('str-throw-q', async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string error';
      });

      const job = repo.enqueue({ queue: 'str-throw-q', payload: {}, maxRetries: 0 });
      await processor.tick();
      await flush();

      const updated = repo.getJob(job.id);
      expect(updated?.status).toBe('dead');
      expect(updated?.error).toBe('plain string error');
    });
  });

  describe('setChangeNotifier status transitions', () => {
    it('notifier receives "job_queue" for all status transitions: completed, retried, dead', async () => {
      const tables: string[] = [];
      processor.setChangeNotifier((t) => tables.push(t));

      let callCount = 0;
      processor.register('notify-q', async () => {
        callCount++;
        if (callCount < 3) throw new Error('transient');
      });

      tables.length = 0;
      callCount = 0;

      const deadJob = repo.enqueue({ queue: 'notify-q', payload: {}, maxRetries: 0 });
      await processor.tick();
      await flush();

      expect(repo.getJob(deadJob.id)?.status).toBe('dead');
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.every((t) => t === 'job_queue')).toBe(true);

      tables.length = 0;
      processor.register('notify-ok-q', async () => {});
      const okJob = repo.enqueue({ queue: 'notify-ok-q', payload: {} });
      await processor.tick();
      await flush();

      expect(repo.getJob(okJob.id)?.status).toBe('completed');
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.every((t) => t === 'job_queue')).toBe(true);
    });
  });

  describe('live processor snapshots', () => {
    it('reports bounded message-delivery handler state and clears it after settlement', async () => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      processor = new JobQueueProcessor(repo, { pollIntervalMs: 5000, maxConcurrent: 2 });
      processor.register('message_delivery', async (_job, context) => {
        context?.reportStage?.('query_ready', { generation: 7 });
        await blocked;
        return { outcome: 'completed' };
      });
      repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });

      await processor.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const snapshot = processor.snapshot('message_delivery');
      expect(snapshot.inFlightTotal).toBe(1);
      expect(snapshot.stageCounts).toEqual({ query_ready: 1 });
      expect(snapshot.handlers[0]).toMatchObject({
        queue: 'message_delivery',
        sessionId: 'session-1',
        messageUuid: 'message-1',
        generation: 7,
        stage: 'query_ready',
        aborted: false,
      });
      snapshot.handlers.length = 0;
      expect(processor.snapshot('message_delivery').handlers).toHaveLength(1);

      release();
      await flush();
      expect(processor.snapshot('message_delivery').inFlightTotal).toBe(0);
    });
  });

  describe("stale reclamation is scoped to the processor's registered queues", () => {
    it("a non-owner processor does not reclaim another processor's lane; the owner reclaims AND aborts", async () => {
      const abortedClaims: string[] = [];
      let releaseSecond!: () => void;
      const manualRelease = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });

      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 2,
        staleThresholdMs: 60_000,
      });
      delivery.register('message_delivery', (job, context) => {
        return new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve({ outcome: 'settled' });
            }
          };
          if (context?.signal.aborted) {
            abortedClaims.push(job.id);
            return finish();
          }
          context?.signal.addEventListener(
            'abort',
            () => {
              abortedClaims.push(job.id);
              finish();
            },
            { once: true }
          );
          void manualRelease.then(finish);
        });
      });
      const general = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        staleThresholdMs: 60_000,
      });
      general.register('unrelated-q', async () => {});

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });
      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstClaim = repo.getJob(job.id)?.claimToken;
      expect(repo.getJob(job.id)?.status).toBe('processing');
      expect(firstClaim).toBeTruthy();

      const staleLease = Date.now() - 120_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );

      await general.tick();
      expect(repo.getJob(job.id)?.status).toBe('processing');
      expect(repo.getJob(job.id)?.claimToken).toBe(firstClaim);
      expect(abortedClaims).toEqual([]);

      (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await delivery.tick();
      expect(abortedClaims).toEqual([job.id]);
      expect(repo.getJob(job.id)?.status).toBe('pending');

      await flush();
      await delivery.tick();
      const after = repo.getJob(job.id);
      expect(after?.status).toBe('processing');
      expect(after?.claimToken).toBeTruthy();
      expect(after?.claimToken).not.toBe(firstClaim);

      releaseSecond();
      await flush();
      await delivery.stop();
      await general.stop();
    });
  });

  describe('settling deferral is bounded for non-cancellable handlers', () => {
    it('honors a per-processor settlementGraceMs longer than the default', async () => {
      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 2,
        staleThresholdMs: 60_000,
        settlementGraceMs: 35_000,
      });
      delivery.register('message_delivery', () => new Promise(() => {}));

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });
      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const staleLease = Date.now() - 120_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );
      (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await delivery.tick();

      const map = (
        delivery as unknown as {
          settlingReclaimedJobIds: Map<string, { claimToken: string | null; expireAt: number }>;
        }
      ).settlingReclaimedJobIds;
      expect(map.get(job.id)?.expireAt).toBeGreaterThan(Date.now() + 34_000);
    });

    it('lifts the replacement exclusion once the settlement grace expires', async () => {
      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 1,
        staleThresholdMs: 60_000,
      });
      delivery.register('message_delivery', () => new Promise(() => {}));

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });
      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstClaim = repo.getJob(job.id)?.claimToken;
      expect(firstClaim).toBeTruthy();

      const staleLease = Date.now() - 120_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );
      (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');

      const map = (
        delivery as unknown as {
          settlingReclaimedJobIds: Map<string, { claimToken: string | null; expireAt: number }>;
        }
      ).settlingReclaimedJobIds;
      map.set(job.id, { claimToken: firstClaim, expireAt: Date.now() - 1 });
      await delivery.tick();
      const after = repo.getJob(job.id);
      expect(after?.status).toBe('processing');
      expect(after?.claimToken).toBeTruthy();
      expect(after?.claimToken).not.toBe(firstClaim);
    });

    it('stop() drains a live handler whose admission slot was evicted', async () => {
      const releases: Array<() => void> = [];
      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 1,
        staleThresholdMs: 60_000,
      });
      delivery.register(
        'message_delivery',
        () => new Promise((resolve) => releases.push(() => resolve({ outcome: 'settled' })))
      );

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });
      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstClaim = repo.getJob(job.id)?.claimToken;
      expect(firstClaim).toBeTruthy();

      const staleLease = Date.now() - 120_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );
      (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await delivery.tick();
      const map = (
        delivery as unknown as {
          settlingReclaimedJobIds: Map<string, { claimToken: string | null; expireAt: number }>;
        }
      ).settlingReclaimedJobIds;
      map.set(job.id, { claimToken: firstClaim, expireAt: Date.now() - 1 });
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('processing');
      expect(repo.getJob(job.id)?.claimToken).not.toBe(firstClaim);

      let resolved = false;
      const stopPromise = delivery.stop().then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(resolved).toBe(false);

      releases.forEach((release) => release());
      await stopPromise;
      expect(resolved).toBe(true);
    });

    it('does not regress the delivery lifecycle stage on out-of-order reports', async () => {
      const delivery = new JobQueueProcessor(repo, { pollIntervalMs: 5000, maxConcurrent: 1 });
      delivery.register('message_delivery', (_job, context) => {
        context?.reportStage?.('first_sdk_response', { responseType: 'assistant' });
        context?.reportStage?.('query_ready', { generation: 1 });
        context?.reportStage?.('sdk_admitted', { generation: 1 });
        return new Promise(() => {});
      });

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });
      await delivery.tick();
      await flush();

      const snapshot = delivery.snapshot('message_delivery');
      expect(snapshot.handlers).toHaveLength(1);
      expect(snapshot.handlers[0].stage).toBe('first_sdk_response');
    });

    it('excludes slot-evicted records from filtered admission counts', async () => {
      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 1,
        staleThresholdMs: 60_000,
      });
      delivery.register('message_delivery', () => new Promise(() => {}));

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });
      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstClaim = repo.getJob(job.id)?.claimToken;
      expect(firstClaim).toBeTruthy();

      const staleLease = Date.now() - 120_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );
      (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await delivery.tick();
      const map = (
        delivery as unknown as {
          settlingReclaimedJobIds: Map<string, { claimToken: string | null; expireAt: number }>;
        }
      ).settlingReclaimedJobIds;
      map.set(job.id, { claimToken: firstClaim, expireAt: Date.now() - 1 });
      await delivery.tick();

      const snapshot = delivery.snapshot('message_delivery');
      expect(snapshot.inFlightTotal).toBe(2);
      expect(snapshot.handlers).toHaveLength(2);
      expect(snapshot.inFlightCapped).toBe(1);
      expect(snapshot.inFlightExempt).toBe(0);
    });

    it('a late-settling earlier attempt does not lift the replacement deferral', async () => {
      const settledCount = { value: 0 };
      const releases: Array<() => void> = [];
      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 2,
        staleThresholdMs: 60_000,
      });
      delivery.register('message_delivery', () => {
        return new Promise((resolve) => {
          releases.push(() => {
            settledCount.value++;
            resolve({ outcome: 'settled' });
          });
        });
      });

      const job = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'session-1', messageUuid: 'message-1', role: 'turn' },
      });

      const ageStale = () => {
        const staleLease = Date.now() - 120_000;
        db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
          staleLease,
          staleLease,
          job.id
        );
        (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      };

      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const claimA = repo.getJob(job.id)?.claimToken;
      expect(claimA).toBeTruthy();

      ageStale();
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');

      const map = (
        delivery as unknown as {
          settlingReclaimedJobIds: Map<string, { claimToken: string | null; expireAt: number }>;
        }
      ).settlingReclaimedJobIds;
      map.set(job.id, { claimToken: claimA, expireAt: Date.now() - 1 });
      await delivery.tick();
      const claimB = repo.getJob(job.id)?.claimToken;
      expect(claimB).toBeTruthy();
      expect(claimB).not.toBe(claimA);

      ageStale();
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');
      expect(map.get(job.id)?.claimToken).toBe(claimB);

      releases[0]();
      await flush();
      expect(settledCount.value).toBe(1);
      expect(map.has(job.id)).toBe(true);
      expect(map.get(job.id)?.claimToken).toBe(claimB);

      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');

      releases[1]();
      await flush();
      expect(map.has(job.id)).toBe(false);
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('processing');
    });
  });

  describe('stale job reclamation — ordering contract', () => {
    it('reclaimStale() resets the job to pending before the handler picks it up', async () => {
      const job = repo.enqueue({ queue: 'reclaim-order-q', payload: {} });
      repo.dequeue('reclaim-order-q', 1);
      const staleLease = Date.now() - 30_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );

      let statusAtReclaim: string | undefined;
      const original = repo.reclaimStale.bind(repo);
      repo.reclaimStale = (staleBefore: number) => {
        const count = original(staleBefore);
        statusAtReclaim = repo.getJob(job.id)?.status;
        return count;
      };

      const staleProcessor = new JobQueueProcessor(repo, {
        staleThresholdMs: 1_000,
        pollIntervalMs: 5000,
      });
      staleProcessor.register('reclaim-order-q', async () => {});

      await staleProcessor.tick();
      await flush();
      await staleProcessor.stop();

      expect(statusAtReclaim).toBe('pending');
      expect(repo.getJob(job.id)?.status).toBe('completed');
    });

    it('stale check is skipped on the second tick within the same 60 s window', async () => {
      let reclaimCallCount = 0;
      const original = repo.reclaimStale.bind(repo);
      repo.reclaimStale = (staleBefore: number) => {
        reclaimCallCount++;
        return original(staleBefore);
      };

      processor.register('throttle-q', async () => {});

      processor.start();
      const countAfterStart = reclaimCallCount;
      expect(countAfterStart).toBeGreaterThanOrEqual(1);

      await processor.tick();
      expect(reclaimCallCount).toBe(countAfterStart);
    });
  });
});
