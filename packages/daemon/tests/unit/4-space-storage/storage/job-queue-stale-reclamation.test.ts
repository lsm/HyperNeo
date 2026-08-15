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
		completed_at INTEGER
	);
	CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
	CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
`;

/** Wait for async microtasks/macrotasks to settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

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
    db.prepare('UPDATE job_queue SET started_at = ? WHERE id = ?').run(Date.now() - 10_000, job.id);

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
    db.prepare('UPDATE job_queue SET started_at = ? WHERE id = ?').run(Date.now() - 30_000, job.id);
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
    db.prepare('UPDATE job_queue SET started_at = ? WHERE id IN (?, ?)').run(
      pastTime,
      jobA.id,
      jobB.id
    );

    const processedQueues: string[] = [];
    restartedProcessor = new JobQueueProcessor(repo, {
      staleThresholdMs: 5_000,
      maxConcurrent: 10,
      pollIntervalMs: 60_000,
    });
    restartedProcessor.register('queue-a', async (j) => {
      processedQueues.push(j.queue);
    });
    restartedProcessor.register('queue-b', async (j) => {
      processedQueues.push(j.queue);
    });

    restartedProcessor.start();
    await flush();

    expect(repo.getJob(jobA.id)?.status).toBe('completed');
    expect(repo.getJob(jobB.id)?.status).toBe('completed');
    expect(processedQueues).toContain('queue-a');
    expect(processedQueues).toContain('queue-b');
  });

  it('does not interfere with a pending job that was never picked up', async () => {
    // Enqueue the stale job first so dequeue picks it up (dequeue orders by run_at ASC)
    const stale = repo.enqueue({ queue: 'mixed-queue', payload: { type: 'stale' } });
    repo.dequeue('mixed-queue', 1); // marks stale job as processing
    db.prepare('UPDATE job_queue SET started_at = ? WHERE id = ?').run(
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
  // heartbeats `started_at` (touchStartedAt) throughout the turn await; a job
  // whose lease was refreshed inside the stale window is NOT reclaimed, while
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
    db.prepare(`UPDATE job_queue SET started_at = ? WHERE id IN (?, ?)`).run(
      longAgo,
      alive.id,
      dead.id
    );

    // The alive job's handler is STILL running and heartbeats (refreshes
    // started_at to now); the dead one's is not.
    expect(repo.touchStartedAt(alive.id)).toBe(true);

    // reclaimStale (as the processor runs eagerly on start + every 60s) only
    // reclaims jobs still past the window — the heartbeated one stays processing.
    const reclaimed = repo.reclaimStale(Date.now() - staleThresholdMs);
    expect(reclaimed).toHaveLength(1);
    expect(repo.getJob(alive.id)?.status).toBe('processing'); // alive — NOT reclaimed
    expect(repo.getJob(dead.id)?.status).toBe('pending'); // dead — reclaimed, re-drives
  });
});
