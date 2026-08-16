import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

describe('JobQueueRepository', () => {
  let db: Database;
  let repository: JobQueueRepository;

  beforeEach(() => {
    db = new Database(':memory:');
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
				completed_at INTEGER
			);

			CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
			CREATE INDEX idx_job_queue_status ON job_queue(status);
		`);
    repository = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  describe('enqueue', () => {
    it('creates a job with correct defaults', () => {
      const before = Date.now();
      const job = repository.enqueue({ queue: 'test', payload: { action: 'run' } });
      const after = Date.now();

      expect(job.status).toBe('pending');
      expect(job.priority).toBe(0);
      expect(job.maxRetries).toBe(3);
      expect(job.retryCount).toBe(0);
      expect(job.runAt).toBeGreaterThanOrEqual(before);
      expect(job.runAt).toBeLessThanOrEqual(after);
      expect(job.startedAt).toBeNull();
      expect(job.completedAt).toBeNull();
      expect(job.error).toBeNull();
      expect(job.result).toBeNull();
    });

    it('respects custom priority, maxRetries, and runAt', () => {
      const futureTime = Date.now() + 60_000;
      const job = repository.enqueue({
        queue: 'test',
        payload: {},
        priority: 10,
        maxRetries: 5,
        runAt: futureTime,
      });

      expect(job.priority).toBe(10);
      expect(job.maxRetries).toBe(5);
      expect(job.runAt).toBe(futureTime);
    });

    it('stores payload as JSON and retrieves it correctly', () => {
      const payload = { action: 'process', data: { count: 42, tags: ['a', 'b'] } };
      const job = repository.enqueue({ queue: 'test', payload });

      expect(job.payload).toEqual(payload);
    });

    it('atomically skips duplicate active jobs by payload fields', () => {
      const first = repository.enqueueUniquePending({
        queue: 'conversation-friction',
        payload: { scopeId: 'scope-1', taskId: 'task-1' },
        matchPayload: { scopeId: 'scope-1', taskId: 'task-1' },
      });
      const duplicate = repository.enqueueUniquePending({
        queue: 'conversation-friction',
        payload: { scopeId: 'scope-1', taskId: 'task-1' },
        matchPayload: { scopeId: 'scope-1', taskId: 'task-1' },
      });
      const nullKey = repository.enqueueUniquePending({
        queue: 'conversation-friction',
        payload: { scopeId: 'scope-1', taskId: null },
        matchPayload: { scopeId: 'scope-1', taskId: null },
      });
      const nullKeyDuplicate = repository.enqueueUniquePending({
        queue: 'conversation-friction',
        payload: { scopeId: 'scope-1', taskId: null },
        matchPayload: { scopeId: 'scope-1', taskId: null },
      });
      const other = repository.enqueueUniquePending({
        queue: 'conversation-friction',
        payload: { scopeId: 'scope-1', taskId: 'task-2' },
        matchPayload: { scopeId: 'scope-1', taskId: 'task-2' },
      });

      expect(first).not.toBeNull();
      expect(duplicate).toBeNull();
      expect(nullKey).not.toBeNull();
      expect(nullKeyDuplicate).toBeNull();
      expect(other).not.toBeNull();
      expect(repository.listJobs({ queue: 'conversation-friction', limit: 10 })).toHaveLength(3);
    });

    it('assigns each job a unique UUID', () => {
      const job1 = repository.enqueue({ queue: 'test', payload: {} });
      const job2 = repository.enqueue({ queue: 'test', payload: {} });
      const job3 = repository.enqueue({ queue: 'test', payload: {} });

      expect(job1.id).not.toBe(job2.id);
      expect(job2.id).not.toBe(job3.id);
      expect(job1.id).not.toBe(job3.id);
    });
  });

  describe('dequeue', () => {
    it('claims pending jobs and marks them as processing', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');

      expect(job.status).toBe('processing');
    });

    it('sets startedAt timestamp', () => {
      const before = Date.now();
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');
      const after = Date.now();

      expect(job.startedAt).not.toBeNull();
      expect(job.startedAt!).toBeGreaterThanOrEqual(before);
      expect(job.startedAt!).toBeLessThanOrEqual(after);
    });

    it('respects priority ordering (higher priority first)', () => {
      repository.enqueue({ queue: 'test', payload: { p: 0 }, priority: 0 });
      repository.enqueue({ queue: 'test', payload: { p: 5 }, priority: 5 });
      repository.enqueue({ queue: 'test', payload: { p: 2 }, priority: 2 });

      const jobs = repository.dequeue('test', 3);

      expect(jobs[0].payload.p).toBe(5);
      expect(jobs[1].payload.p).toBe(2);
      expect(jobs[2].payload.p).toBe(0);
    });

    it('only dequeues jobs where run_at <= now', () => {
      repository.enqueue({ queue: 'test', payload: { label: 'ready' }, runAt: Date.now() - 1000 });
      repository.enqueue({
        queue: 'test',
        payload: { label: 'future' },
        runAt: Date.now() + 60_000,
      });

      const jobs = repository.dequeue('test', 10);

      expect(jobs.length).toBe(1);
      expect(jobs[0].payload.label).toBe('ready');
    });

    it('does NOT dequeue future-scheduled jobs', () => {
      repository.enqueue({ queue: 'test', payload: {}, runAt: Date.now() + 60_000 });

      const jobs = repository.dequeue('test');

      expect(jobs.length).toBe(0);
    });

    it('does NOT dequeue already-processing jobs', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.dequeue('test', 1);

      const jobs = repository.dequeue('test', 1);

      expect(jobs.length).toBe(0);
    });

    it('returns empty array when no pending jobs', () => {
      const jobs = repository.dequeue('test');

      expect(jobs).toEqual([]);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repository.enqueue({ queue: 'test', payload: { i } });
      }

      const jobs = repository.dequeue('test', 3);

      expect(jobs.length).toBe(3);
    });

    it('multiple dequeues do not return the same job', () => {
      repository.enqueue({ queue: 'test', payload: { n: 1 } });
      repository.enqueue({ queue: 'test', payload: { n: 2 } });
      repository.enqueue({ queue: 'test', payload: { n: 3 } });

      const first = repository.dequeue('test', 2);
      const second = repository.dequeue('test', 2);

      expect(first.length).toBe(2);
      expect(second.length).toBe(1);

      const firstIds = new Set(first.map((j) => j.id));
      expect(firstIds.has(second[0].id)).toBe(false);
    });
  });

  describe('complete', () => {
    it('marks job as completed with completedAt timestamp', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [dequeued] = repository.dequeue('test');
      const before = Date.now();
      const job = repository.complete(dequeued.id);
      const after = Date.now();

      expect(job).not.toBeNull();
      expect(job!.status).toBe('completed');
      expect(job!.completedAt).not.toBeNull();
      expect(job!.completedAt!).toBeGreaterThanOrEqual(before);
      expect(job!.completedAt!).toBeLessThanOrEqual(after);
    });

    it('stores result JSON', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [dequeued] = repository.dequeue('test');
      const result = { success: true, count: 7 };
      const job = repository.complete(dequeued.id, result);

      expect(job!.result).toEqual(result);
    });

    it('returns null for non-existent job', () => {
      const job = repository.complete('non-existent-id');

      expect(job).toBeNull();
    });

    it('returns null for job not in processing status', () => {
      const enqueued = repository.enqueue({ queue: 'test', payload: {} });

      const job = repository.complete(enqueued.id);

      expect(job).toBeNull();
    });
  });

  describe('fail', () => {
    it('resets job to pending with incremented retryCount when retries remain', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 3 });
      const [dequeued] = repository.dequeue('test');
      const job = repository.fail(dequeued.id, 'timeout');

      expect(job!.status).toBe('pending');
      expect(job!.retryCount).toBe(1);
    });

    it('sets run_at to future time (exponential backoff)', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 3 });
      const [dequeued] = repository.dequeue('test');
      const before = Date.now();
      const job = repository.fail(dequeued.id, 'timeout');

      // retryCount was 0 before fail, delay = 2^0 * 1000 = 1000ms
      expect(job!.runAt).toBeGreaterThan(before);
    });

    it('clears startedAt on retry', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 3 });
      const [dequeued] = repository.dequeue('test');
      expect(dequeued.startedAt).not.toBeNull();

      const job = repository.fail(dequeued.id, 'error');

      expect(job!.startedAt).toBeNull();
    });

    it('marks job as dead when retryCount >= maxRetries', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 1 });
      const [first] = repository.dequeue('test');
      // First failure: retryCount 0 < maxRetries 1, resets to pending
      repository.fail(first.id, 'err');
      // Now retryCount is 1 which equals maxRetries 1
      // Need to update run_at so we can dequeue it again
      db.prepare(`UPDATE job_queue SET run_at = ? WHERE id = ?`).run(Date.now() - 1, first.id);
      const [second] = repository.dequeue('test');
      const dead = repository.fail(second.id, 'final error');

      expect(dead!.status).toBe('dead');
    });

    it('sets completedAt when job becomes dead', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 0 });
      const [dequeued] = repository.dequeue('test');
      const before = Date.now();
      const job = repository.fail(dequeued.id, 'fatal');
      const after = Date.now();

      expect(job!.status).toBe('dead');
      expect(job!.completedAt).not.toBeNull();
      expect(job!.completedAt!).toBeGreaterThanOrEqual(before);
      expect(job!.completedAt!).toBeLessThanOrEqual(after);
    });

    it('stores error message', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 3 });
      const [dequeued] = repository.dequeue('test');
      const job = repository.fail(dequeued.id, 'something broke');

      expect(job!.error).toBe('something broke');
    });

    it('returns null for non-existent job', () => {
      const job = repository.fail('non-existent-id', 'error');

      expect(job).toBeNull();
    });

    it('fail() on a pending job still applies retry logic', () => {
      const job = repository.enqueue({ queue: 'test', payload: {}, maxRetries: 3 });
      // Job is pending (not processing)
      expect(job.status).toBe('pending');

      const failed = repository.fail(job.id, 'unexpected failure');

      // fail() applies retry logic regardless of current status
      expect(failed).not.toBeNull();
      expect(failed!.status).toBe('pending');
      expect(failed!.retryCount).toBe(1);
      expect(failed!.error).toBe('unexpected failure');
    });

    it('fail() on a completed job resets it to pending if retries remain', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 3 });
      const [dequeued] = repository.dequeue('test');
      repository.complete(dequeued.id);

      const completed = repository.getJob(dequeued.id);
      expect(completed!.status).toBe('completed');

      const failed = repository.fail(dequeued.id, 'post-complete failure');

      // fail() doesn't check status — it resets to pending
      expect(failed).not.toBeNull();
      expect(failed!.status).toBe('pending');
      expect(failed!.retryCount).toBe(1);
    });

    it('fail() on a dead job with no retries remaining keeps it dead', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 0 });
      const [dequeued] = repository.dequeue('test');
      repository.fail(dequeued.id, 'first failure');

      const dead = repository.getJob(dequeued.id);
      expect(dead!.status).toBe('dead');

      // Calling fail() again on a dead job — retryCount(1) >= maxRetries(0), stays dead
      const failedAgain = repository.fail(dequeued.id, 'second failure');
      expect(failedAgain).not.toBeNull();
      expect(failedAgain!.status).toBe('dead');
      expect(failedAgain!.error).toBe('second failure');
    });
  });

  describe('getJob', () => {
    it('returns job by id', () => {
      const enqueued = repository.enqueue({ queue: 'test', payload: { key: 'val' } });
      const job = repository.getJob(enqueued.id);

      expect(job).not.toBeNull();
      expect(job!.id).toBe(enqueued.id);
      expect(job!.payload).toEqual({ key: 'val' });
    });

    it('returns null for non-existent id', () => {
      const job = repository.getJob('does-not-exist');

      expect(job).toBeNull();
    });
  });

  describe('listJobs', () => {
    it('lists all jobs when no filter', () => {
      repository.enqueue({ queue: 'queue-a', payload: {} });
      repository.enqueue({ queue: 'queue-b', payload: {} });
      repository.enqueue({ queue: 'queue-c', payload: {} });

      const jobs = repository.listJobs({});

      expect(jobs.length).toBe(3);
    });

    it('filters by queue', () => {
      repository.enqueue({ queue: 'alpha', payload: {} });
      repository.enqueue({ queue: 'alpha', payload: {} });
      repository.enqueue({ queue: 'beta', payload: {} });

      const jobs = repository.listJobs({ queue: 'alpha' });

      expect(jobs.length).toBe(2);
      expect(jobs.every((j) => j.queue === 'alpha')).toBe(true);
    });

    it('filters by status', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });
      const toProcess = repository.enqueue({ queue: 'test', payload: {} });
      repository.dequeue('test', 1);
      // manually mark one as completed to have variety
      const [processing] = repository.dequeue('test', 1);
      repository.complete(processing.id);

      const pending = repository.listJobs({ status: 'pending' });
      expect(pending.every((j) => j.status === 'pending')).toBe(true);

      const completed = repository.listJobs({ status: 'completed' });
      expect(completed.length).toBe(1);
      expect(completed[0].status).toBe('completed');
    });

    it('filters by both queue and status', () => {
      repository.enqueue({ queue: 'q1', payload: {} });
      repository.enqueue({ queue: 'q2', payload: {} });
      const [q1job] = repository.dequeue('q1', 1);
      repository.complete(q1job.id);

      const jobs = repository.listJobs({ queue: 'q1', status: 'completed' });

      expect(jobs.length).toBe(1);
      expect(jobs[0].queue).toBe('q1');
      expect(jobs[0].status).toBe('completed');
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        repository.enqueue({ queue: 'test', payload: { i } });
      }

      const jobs = repository.listJobs({ limit: 3 });

      expect(jobs.length).toBe(3);
    });

    it('filters by status array (returns jobs matching any of the statuses)', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });
      const [processing] = repository.dequeue('test', 1);
      repository.complete(processing.id);
      // Now we have: 1 pending, 1 completed

      const jobs = repository.listJobs({ status: ['pending', 'completed'] });

      expect(jobs.length).toBe(2);
      expect(jobs.every((j) => j.status === 'pending' || j.status === 'completed')).toBe(true);
    });

    it('filters by status array — only matching statuses returned', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });
      repository.dequeue('test', 1);
      // Now: 1 pending, 1 processing

      const jobs = repository.listJobs({ status: ['pending'] });

      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('pending');
    });

    it('returns empty array for empty status array', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });

      const jobs = repository.listJobs({ status: [] });

      expect(jobs).toEqual([]);
    });

    it('string status still works (backward compatible)', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });
      repository.dequeue('test', 1);

      const jobs = repository.listJobs({ status: 'pending' });

      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('pending');
    });

    it('orders by created_at DESC', async () => {
      repository.enqueue({ queue: 'test', payload: { order: 1 } });
      await new Promise((r) => setTimeout(r, 5));
      repository.enqueue({ queue: 'test', payload: { order: 2 } });
      await new Promise((r) => setTimeout(r, 5));
      repository.enqueue({ queue: 'test', payload: { order: 3 } });

      const jobs = repository.listJobs({});

      expect(jobs[0].payload.order).toBe(3);
      expect(jobs[1].payload.order).toBe(2);
      expect(jobs[2].payload.order).toBe(1);
    });
  });

  describe('countByStatus', () => {
    it('returns counts for each status', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test', 1);
      repository.complete(job.id);

      const counts = repository.countByStatus('test');

      expect(counts.pending).toBe(1);
      expect(counts.completed).toBe(1);
      expect(counts.processing).toBe(0);
    });

    it('returns 0 for statuses with no jobs', () => {
      repository.enqueue({ queue: 'test', payload: {} });

      const counts = repository.countByStatus('test');

      expect(counts.processing).toBe(0);
      expect(counts.completed).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.dead).toBe(0);
    });

    it('only counts jobs in the specified queue', () => {
      repository.enqueue({ queue: 'q1', payload: {} });
      repository.enqueue({ queue: 'q1', payload: {} });
      repository.enqueue({ queue: 'q2', payload: {} });

      const q1counts = repository.countByStatus('q1');
      const q2counts = repository.countByStatus('q2');

      expect(q1counts.pending).toBe(2);
      expect(q2counts.pending).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('deletes completed jobs older than threshold', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');
      repository.complete(job.id);

      const threshold = Date.now() + 1000;
      const deleted = repository.cleanup(threshold);

      expect(deleted).toBe(1);
      expect(repository.getJob(job.id)).toBeNull();
    });

    it('deletes dead jobs older than threshold', () => {
      repository.enqueue({ queue: 'test', payload: {}, maxRetries: 0 });
      const [job] = repository.dequeue('test');
      repository.fail(job.id, 'fatal');

      const threshold = Date.now() + 1000;
      const deleted = repository.cleanup(threshold);

      expect(deleted).toBe(1);
      expect(repository.getJob(job.id)).toBeNull();
    });

    it('deletes failed jobs older than threshold', () => {
      // Insert a 'failed' job directly — the processor never writes this status
      // (it uses 'dead' for exhausted retries) but the type contract allows it,
      // so cleanup must handle it to prevent indefinite accumulation.
      const now = Date.now();
      const db = (repository as any).db;
      db.exec(`
				INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
				VALUES ('failed-job', 'test', 'failed', '{}', 0, 3, 1, ${now}, ${now}, ${now})
			`);

      const threshold = now + 1000;
      const deleted = repository.cleanup(threshold);

      expect(deleted).toBe(1);
      expect(repository.getJob('failed-job')).toBeNull();
    });

    it('does NOT delete pending or processing jobs', () => {
      const pending = repository.enqueue({ queue: 'test', payload: {} });
      const enqueued2 = repository.enqueue({ queue: 'test', payload: {} });
      const [processing] = repository.dequeue('test', 1);

      const threshold = Date.now() + 1000;
      const deleted = repository.cleanup(threshold);

      expect(deleted).toBe(0);
      expect(repository.getJob(pending.id)).not.toBeNull();
      expect(repository.getJob(processing.id)).not.toBeNull();
    });

    it('returns count of deleted jobs', () => {
      for (let i = 0; i < 3; i++) {
        repository.enqueue({ queue: 'test', payload: {} });
      }
      const jobs = repository.dequeue('test', 3);
      for (const job of jobs) {
        repository.complete(job.id);
      }

      const threshold = Date.now() + 1000;
      const deleted = repository.cleanup(threshold);

      expect(deleted).toBe(3);
    });
  });

  describe('reclaimStale', () => {
    it('reclaims processing jobs started before threshold', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');

      const threshold = Date.now() + 1000;
      const reclaimed = repository.reclaimStale(threshold);

      expect(reclaimed).toBe(1);
      const updated = repository.getJob(job.id);
      expect(updated!.status).toBe('pending');
    });

    it('does NOT reclaim pending or completed jobs', () => {
      const pending = repository.enqueue({ queue: 'test', payload: {} });
      const toComplete = repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test', 1);
      repository.complete(job.id);

      const threshold = Date.now() + 1000;
      const reclaimed = repository.reclaimStale(threshold);

      expect(reclaimed).toBe(0);
    });

    it('sets status back to pending and clears startedAt', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');
      expect(job.startedAt).not.toBeNull();

      const threshold = Date.now() + 1000;
      repository.reclaimStale(threshold);

      const reclaimed = repository.getJob(job.id);
      expect(reclaimed!.status).toBe('pending');
      expect(reclaimed!.startedAt).toBeNull();
    });

    it('returns count of reclaimed jobs', () => {
      for (let i = 0; i < 4; i++) {
        repository.enqueue({ queue: 'test', payload: {} });
      }
      repository.dequeue('test', 4);

      const threshold = Date.now() + 1000;
      const reclaimed = repository.reclaimStale(threshold);

      expect(reclaimed).toBe(4);
    });
  });

  describe('deleteJob', () => {
    it('returns true and removes the job when it exists', () => {
      const job = repository.enqueue({ queue: 'test', payload: {} });
      const deleted = repository.deleteJob(job.id);
      expect(deleted).toBe(true);
      expect(repository.getJob(job.id)).toBeNull();
    });

    it('returns false when the job ID does not exist', () => {
      const deleted = repository.deleteJob('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('deletes exactly one row and leaves others untouched', () => {
      const job1 = repository.enqueue({ queue: 'test', payload: { n: 1 } });
      const job2 = repository.enqueue({ queue: 'test', payload: { n: 2 } });
      const job3 = repository.enqueue({ queue: 'test', payload: { n: 3 } });

      repository.deleteJob(job2.id);

      expect(repository.getJob(job1.id)).not.toBeNull();
      expect(repository.getJob(job2.id)).toBeNull();
      expect(repository.getJob(job3.id)).not.toBeNull();
    });
  });

  describe('deliveryTurnOutcomeSince', () => {
    const SINCE = Date.now() - 60_000;
    /** Seed a settled message_delivery row directly (bypassing claim/complete). */
    const seed = (
      id: string,
      messageUuid: string,
      role: 'turn' | 'steer',
      status: 'completed' | 'dead' | 'pending',
      outcome: string | null,
      times?: { createdAt?: number; startedAt?: number | null; completedAt?: number | null }
    ) => {
      db.prepare(
        `INSERT INTO job_queue (id, queue, status, payload, result, priority, max_retries,
           retry_count, run_at, created_at, started_at, completed_at)
         VALUES (?, 'message_delivery', ?, ?, ?, 0, 3, 0, ?, ?, ?, ?)`
      ).run(
        id,
        status,
        JSON.stringify({ sessionId: 'sess-1', messageUuid, role }),
        outcome ? JSON.stringify({ outcome }) : null,
        SINCE + 1000,
        times?.createdAt ?? SINCE + 1100,
        times?.startedAt === undefined ? null : times.startedAt,
        times?.completedAt ?? (status === 'pending' ? null : SINCE + 2000)
      );
    };

    it('kickoff as TURN: completed-with-success → completed', () => {
      seed('j1', 'kick', 'turn', 'completed', 'completed');
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('completed');
    });

    it('kickoff dead-lettered (either role) → dead', () => {
      seed('j1', 'kick', 'turn', 'dead', null);
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('dead');
      db.prepare('DELETE FROM job_queue').run();
      seed('j1', 'kick', 'steer', 'dead', null);
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('dead');
    });

    it('kickoff as TURN with non-success outcome → null', () => {
      seed('j1', 'kick', 'turn', 'completed', 'skipped');
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBeNull();
    });

    it('kickoff as consumed STEER + owning turn completed → completed', () => {
      seed('j1', 'kick', 'steer', 'completed', 'consumed');
      seed('j2', 'peer', 'turn', 'completed', 'completed');
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('completed');
    });

    it('kickoff as consumed STEER + owning turn dead → dead', () => {
      seed('j1', 'kick', 'steer', 'completed', 'consumed');
      seed('j2', 'peer', 'turn', 'dead', null);
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('dead');
    });

    it('kickoff as consumed STEER with no terminated owning turn → null (still live)', () => {
      seed('j1', 'kick', 'steer', 'completed', 'consumed');
      seed('j2', 'peer', 'turn', 'pending', null);
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBeNull();
    });

    it('ACP shape: owner turn completed BEFORE the steer row completes → matched via creation window', () => {
      // The accepted steer stays parked and completes ('already_consumed') on
      // a LATER claim, after its owning turn already finished. The owner is
      // matched by the turn active at the steer's CREATION.
      const T0 = SINCE + 1000; // owner claimed
      const T1 = SINCE + 1500; // steer created (fed mid-turn)
      const T2 = SINCE + 2000; // owner completed
      const T3 = SINCE + 5000; // steer row finally completes
      seed('j-owner', 'peer', 'turn', 'completed', 'completed', {
        createdAt: T0,
        startedAt: T0,
        completedAt: T2,
      });
      seed('j-kick', 'kick', 'steer', 'completed', 'already_consumed', {
        createdAt: T1,
        startedAt: T1,
        completedAt: T3,
      });
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('completed');
    });

    it('LATE-consumed steer: the consuming turn wins over the creation-time turn (dead consumer)', () => {
      // The steer sat unclaimed past its creation-time turn and was consumed
      // by a LATER turn (feedDeliverySteer runs inside whatever turn is live
      // at claim). The consuming turn's outcome — not the earlier turn's —
      // is the activation's.
      const T0 = SINCE + 1000; // turn1 claimed
      const T1 = SINCE + 1500; // steer created (during turn1)
      const T2 = SINCE + 2000; // turn1 completed successfully
      const T3 = SINCE + 2500; // turn2 claimed
      const T4 = SINCE + 4000; // steer consumed + completed; turn2 dead-letters
      seed('j-turn1', 'peer-1', 'turn', 'completed', 'completed', {
        createdAt: T0,
        startedAt: T0,
        completedAt: T2,
      });
      seed('j-turn2', 'peer-2', 'turn', 'dead', null, {
        createdAt: T3,
        startedAt: T3,
        completedAt: T4,
      });
      seed('j-kick', 'kick', 'steer', 'completed', 'consumed', {
        createdAt: T1,
        startedAt: T3,
        completedAt: T4,
      });
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('dead');
    });

    it('LATE-consumed steer: a successful consuming turn completes despite the creation-time turn failing', () => {
      // Inverse of the above: the creation-time turn dead-lettered, but the
      // turn that actually consumed the steer succeeded.
      const T0 = SINCE + 1000;
      const T1 = SINCE + 1500;
      const T2 = SINCE + 2000; // turn1 dead
      const T3 = SINCE + 2500;
      const T4 = SINCE + 4000; // steer consumed; turn2 completed
      seed('j-turn1', 'peer-1', 'turn', 'dead', null, {
        createdAt: T0,
        startedAt: T0,
        completedAt: T2,
      });
      seed('j-turn2', 'peer-2', 'turn', 'completed', 'completed', {
        createdAt: T3,
        startedAt: T3,
        completedAt: T4,
      });
      seed('j-kick', 'kick', 'steer', 'completed', 'consumed', {
        createdAt: T1,
        startedAt: T3,
        completedAt: T4,
      });
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBe('completed');
    });

    it('unrelated uuid only → null (correlation filters it out)', () => {
      seed('j1', 'other', 'turn', 'completed', 'completed');
      expect(repository.deliveryTurnOutcomeSince('sess-1', 'kick')).toBeNull();
    });
  });

  describe('hasProcessingDeliveryForSession', () => {
    /** Seed a message_delivery row directly with an explicit status/role. */
    const seed = (id: string, status: string, role: string, sessionId = 'sess-1') => {
      db.prepare(
        `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries,
           retry_count, run_at, created_at)
         VALUES (?, 'message_delivery', ?, ?, 0, 3, 0, ?, ?)`
      ).run(
        id,
        status,
        JSON.stringify({ sessionId, messageUuid: id, role }),
        Date.now(),
        Date.now()
      );
    };

    it('true only for a processing TURN (the driven delivery)', () => {
      seed('p1', 'processing', 'turn');
      expect(repository.hasProcessingDeliveryForSession('sess-1')).toBe(true);
    });

    it('false for pending, completed, dead, or steer rows', () => {
      seed('q1', 'pending', 'turn');
      seed('q2', 'completed', 'turn');
      seed('q3', 'dead', 'turn');
      seed('q4', 'processing', 'steer');
      expect(repository.hasProcessingDeliveryForSession('sess-1')).toBe(false);
    });

    it('false for another session processing turn', () => {
      seed('r1', 'processing', 'turn', 'sess-2');
      expect(repository.hasProcessingDeliveryForSession('sess-1')).toBe(false);
    });
  });

  describe('hasDeadTurnExcept', () => {
    const NOW = Date.now();
    /** Seed a settled message_delivery row with explicit role/status/uuid. */
    const seed = (id: string, role: 'turn' | 'steer', status: string, sessionId = 'sess-1') => {
      db.prepare(
        `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries,
           retry_count, run_at, created_at, completed_at)
         VALUES (?, 'message_delivery', ?, ?, 0, 3, 0, ?, ?, ?)`
      ).run(
        id,
        status,
        JSON.stringify({ sessionId, messageUuid: id, role }),
        NOW,
        NOW,
        status === 'pending' ? null : NOW
      );
    };

    it('true when a dead turn exists besides the kickoff uuid', () => {
      seed('peer', 'turn', 'dead');
      expect(repository.hasDeadTurnExcept('sess-1', NOW - 60_000, 'kick')).toBe(true);
    });

    it('false when the only dead turn IS the excepted kickoff uuid', () => {
      seed('kick', 'turn', 'dead');
      expect(repository.hasDeadTurnExcept('sess-1', NOW - 60_000, 'kick')).toBe(false);
    });

    it('false when only dead steers exist (mid-turn handoff failures)', () => {
      seed('steer-1', 'steer', 'dead');
      expect(repository.hasDeadTurnExcept('sess-1', NOW - 60_000, 'kick')).toBe(false);
    });

    it('false when the dead turn settled before sinceMs', () => {
      db.prepare(
        `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries,
           retry_count, run_at, created_at, completed_at)
         VALUES (?, 'message_delivery', 'dead', ?, 0, 3, 0, ?, ?, ?)`
      ).run(
        'old-peer',
        JSON.stringify({ sessionId: 'sess-1', messageUuid: 'old-peer', role: 'turn' }),
        NOW - 120_000,
        NOW - 120_000,
        NOW - 120_000
      );
      expect(repository.hasDeadTurnExcept('sess-1', NOW - 60_000, 'kick')).toBe(false);
    });

    it('scoped to the session', () => {
      seed('peer', 'turn', 'dead', 'sess-2');
      expect(repository.hasDeadTurnExcept('sess-1', NOW - 60_000, 'kick')).toBe(false);
    });

    it('without an except uuid, any dead turn qualifies', () => {
      seed('any', 'turn', 'dead');
      expect(repository.hasDeadTurnExcept('sess-1', NOW - 60_000)).toBe(true);
    });
  });
});
