/**
 * Tests for stale job reclamation on daemon restart.
 *
 * Focuses on the eager reclaimStale() call added in Task 1.2 to `JobQueueProcessor.start()`.
 * This ensures that jobs stuck in `processing` due to a crash are reclaimed IMMEDIATELY
 * on restart — not after the 60-second STALE_CHECK_INTERVAL delay.
 *
 * The "crash" is simulated by directly manipulating the DB to leave a row in `processing`
 * state with a backdated `started_at`, then creating a fresh processor and calling start().
 * This covers the restart scenario more clearly than the general processor tests in
 * job-queue-processor.test.ts (which test the same processor before and after start()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  JobQueueProcessor,
  staleReclaimJitterDelays,
} from '../../../../src/storage/job-queue-processor';
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

/** Wait for async microtasks/macrotasks to settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Poll until predicate holds (bounded). Reclaimed herds re-claim on the
 * processor's poll cadence as their jittered run_at passes, so tests that
 * assert eventual re-processing wait instead of a single flush. */
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

  // Processor created in tests — each test is responsible for stopping it.
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
    // Simulate a crash: enqueue a job, dequeue it (marks it processing), then backdate
    // started_at to beyond the stale threshold — as if the previous process died mid-job.
    const job = repo.enqueue({ queue: 'work-queue', payload: { task: 'doSomething' } });
    repo.dequeue('work-queue', 1);
    expect(repo.getJob(job.id)?.status).toBe('processing');

    // Backdate started_at so the job is beyond the stale threshold (started 10 s ago)
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      Date.now() - 10_000,
      Date.now() - 10_000,
      job.id
    );

    // Daemon restarts — creates a fresh processor on the same DB
    const processed: string[] = [];
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 1_000,
      pollIntervalMs: 60_000, // large — ensures reclamation comes only from start(), not interval
    });
    restartedProcessor.register('work-queue', async (j) => {
      processed.push(j.id);
    });

    // start() must eagerly call reclaimStale() before the first interval tick
    restartedProcessor.start();

    // Give the immediate first tick time to pick up and process the reclaimed job
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

    // reclaimStale must be called synchronously inside start(), before any async work
    restartedProcessor.start();

    // Immediately after start() — before awaiting — the count must already be 1
    expect(reclaimCallCount).toBeGreaterThanOrEqual(1);

    await restartedProcessor.stop();
    restartedProcessor = null;
  });

  it('reclaimed job is re-processed by the registered handler', async () => {
    // Simulate crash: leave a stale processing job in the DB
    const job = repo.enqueue({ queue: 'crash-queue', payload: { value: 42 } });
    repo.dequeue('crash-queue', 1);
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      Date.now() - 30_000,
      Date.now() - 30_000,
      job.id
    );
    expect(repo.getJob(job.id)?.status).toBe('processing');

    // Restart: new processor registers a handler that records the received job
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
    // Enqueue and dequeue to mark as processing — started_at will be ~now
    const job = repo.enqueue({ queue: 'fresh-queue', payload: {} });
    repo.dequeue('fresh-queue', 1);
    expect(repo.getJob(job.id)?.status).toBe('processing');

    // 60-second threshold — a job started moments ago is NOT stale
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

    // Job should remain processing — it was not reclaimed
    const after = repo.getJob(job.id);
    expect(after?.status).toBe('processing');
    expect(processed).not.toContain(job.id);
  });

  it('reclaims multiple stale jobs from different queues on startup', async () => {
    // Simulate crash leaving stale jobs across two queues
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
      // Near the production 1 s cadence, with near-zero jitter draws: a herd
      // of two still spans one 2 s slot boundary, so the second job claims on
      // a later poll — but this test covers eager multi-queue reclamation,
      // not the spread (which has its own describes below).
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
  });

  it('does not interfere with a pending job that was never picked up', async () => {
    // Enqueue the stale job first so dequeue picks it up (dequeue orders by run_at ASC)
    const stale = repo.enqueue({ queue: 'mixed-queue', payload: { type: 'stale' } });
    repo.dequeue('mixed-queue', 1); // marks stale job as processing
    db.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(
      Date.now() - 15_000,
      Date.now() - 15_000,
      stale.id
    );
    expect(repo.getJob(stale.id)?.status).toBe('processing');

    // Pending job — enqueued after, never dequeued, still pending
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

    // Both should be completed — stale reclaimed + pending picked up normally
    expect(repo.getJob(stale.id)?.status).toBe('completed');
    expect(repo.getJob(pending.id)?.status).toBe('completed');
    expect(processedTypes).toContain('stale');
    expect(processedTypes).toContain('new');
  });

  // Task #861 item 5 — a slow-but-alive turn (long MCP startup / provider
  // request) must NOT be falsely reclaimed. The message-delivery handler
  // heartbeats `heartbeat_at` throughout every handler; a job whose lease was
  // refreshed inside the stale window is NOT reclaimed, while
  // one whose handler stopped heartbeating (crash) IS.
  it('does NOT reclaim a processing job whose lease was heartbeated inside the window (item 5)', () => {
    const alive = repo.enqueue({ queue: 'message_delivery', payload: {}, runAt: 0 });
    const dead = repo.enqueue({ queue: 'message_delivery', payload: {}, runAt: 0 });
    // Claim both → processing.
    repo.dequeue('message_delivery', 2);
    expect(repo.getJob(alive.id)?.status).toBe('processing');
    expect(repo.getJob(dead.id)?.status).toBe('processing');

    const staleThresholdMs = 5_000;
    // Backdate both past the window as if their handlers died long ago.
    const longAgo = Date.now() - (staleThresholdMs + 5_000);
    db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id IN (?, ?)`).run(
      longAgo,
      longAgo,
      alive.id,
      dead.id
    );

    // The alive job's handler is STILL running and renews the exact claim;
    // the dead one's is not.
    expect(repo.heartbeat(alive.id, repo.getJob(alive.id)!.claimToken)).toBe(true);

    // reclaimStale (as the processor runs eagerly on start + every 60s) only
    // reclaims jobs still past the window — the heartbeated one stays processing.
    const reclaimed = repo.reclaimStale(Date.now() - staleThresholdMs);
    expect(reclaimed).toHaveLength(1);
    expect(repo.getJob(alive.id)?.status).toBe('processing'); // alive — NOT reclaimed
    expect(repo.getJob(dead.id)?.status).toBe('pending'); // dead — reclaimed, re-drives
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

  /** Force a stale-reclaim pass without start()'s poll timer, as the
   * processor-lifecycle tests do — the scheduling effect on run_at is the
   * object under test, not the claim cadence. */
  const reclaimNow = (target: JobQueueProcessor) =>
    (target as unknown as { reclaimStaleClaims(staleBefore: number): void }).reclaimStaleClaims(
      Date.now() - 5_000
    );

  it('spreads a reclaimed herd so no 1-second window schedules more than 3 jobs', async () => {
    // The 2026-08-16 delivery stall at unit scale: a daemon dying with M
    // in-flight deliveries froze them `processing`; stale-reclaim re-enqueued
    // all M in the same instant and every replacement claim cold-started its
    // SDK subprocess at once (10 claims within 12 ms → a self-sustaining
    // timeout/retry loop). The reclaim pass must spread the herd's run_at.
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
      maxConcurrent: 10, // spare capacity — the herd must still not be claimable at once
      pollIntervalMs: 60_000,
      // Constant 0.5 makes the shuffle + offsets deterministic: one fixed
      // permutation of the 2 s slots, offsets at each slot's midpoint.
      jitterRandom: () => 0.5,
    });
    processor.register('herd-queue', async () => {});

    const before = Date.now();
    reclaimNow(processor);
    const after = Date.now();

    const runAts = jobIds.map((id) => {
      const job = repo.getJob(id);
      expect(job?.status).toBe('pending'); // re-enqueued, not yet claimable
      return job?.runAt ?? 0;
    });

    // Every run_at is now + jitter, within the M·2 s window (12 s for M=6).
    const windowMs = Math.min(M * 2_000, 30_000);
    for (const runAt of runAts) {
      expect(runAt).toBeGreaterThanOrEqual(before);
      expect(runAt).toBeLessThanOrEqual(after + windowMs);
    }

    // Acceptance: no 1-second bucket holds more than 3 reclaimed jobs.
    const buckets = new Map<number, number>();
    for (const runAt of runAts) {
      const bucket = Math.floor((runAt - before) / 1_000);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(3);

    // Distinct 2 s slots ⇒ the herd spans ≥ (M-2) slots of real spread.
    const spread = Math.max(...runAts) - Math.min(...runAts);
    expect(spread).toBeGreaterThanOrEqual((M - 2) * 2_000);

    // With every run_at in the future, an immediate tick claims NONE of the
    // herd — the synchronized claim is gone.
    expect(await processor.tick()).toBe(0);
    for (const id of jobIds) {
      expect(repo.getJob(id)?.status).toBe('pending');
    }

    // Once each jittered run_at passes, jobs claim and complete normally —
    // the jitter delayed them, it did not park them.
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
      // Adversarial: max jitter if the M=1 guard were missing.
      jitterRandom: () => 0.999_999,
    });
    processor.register('lone-queue', async () => {});

    const before = Date.now();
    reclaimNow(processor);
    const after = Date.now();

    const reclaimed = repo.getJob(job.id);
    expect(reclaimed?.status).toBe('pending');
    expect(reclaimed?.runAt).toBeGreaterThanOrEqual(before);
    expect(reclaimed?.runAt).toBeLessThanOrEqual(after); // delay 0 — immediately claimable

    // The next tick claims it right away — a single stuck job does not wait
    // out a herd window that no longer exists.
    expect(await processor.tick()).toBe(1);
  });

  it('spreads a graceful-shutdown requeue herd on the next boot (deploy path)', async () => {
    // The SIGTERM twin of the crash herd: app.cleanup() requeues in-flight
    // rows to pending with run_at=now (the eager stale-reclaim never sees
    // them — it only sweeps `processing`), so the next boot's FIRST tick
    // would claim the whole fleet at once unless the shutdown requeue also
    // jitters. Mirrors the app.ts sequence: stopPolling → requeueAllProcessing
    // → staleReclaimJitterDelays + reschedulePending → restart.
    const M = 6;
    const jobIds: string[] = [];
    for (let i = 0; i < M; i++) {
      jobIds.push(repo.enqueue({ queue: 'shutdown-herd-queue', payload: { seq: i } }).id);
    }
    repo.dequeue('shutdown-herd-queue', M);

    const requeued = repo.requeueAllProcessing('shutdown-herd-queue', Date.now());
    expect(requeued).toHaveLength(M);
    expect(new Set(requeued).size).toBe(M);

    // The shutdown jitter app.ts applies (constant 0.5 → fixed permutation,
    // offsets at each 2 s slot's midpoint; every run_at ≥ 1 s out).
    const jitteredAt = Date.now();
    const delays = staleReclaimJitterDelays(requeued.length, () => 0.5);
    requeued.forEach((id, i) => {
      expect(repo.reschedulePending(id, jitteredAt + delays[i])).toBe(true);
    });

    // Next boot: a fresh processor's eager reclaim finds nothing `processing`,
    // and its first tick claims NONE of the herd — every run_at is future.
    processor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5 * 60_000,
      maxConcurrent: 64, // the production delivery budget
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

    // Once each jittered run_at passes, the herd claims and completes normally.
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
});

describe('staleReclaimJitterDelays', () => {
  /** Deterministic PRNG (mulberry32) so the spread assertions are reproducible. */
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
    // random() = 0 ⇒ offsets 0 and a fixed permutation: the delays are exactly
    // the slot edges 0, 2 s, 4 s, … 12 s window for M=6.
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
      // Each job's slot index (2 s slots for M=10), in job order.
      signatures.add(delays.map((delay) => Math.floor(delay / 2_000)).join(','));
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('clamps adversarial draws (NaN, ≥1, negative) to valid delays', () => {
    // A NaN draw must not leak into run_at: NaN binds as NULL in SQLite and
    // fails `run_at <= now` forever, silently parking the job.
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
