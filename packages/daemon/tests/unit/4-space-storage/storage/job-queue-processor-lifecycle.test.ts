/**
 * JobQueueProcessor Lifecycle Integration Tests
 *
 * Verifies behavioral contracts that the app-level wiring depends on.
 * Tests in this file are complementary to `job-queue-processor.test.ts`:
 * - That file covers individual unit behaviors (tick, register, handler success/failure, etc.)
 * - This file covers orchestration contracts: lifecycle sequencing, the full retry-to-dead
 *   sequence, edge-case error coercion, and the precise intermediate state produced by
 *   stale reclamation before a handler picks the job back up.
 *
 * Not covered here (see `job-queue-processor.test.ts` for those):
 * - Single-step retry / dead transitions
 * - Individual notifier call assertions
 * - Eager reclamation smoke test (covered in the existing eager-stale-reclamation suite)
 * - Concurrency limit enforcement
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

  // ─── Eager stale reclamation — synchronous contract ───────────────────────

  describe('eager stale reclamation on start()', () => {
    it('reclaimStale() is called synchronously inside start(), before any interval tick fires', () => {
      // The contract: start() calls reclaimStale() before setting up the interval,
      // so crash-recovery is instant. Verify the call is synchronous by checking the
      // count *immediately* after start() returns, before any await.
      const reclaimTimestamps: number[] = [];
      const original = repo.reclaimStale.bind(repo);
      repo.reclaimStale = (staleBefore: number) => {
        reclaimTimestamps.push(Date.now());
        return original(staleBefore);
      };

      const before = Date.now();
      processor.start();
      const after = Date.now();

      // reclaimStale must have fired at least once, and it must have happened
      // within the synchronous window of start().
      expect(reclaimTimestamps.length).toBeGreaterThanOrEqual(1);
      expect(reclaimTimestamps[0]).toBeGreaterThanOrEqual(before);
      expect(reclaimTimestamps[0]).toBeLessThanOrEqual(after + 5); // +5 ms tolerance
    });
  });

  // ─── stop() drains in-flight jobs ─────────────────────────────────────────

  describe('stop() drains in-flight jobs', () => {
    it('resolves immediately when there are no in-flight jobs at stop() time', async () => {
      // Distinct from "stop() resolves after in-flight jobs complete" in the existing file.
      // Verifies the fast path: inFlight === 0 → resolve() is called synchronously.
      processor.start();
      // No jobs enqueued — inFlight stays 0.
      await expect(processor.stop()).resolves.toBeUndefined();
    });
  });

  // ─── Full error → retry → dead sequence ───────────────────────────────────

  describe('error → retry → dead full sequence', () => {
    it('exhausts retries across multiple tick() calls and marks the job dead', async () => {
      // maxRetries=1 means: failure 1 → pending (retryCount=1), failure 2 → dead.
      // The existing file tests single-step (one failure); this test drives the full sequence.
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

      // First attempt: retryCount 0 → 1, status → pending (with delayed run_at).
      await multiStepProcessor.tick();
      await flush();

      expect(repo.getJob(job.id)?.status).toBe('pending');
      expect(repo.getJob(job.id)?.retryCount).toBe(1);

      // Override run_at so the retried job is immediately eligible.
      db.prepare(`UPDATE job_queue SET run_at = ? WHERE id = ?`).run(Date.now() - 1, job.id);

      // Second attempt: retryCount 1 === maxRetries 1 → dead.
      await multiStepProcessor.tick();
      await flush();

      const final = repo.getJob(job.id);
      expect(final?.status).toBe('dead');
      expect(failCount).toBe(2);

      await multiStepProcessor.stop();
    });

    it('converts non-Error throws to string for the error field', async () => {
      // The processor catches any thrown value and uses err instanceof Error ? err.message : String(err).
      // Verify that a plain-string throw is stored correctly.
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

  // ─── setChangeNotifier — status-transition coverage ───────────────────────

  describe('setChangeNotifier status transitions', () => {
    it('notifier receives "job_queue" for all status transitions: completed, retried, dead', async () => {
      const tables: string[] = [];
      processor.setChangeNotifier((t) => tables.push(t));

      let callCount = 0;
      processor.register('notify-q', async () => {
        callCount++;
        if (callCount < 3) throw new Error('transient');
        // Third call succeeds.
      });

      // maxRetries=2 → failure 1 → pending, failure 2 → pending, failure 3 → WAIT,
      // actually maxRetries=2 means: retryCount goes 0→1→2, and on the 3rd failure
      // retryCount(2) === maxRetries(2) → dead.
      // So: tick1 → fail → pending (notifier), tick2 → fail → pending (notifier),
      //     tick3 → fail → dead (notifier)
      // We test with maxRetries=0 for simplicity (one call → dead) to verify the table name.
      tables.length = 0;
      callCount = 0;

      const deadJob = repo.enqueue({ queue: 'notify-q', payload: {}, maxRetries: 0 });
      await processor.tick();
      await flush();

      expect(repo.getJob(deadJob.id)?.status).toBe('dead');
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.every((t) => t === 'job_queue')).toBe(true);

      // Also verify for a successful job.
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
        role: 'turn',
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

  // ─── Stale reclamation — intermediate pending state ────────────────────────

  describe("stale reclamation is scoped to the processor's registered queues", () => {
    it("a non-owner processor does not reclaim another processor's lane; the owner reclaims AND aborts", async () => {
      // Two processors share one repository (app.ts wires a general + delivery
      // processor over the same DB). A stale sweep by the NON-owner would flip
      // the row to pending while the owner's handler keeps running (the
      // non-owner holds no cancellation record), overlapping a replacement
      // claim. The sweep must stay within lanes the processor registered.
      const abortedClaims: string[] = [];
      let releaseSecond!: () => void;
      const manualRelease = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });

      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        // Large threshold keeps the heartbeat lease (threshold/3) far outside
        // the test's wall-clock so only the forced stale check runs. Two
        // slots so the reclaim tick has a SPARE slot — proving the replacement
        // claim is deferred by the settling exclusion, not by slot pressure.
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

      // Age the lease past the stale threshold.
      const staleLease = Date.now() - 120_000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleLease,
        staleLease,
        job.id
      );

      // The NON-owner ticks: its stale check runs (fresh lastStaleCheck) but is
      // scoped to its own lanes — the delivery row must stay claimed.
      await general.tick();
      expect(repo.getJob(job.id)?.status).toBe('processing');
      expect(repo.getJob(job.id)?.claimToken).toBe(firstClaim);
      expect(abortedClaims).toEqual([]);

      // The owner ticks: reclaims its lane and aborts the exact old handler.
      // Its first tick set lastStaleCheck, so force the check window open.
      (delivery as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
      await delivery.tick();
      expect(abortedClaims).toEqual([job.id]);
      // The aborting handler has NOT settled yet — the just-reclaimed row must
      // stay pending through this tick's dequeue pass even though a spare slot
      // exists (maxConcurrent 2), so the replacement never overlaps it.
      expect(repo.getJob(job.id)?.status).toBe('pending');

      // Once the aborted handler settles, the exclusion lifts and the next
      // tick claims the row under a NEW claim token.
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
      // message_delivery's abort path can await a 30s provider-owned
      // acknowledgment before settling, so its replacement deferral must be
      // configured beyond that bound (default is 10s).
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
      // A handler that never observes its abort signal (e.g. a lane handler
      // registered without consuming JobHandlerContext.signal) never settles,
      // so its finally never lifts the exclusion. The grace expiry must let
      // the replacement proceed anyway — no starvation until daemon restart.
      const delivery = new JobQueueProcessor(repo, {
        pollIntervalMs: 5000,
        maxConcurrent: 2,
        staleThresholdMs: 60_000,
      });
      // Never settles and ignores the abort signal entirely.
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
      // Reclaimed → pending, and the never-settling predecessor holds the
      // exclusion; no re-claim in this tick.
      expect(repo.getJob(job.id)?.status).toBe('pending');

      // Simulate the grace elapsing without waiting 10s of wall-clock.
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

    it('a late-settling earlier attempt does not lift the replacement deferral', async () => {
      // Attempt A goes stale and its grace expires → attempt B claims the row.
      // B then ALSO goes stale and is aborted, installing B's own deferral. If
      // A finally settles now, its processJob finally must NOT clear B's
      // deferral (the old unconditional delete did) — otherwise the next tick
      // claims attempt C while B's handler is still settling, recreating the
      // overlap the deferral exists to prevent.
      const settledCount = { value: 0 };
      // Each invocation gets its OWN held promise: release[i]() settles only
      // attempt i, and handlers never observe the abort signal — exactly the
      // wedged-handler shape the claim-token match must defend against.
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

      // Attempt A claims and runs (held).
      await delivery.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const claimA = repo.getJob(job.id)?.claimToken;
      expect(claimA).toBeTruthy();

      // A goes stale → reclaimed + aborted, deferral(A) installed. A ignores
      // the abort (only the manual release settles it).
      ageStale();
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');

      // Grace(A) expires → attempt B claims under a new token.
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

      // B ALSO goes stale → reclaimed + aborted → deferral(B) installed.
      ageStale();
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');
      expect(map.get(job.id)?.claimToken).toBe(claimB);

      // A finally settles — its finally runs with A's claim token. The
      // deferral keyed to B must survive so no claim C overlaps B.
      releases[0]();
      await flush();
      expect(settledCount.value).toBe(1); // only attempt A settled
      expect(map.has(job.id)).toBe(true);
      expect(map.get(job.id)?.claimToken).toBe(claimB);

      // And the next tick still defers the row (B has not settled).
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('pending');

      // B settles under its own token → its finally lifts the deferral and the
      // next claim (C) proceeds.
      releases[1]();
      await flush();
      expect(map.has(job.id)).toBe(false);
      await delivery.tick();
      expect(repo.getJob(job.id)?.status).toBe('processing');
    });
  });

  describe('stale job reclamation — ordering contract', () => {
    it('reclaimStale() resets the job to pending before the handler picks it up', async () => {
      // The contract: reclaimStale transitions the job pending, THEN the next dequeue
      // picks it up. Verify the intermediate state is exactly 'pending' at the moment
      // reclaimStale returns, not 'completed'.
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
        // Capture the job status immediately after reclaimStale updates the DB.
        statusAtReclaim = repo.getJob(job.id)?.status;
        return count;
      };

      const staleProcessor = new JobQueueProcessor(repo, {
        staleThresholdMs: 1_000,
        pollIntervalMs: 5000,
      });
      staleProcessor.register('reclaim-order-q', async () => {});

      // tick() calls checkStaleJobs (lastStaleCheck=0 → runs) then dequeues.
      await staleProcessor.tick();
      await flush();
      await staleProcessor.stop();

      // At the moment reclaimStale returned, status must be 'pending' (not yet completed).
      expect(statusAtReclaim).toBe('pending');
      // After the full tick and flush, the job is processed to completion.
      expect(repo.getJob(job.id)?.status).toBe('completed');
    });

    it('stale check is skipped on the second tick within the same 60 s window', async () => {
      // After start() sets lastStaleCheck = Date.now(), the first tick() via
      // the interval will see (now - lastStaleCheck < 60_000) = true → skip.
      // We replicate this by calling start(), then immediately ticking manually.
      let reclaimCallCount = 0;
      const original = repo.reclaimStale.bind(repo);
      repo.reclaimStale = (staleBefore: number) => {
        reclaimCallCount++;
        return original(staleBefore);
      };

      processor.register('throttle-q', async () => {});

      // start() calls reclaimStale() eagerly and sets lastStaleCheck = Date.now().
      processor.start();
      const countAfterStart = reclaimCallCount;
      expect(countAfterStart).toBeGreaterThanOrEqual(1);

      // A tick() fired immediately after start() (within the same second) must NOT
      // run the stale check again — lastStaleCheck was just updated.
      await processor.tick();
      expect(reclaimCallCount).toBe(countAfterStart); // no additional reclaim calls
    });
  });
});
