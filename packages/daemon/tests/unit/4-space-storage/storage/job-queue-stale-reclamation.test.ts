import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  JobQueueProcessor,
  applyStaleReclaimJitter,
  staleReclaimJitterDelays,
} from '../../../../src/storage/job-queue-processor';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  clearStructuredLogSubscribers,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';

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

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 50
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

describe('Stale job reclamation on restart (eager reclaim)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  let restartedProcessor: JobQueueProcessor | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
    restartedProcessor = null;
  });

  afterEach(async () => {
    if (restartedProcessor !== null) {
      await restartedProcessor.stop();
    }
    db.close();
  });

  it('reclaims a stale processing job immediately on start() without waiting 60 s', async () => {
    const job = repo.enqueue({ queue: 'work-queue', payload: { task: 'doSomething' } });
    repo.dequeue('work-queue', 1);
    expect(repo.getJob(job.id)?.status).toBe('processing');

    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      Date.now() - 10_000,
      Date.now() - 10_000,
      job.id
    );

    const processed: string[] = [];
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 1_000,
      pollIntervalMs: 60_000,
    });
    restartedProcessor.register('work-queue', async (j) => {
      processed.push(j.id);
    });

    restartedProcessor.start();

    await flush();

    const after = repo.getJob(job.id);
    expect(after?.status).toBe('completed');
    expect(processed).toContain(job.id);
  });

  it('calls reclaimStale() synchronously during start() before any tick interval fires', async () => {
    let reclaimCallCount = 0;
    const originalReclaim = repo.reclaimStale.bind(repo);
    repo.reclaimStale = (staleBefore: number) => {
      reclaimCallCount++;
      return originalReclaim(staleBefore);
    };

    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 1_000,
      pollIntervalMs: 60_000,
    });
    restartedProcessor.register('spy-queue', async () => {});

    restartedProcessor.start();

    expect(reclaimCallCount).toBeGreaterThanOrEqual(1);

    await restartedProcessor.stop();
    restartedProcessor = null;
  });

  it('reclaimed job is re-processed by the registered handler', async () => {
    const job = repo.enqueue({ queue: 'crash-queue', payload: { value: 42 } });
    repo.dequeue('crash-queue', 1);
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      Date.now() - 30_000,
      Date.now() - 30_000,
      job.id
    );
    expect(repo.getJob(job.id)?.status).toBe('processing');

    let receivedPayload: Record<string, unknown> | null = null;
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5_000,
      pollIntervalMs: 60_000,
    });
    restartedProcessor.register('crash-queue', async (j) => {
      receivedPayload = j.payload;
    });

    restartedProcessor.start();
    await flush();

    expect(repo.getJob(job.id)?.status).toBe('completed');
    expect(receivedPayload).toEqual({ value: 42 });
  });

  it('does NOT reclaim a recently-started processing job (still within threshold)', async () => {
    const job = repo.enqueue({ queue: 'fresh-queue', payload: {} });
    repo.dequeue('fresh-queue', 1);
    expect(repo.getJob(job.id)?.status).toBe('processing');

    const processed: string[] = [];
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 60_000,
      pollIntervalMs: 60_000,
    });
    restartedProcessor.register('fresh-queue', async (j) => {
      processed.push(j.id);
    });

    restartedProcessor.start();
    await flush();

    const after = repo.getJob(job.id);
    expect(after?.status).toBe('processing');
    expect(processed).not.toContain(job.id);
  });

  it('reclaims multiple stale jobs from different queues on startup', async () => {
    const jobA = repo.enqueue({ queue: 'queue-a', payload: { seq: 1 } });
    const jobB = repo.enqueue({ queue: 'queue-b', payload: { seq: 2 } });
    repo.dequeue('queue-a', 1);
    repo.dequeue('queue-b', 1);

    const pastTime = Date.now() - 20_000;
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id IN (?, ?)').run(
      pastTime,
      pastTime,
      jobA.id,
      jobB.id
    );

    const processedQueues: string[] = [];
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5_000,
      maxConcurrent: 10,
      pollIntervalMs: 500,
      jitterRandom: () => 0.01,
    });
    restartedProcessor.register('queue-a', async (j) => {
      processedQueues.push(j.queue);
    });
    restartedProcessor.register('queue-b', async (j) => {
      processedQueues.push(j.queue);
    });

    restartedProcessor.start();
    await waitFor(
      () =>
        repo.getJob(jobA.id)?.status === 'completed' && repo.getJob(jobB.id)?.status === 'completed'
    );

    expect(processedQueues).toContain('queue-a');
    expect(processedQueues).toContain('queue-b');
  }, 10_000);

  it('does not interfere with a pending job that was never picked up', async () => {
    const stale = repo.enqueue({ queue: 'mixed-queue', payload: { type: 'stale' } });
    repo.dequeue('mixed-queue', 1);
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      Date.now() - 15_000,
      Date.now() - 15_000,
      stale.id
    );
    expect(repo.getJob(stale.id)?.status).toBe('processing');

    const pending = repo.enqueue({ queue: 'mixed-queue', payload: { type: 'new' } });
    expect(repo.getJob(pending.id)?.status).toBe('pending');

    const processedTypes: string[] = [];
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5_000,
      maxConcurrent: 10,
      pollIntervalMs: 60_000,
    });
    restartedProcessor.register('mixed-queue', async (j) => {
      processedTypes.push((j.payload as { type: string }).type);
    });

    restartedProcessor.start();
    await flush();

    expect(repo.getJob(stale.id)?.status).toBe('completed');
    expect(repo.getJob(pending.id)?.status).toBe('completed');
    expect(processedTypes).toContain('stale');
    expect(processedTypes).toContain('new');
  });

  it('does NOT reclaim a processing job whose lease was heartbeated inside the window (item 5)', () => {
    const alive = repo.enqueue({ queue: 'message_delivery', payload: {}, runAt: 0 });
    const dead = repo.enqueue({ queue: 'message_delivery', payload: {}, runAt: 0 });
    repo.dequeue('message_delivery', 2);
    expect(repo.getJob(alive.id)?.status).toBe('processing');
    expect(repo.getJob(dead.id)?.status).toBe('processing');

    const staleThresholdMs = 5_000;
    const longAgo = Date.now() - (staleThresholdMs + 5_000);
    db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id IN (?, ?)`).run(
      longAgo,
      longAgo,
      alive.id,
      dead.id
    );

    expect(repo.heartbeat(alive.id, repo.getJob(alive.id)!.claimToken)).toBe(true);

    const reclaimed = repo.reclaimStale(Date.now() - staleThresholdMs);
    expect(reclaimed).toHaveLength(1);
    expect(repo.getJob(alive.id)?.status).toBe('processing');
    expect(repo.getJob(dead.id)?.status).toBe('pending');
  });
});

describe('stale-reclaim herd jitter (run_at spread)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  let processor: JobQueueProcessor | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
    processor = null;
  });

  afterEach(async () => {
    if (processor !== null) {
      await processor.stop();
    }
    db.close();
  });

  const reclaimNow = (target: JobQueueProcessor) =>
    (target as unknown as { reclaimStaleClaims(staleBefore: number): void }).reclaimStaleClaims(
      Date.now() - 5_000
    );

  it('spreads a reclaimed herd so no 1-second window schedules more than 3 jobs', async () => {
    const M = 6;
    const jobIds: string[] = [];
    for (let i = 0; i < M; i++) {
      jobIds.push(repo.enqueue({ queue: 'herd-queue', payload: { seq: i } }).id);
    }
    repo.dequeue('herd-queue', M);
    const pastTime = Date.now() - 20_000;
    db.prepare(
      `UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id IN (${jobIds.map(() => '?').join(',')})`
    ).run(pastTime, pastTime, ...jobIds);

    processor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5_000,
      maxConcurrent: 10,
      pollIntervalMs: 60_000,
      jitterRandom: () => 0.5,
    });
    processor.register('herd-queue', async () => {});

    const before = Date.now();
    reclaimNow(processor);
    const after = Date.now();

    const runAts = jobIds.map((id) => {
      const job = repo.getJob(id);
      expect(job?.status).toBe('pending');
      return job?.runAt ?? 0;
    });

    const windowMs = Math.min(M * 2_000, 30_000);
    for (const runAt of runAts) {
      expect(runAt).toBeGreaterThanOrEqual(before);
      expect(runAt).toBeLessThanOrEqual(after + windowMs);
    }

    const buckets = new Map<number, number>();
    for (const runAt of runAts) {
      const bucket = Math.floor((runAt - before) / 1_000);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(3);

    const spread = Math.max(...runAts) - Math.min(...runAts);
    expect(spread).toBeGreaterThanOrEqual((M - 2) * 2_000);

    expect(await processor.tick()).toBe(0);
    for (const id of jobIds) {
      expect(repo.getJob(id)?.status).toBe('pending');
    }

    db.prepare(
      `UPDATE job_queue SET run_at = ? WHERE id IN (${jobIds.map(() => '?').join(',')})`
    ).run(Date.now() - 1, ...jobIds);
    await processor.tick();
    await flush();
    for (const id of jobIds) {
      expect(repo.getJob(id)?.status).toBe('completed');
    }
  });

  it('re-enqueues a single stale job with no jitter delay (prompt recovery)', async () => {
    const job = repo.enqueue({ queue: 'lone-queue', payload: {} });
    repo.dequeue('lone-queue', 1);
    const pastTime = Date.now() - 20_000;
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      pastTime,
      pastTime,
      job.id
    );

    processor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5_000,
      maxConcurrent: 10,
      pollIntervalMs: 60_000,
      jitterRandom: () => 0.999_999,
    });
    processor.register('lone-queue', async () => {});

    const before = Date.now();
    reclaimNow(processor);
    const after = Date.now();

    const reclaimed = repo.getJob(job.id);
    expect(reclaimed?.status).toBe('pending');
    expect(reclaimed?.runAt).toBeGreaterThanOrEqual(before);
    expect(reclaimed?.runAt).toBeLessThanOrEqual(after);

    expect(await processor.tick()).toBe(1);
  });

  it('isolates a single failed reschedule: the rest of the herd keeps its jitter', () => {
    const jobs = [
      repo.enqueue({ queue: 'isolate-queue', payload: { seq: 0 } }),
      repo.enqueue({ queue: 'isolate-queue', payload: { seq: 1 } }),
      repo.enqueue({ queue: 'isolate-queue', payload: { seq: 2 } }),
    ];
    const ids = jobs.map((job) => job.id);
    const originalRunAt = Date.now() - 60_000;
    db.prepare(`UPDATE job_queue SET run_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(
      originalRunAt,
      ...ids
    );

    const originalReschedule = repo.reschedulePending.bind(repo);
    const failures: Array<{ jobId: string; error: unknown }> = [];
    const before = Date.now();
    try {
      repo.reschedulePending = (jobId: string, runAt: number) => {
        if (jobId === ids[1]) throw new Error('simulated I/O error');
        return originalReschedule(jobId, runAt);
      };

      const applied = applyStaleReclaimJitter(
        repo,
        ids,
        () => 0.5,
        (jobId, error) => {
          failures.push({ jobId, error });
        }
      );
      const after = Date.now();

      expect(applied).toBe(2);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.jobId).toBe(ids[1]);
      expect(failures[0]?.error).toBeInstanceOf(Error);

      const [first, second, third] = ids.map((id) => repo.getJob(id)?.runAt ?? 0);
      const windowMs = 3 * 2_000;
      for (const runAt of [first, third]) {
        expect(runAt).toBeGreaterThanOrEqual(before);
        expect(runAt).toBeLessThanOrEqual(after + windowMs);
      }
      expect(first).not.toBe(third);
      expect(second).toBe(originalRunAt);
    } finally {
      repo.reschedulePending = originalReschedule;
    }
  });

  it('a throwing error observer cannot skip the remaining reschedules', () => {
    const ids = [
      repo.enqueue({ queue: 'observer-queue', payload: { seq: 0 } }),
      repo.enqueue({ queue: 'observer-queue', payload: { seq: 1 } }),
    ].map((job) => job.id);
    const originalRunAt = Date.now() - 60_000;
    db.prepare(`UPDATE job_queue SET run_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(
      originalRunAt,
      ...ids
    );

    const originalReschedule = repo.reschedulePending.bind(repo);
    const before = Date.now();
    try {
      repo.reschedulePending = (jobId: string, runAt: number) => {
        if (jobId === ids[0]) throw new Error('simulated I/O error');
        return originalReschedule(jobId, runAt);
      };

      let applied = -1;
      expect(() => {
        applied = applyStaleReclaimJitter(
          repo,
          ids,
          () => 0.5,
          () => {
            throw new Error('observer bug');
          }
        );
      }).not.toThrow();

      expect(applied).toBe(1);
      expect(repo.getJob(ids[0])?.runAt).toBe(originalRunAt);
      expect(repo.getJob(ids[1])?.runAt).toBeGreaterThanOrEqual(before);
      expect(repo.getJob(ids[1])?.runAt).toBeLessThanOrEqual(before + 2 * 2_000);
    } finally {
      repo.reschedulePending = originalReschedule;
    }
  });

  it('spreads a graceful-shutdown requeue herd on the next boot (deploy path)', async () => {
    const M = 6;
    const jobIds: string[] = [];
    for (let i = 0; i < M; i++) {
      jobIds.push(repo.enqueue({ queue: 'shutdown-herd-queue', payload: { seq: i } }).id);
    }
    repo.dequeue('shutdown-herd-queue', M);

    const requeued = repo.requeueAllProcessing('shutdown-herd-queue', Date.now());
    expect(requeued).toHaveLength(M);
    expect(new Set(requeued).size).toBe(M);

    expect(applyStaleReclaimJitter(repo, requeued, () => 0.5)).toBe(M);

    processor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5 * 60_000,
      maxConcurrent: 64,
      pollIntervalMs: 60_000,
      jitterRandom: () => 0.5,
    });
    const processed: string[] = [];
    processor.register('shutdown-herd-queue', async (j) => {
      processed.push(j.id);
    });
    processor.start();
    await flush();
    expect(processed).toEqual([]);
    for (const id of jobIds) {
      expect(repo.getJob(id)?.status).toBe('pending');
    }

    db.prepare(
      `UPDATE job_queue SET run_at = ? WHERE id IN (${jobIds.map(() => '?').join(',')})`
    ).run(Date.now() - 1, ...jobIds);
    await processor.tick();
    await flush();
    expect(processed).toHaveLength(M);
    for (const id of jobIds) {
      expect(repo.getJob(id)?.status).toBe('completed');
    }
  });

  it('a failed jitter reschedule falls back to claimable rows, still aborts predecessors, and warns', async () => {
    const events: Array<{
      message: string;
      level: string;
      metadata: Record<string, unknown>;
    }> = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
    const originalReschedule = repo.reschedulePending.bind(repo);

    processor = new JobQueueProcessor(repo, {
      staleThresholdMs: 60_000,
      maxConcurrent: 10,
      pollIntervalMs: 60_000,
      jitterRandom: () => 0.5,
    });
    const signals: AbortSignal[] = [];
    let handlerCalls = 0;
    processor.register('message_delivery', (_job, context) => {
      handlerCalls++;
      signals.push(context!.signal);
      if (handlerCalls === 1) {
        return new Promise<void>((resolve) => {
          context!.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    });

    try {
      const live = repo.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 's-live', messageUuid: 'm-live', role: 'turn' },
      });
      expect(await processor.tick()).toBe(1);
      await flush();
      expect(signals).toHaveLength(1);

      const frozen = [
        repo.enqueue({
          queue: 'message_delivery',
          payload: { sessionId: 's-a', messageUuid: 'm-a', role: 'turn' },
        }),
        repo.enqueue({
          queue: 'message_delivery',
          payload: { sessionId: 's-b', messageUuid: 'm-b', role: 'turn' },
        }),
      ];
      repo.dequeue('message_delivery', 2);

      const staleLease = Date.now() - 30_000;
      db.prepare(
        `UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id IN (${[live, ...frozen].map(() => '?').join(',')})`
      ).run(staleLease, staleLease, live.id, ...frozen.map((j) => j.id));

      const beforeReclaim = Date.now();
      repo.reschedulePending = () => {
        throw new Error('simulated disk-full');
      };

      expect(() => reclaimNow(processor)).not.toThrow();

      const jitterFailures = events.filter(
        (event) => event.metadata.event === 'stale_reclaim_jitter_failed'
      );
      expect(jitterFailures).toHaveLength(3);
      expect(new Set(jitterFailures.map((event) => event.metadata.jobId)).size).toBe(3);
      for (const event of jitterFailures) {
        expect(event.level).toBe('warn');
        expect(event.metadata.reason).toContain('reschedule_failed');
        expect(event.metadata.reason).toContain('simulated disk-full');
      }

      for (const job of [live, ...frozen]) {
        const row = repo.getJob(job.id);
        expect(row?.status).toBe('pending');
        expect(row?.runAt).toBeLessThanOrEqual(beforeReclaim);
      }

      expect(await processor.tick()).toBe(2);
      expect(repo.getJob(live.id)?.status).toBe('pending');

      await flush();
      expect(signals[0].aborted).toBe(true);
      expect(await processor.tick()).toBe(1);
      await flush();
      for (const job of [live, ...frozen]) {
        expect(repo.getJob(job.id)?.status).toBe('completed');
      }
    } finally {
      repo.reschedulePending = originalReschedule;
      unsubscribe();
      clearStructuredLogSubscribers();
    }
  });
});

describe('staleReclaimJitterDelays', () => {
  const seededRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it('returns no delay for herds of 0 and 1 — a single stuck job recovers immediately', () => {
    expect(staleReclaimJitterDelays(0, Math.random)).toEqual([]);
    expect(staleReclaimJitterDelays(1, () => 0.999_999)).toEqual([0]);
  });

  it('assigns each job a distinct slot of the spread window (deterministic random)', () => {
    expect(staleReclaimJitterDelays(6, () => 0)).toEqual([2_000, 4_000, 6_000, 8_000, 10_000, 0]);
  });

  it('bounds every delay to min(M·2 s, 30 s) with no 1-second bucket above 3 jobs', () => {
    for (const count of [2, 10, 15, 40, 60]) {
      const windowMs = Math.min(count * 2_000, 30_000);
      for (let pass = 0; pass < 50; pass++) {
        const delays = staleReclaimJitterDelays(count, seededRandom(count * 1_000 + pass));
        expect(delays).toHaveLength(count);
        const buckets = new Map<number, number>();
        for (const delay of delays) {
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThan(windowMs);
          const bucket = Math.floor(delay / 1_000);
          buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        }
        expect(Math.max(...buckets.values())).toBeLessThanOrEqual(3);
      }
    }
  });

  it('randomizes the slot order per pass — restarts never produce a deterministic stagger', () => {
    const signatures = new Set<string>();
    for (let pass = 0; pass < 20; pass++) {
      const delays = staleReclaimJitterDelays(10, seededRandom(pass + 1));
      signatures.add(delays.map((delay) => Math.floor(delay / 2_000)).join(','));
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('clamps adversarial draws (NaN, ≥1, negative) to valid delays', () => {
    const adversarial = [Number.NaN, 1.7, -0.5, 1.0, 0.5, Number.POSITIVE_INFINITY];
    let draw = 0;
    const delays = staleReclaimJitterDelays(6, () => adversarial[draw++ % adversarial.length]);
    expect(delays).toHaveLength(6);
    for (const delay of delays) {
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(Math.min(6 * 2_000, 30_000));
    }
  });
});
