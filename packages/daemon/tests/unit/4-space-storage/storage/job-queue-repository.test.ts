import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

describe('JobQueueRepository', () => {
  describe('rescheduleSessionDeliveries', () => {
    it('pulls only the given session pending jobs due later to now', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: future,
      });
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-b', messageUuid: 'u2' },
        runAt: future,
      });
      repository.enqueue({
        queue: 'other_queue',
        payload: { sessionId: 'sess-a', messageUuid: 'u3' },
        runAt: future,
      });
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now()
      );
      expect(changed).toBe(1);
      const jobs = repository.listJobs({ queue: 'message_delivery', limit: 10 });
      const a = jobs.find((j) => (j.payload as { sessionId: string }).sessionId === 'sess-a');
      const b = jobs.find((j) => (j.payload as { sessionId: string }).sessionId === 'sess-b');
      expect(a?.runAt).toBeLessThanOrEqual(Date.now());
      expect(b?.runAt).toBe(future);
    });

    it('with parkReason it wakes only deliveries parked for that reason', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'resume' },
        runAt: Date.now() - 1000,
      });
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'cooldown' },
        runAt: Date.now() - 1000,
      });
      const [resumeJob, cooldownJob] = repository.dequeue('message_delivery', 2);
      repository.requeueParked(resumeJob.id, future, resumeJob.claimToken, {
        reason: 'sdk_resume_choice',
      });
      repository.requeueParked(cooldownJob.id, future, cooldownJob.claimToken, {
        reason: 'limit_recovery',
      });
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now(),
        { parkReason: 'sdk_resume_choice' }
      );
      expect(changed).toBe(1);
      expect(repository.getJob(resumeJob.id)?.runAt).toBeLessThanOrEqual(Date.now());
      expect(repository.getJob(cooldownJob.id)?.runAt).toBe(future);
    });

    it('plain requeue clears a stale park reason stamp', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      const [job] = repository.dequeue('message_delivery', 1);
      repository.requeueParked(job.id, future, job.claimToken, {
        reason: 'sdk_resume_choice',
      });
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(job.id);
      const [reclaimed] = repository.dequeue('message_delivery', 1);
      repository.requeue(reclaimed.id, Date.now() + 600_000, reclaimed.claimToken);
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now(),
        { parkReason: 'sdk_resume_choice' }
      );
      expect(changed).toBe(0);
    });

    it('resume-choice parks track a dedicated counter isolated from generic parks', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      let [job] = repository.dequeue('message_delivery', 1);
      for (let i = 0; i < 3; i++) {
        repository.requeueParked(job.id, future, job.claimToken, {
          reason: 'turn_blocked',
          counter: 'park',
        });
        db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(job.id);
        [job] = repository.dequeue('message_delivery', 1);
      }
      expect(repository.getParkCount(job.id)).toBe(3);
      expect(repository.getParkCount(job.id, 'resumeChoice')).toBe(0);
      repository.requeueParked(job.id, future, job.claimToken, {
        reason: 'sdk_resume_choice',
        counter: 'resumeChoice',
      });
      expect(repository.getParkCount(job.id)).toBe(3);
      expect(repository.getParkCount(job.id, 'resumeChoice')).toBe(1);
    });

    it('fail() on the retry path clears the park reason stamp', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      const [job] = repository.dequeue('message_delivery', 1);
      repository.requeueParked(job.id, future, job.claimToken, {
        reason: 'sdk_resume_choice',
        counter: 'resumeChoice',
      });
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(job.id);
      const [reclaimed] = repository.dequeue('message_delivery', 1);
      repository.fail(reclaimed.id, 'transient boom', reclaimed.claimToken);
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now(),
        { parkReason: 'sdk_resume_choice' }
      );
      expect(changed).toBe(0);
    });

    it('a reason-filtered wake resets already-due parked jobs without delaying them', () => {
      const past = Date.now() - 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      const [job] = repository.dequeue('message_delivery', 1);
      repository.requeueParked(job.id, past, job.claimToken, {
        reason: 'sdk_resume_choice',
      });
      expect(repository.getParkCount(job.id)).toBe(1);
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now(),
        { parkReason: 'sdk_resume_choice' }
      );
      expect(changed).toBe(1);
      expect(repository.getParkCount(job.id)).toBe(0);
      expect(repository.getJob(job.id)?.runAt).toBe(past);
    });

    it('a reason-filtered wake also resets the park count for a fresh budget', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      const [job] = repository.dequeue('message_delivery', 1);
      repository.requeueParked(job.id, future, job.claimToken, {
        reason: 'sdk_resume_choice',
      });
      expect(repository.getParkCount(job.id)).toBe(1);
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now(),
        { parkReason: 'sdk_resume_choice' }
      );
      expect(changed).toBe(1);
      expect(repository.getParkCount(job.id)).toBe(0);
    });

    it('requeueParked without a reason clears any prior park reason stamp', () => {
      const future = Date.now() + 600_000;
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      const [job] = repository.dequeue('message_delivery', 1);
      repository.requeueParked(job.id, future, job.claimToken, {
        reason: 'sdk_resume_choice',
      });
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(job.id);
      const [reclaimed] = repository.dequeue('message_delivery', 1);
      repository.requeueParked(reclaimed.id, future, reclaimed.claimToken);
      const changed = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now(),
        { parkReason: 'sdk_resume_choice' }
      );
      expect(changed).toBe(0);
    });

    it('never touches already-completed or processing rows', () => {
      repository.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'sess-a', messageUuid: 'u1' },
        runAt: Date.now() - 1000,
      });
      const [job] = repository.dequeue('message_delivery', 1);
      const changedNow = repository.rescheduleSessionDeliveries(
        'message_delivery',
        'sess-a',
        Date.now()
      );
      expect(changedNow).toBe(0);
      expect(repository.getJob(job.id)?.status).toBe('processing');
    });
  });

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
				heartbeat_at INTEGER,
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
      repository.fail(first.id, 'err');
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
      expect(job.status).toBe('pending');

      const failed = repository.fail(job.id, 'unexpected failure');

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

      const jobs = repository.listJobs({ status: ['pending', 'completed'] });

      expect(jobs.length).toBe(2);
      expect(jobs.every((j) => j.status === 'pending' || j.status === 'completed')).toBe(true);
    });

    it('filters by status array — only matching statuses returned', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      repository.enqueue({ queue: 'test', payload: {} });
      repository.dequeue('test', 1);

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

  describe('cleanupCompleted', () => {
    it('deletes completed jobs for the queue older than threshold', () => {
      repository.enqueue({ queue: 'scan', payload: {} });
      const [job] = repository.dequeue('scan');
      repository.complete(job.id);

      const deleted = repository.cleanupCompleted('scan', Date.now() + 1000);

      expect(deleted).toBe(1);
      expect(repository.getJob(job.id)).toBeNull();
    });

    it('keeps completed jobs for other queues', () => {
      repository.enqueue({ queue: 'scan', payload: {} });
      repository.enqueue({ queue: 'other', payload: {} });
      const [scanJob] = repository.dequeue('scan');
      const [otherJob] = repository.dequeue('other');
      repository.complete(scanJob.id);
      repository.complete(otherJob.id);

      const deleted = repository.cleanupCompleted('scan', Date.now() + 1000);

      expect(deleted).toBe(1);
      expect(repository.getJob(scanJob.id)).toBeNull();
      expect(repository.getJob(otherJob.id)).not.toBeNull();
    });

    it('keeps dead jobs in the same queue', () => {
      repository.enqueue({ queue: 'scan', payload: {}, maxRetries: 0 });
      const [job] = repository.dequeue('scan');
      repository.fail(job.id, 'fatal');

      const deleted = repository.cleanupCompleted('scan', Date.now() + 1000);

      expect(deleted).toBe(0);
      expect(repository.getJob(job.id)).not.toBeNull();
      expect(repository.getJob(job.id)?.status).toBe('dead');
    });

    it('keeps completed jobs in the same queue younger than threshold', () => {
      const now = Date.now();
      const db = (repository as any).db;
      db.exec(`
				INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
				VALUES ('recent-completed', 'scan', 'completed', '{}', 0, 3, 0, ${now}, ${now}, ${now})
			`);

      const deleted = repository.cleanupCompleted('scan', now - 1000);

      expect(deleted).toBe(0);
      expect(repository.getJob('recent-completed')).not.toBeNull();
    });
  });

  describe('reclaimStale', () => {
    it('reclaims processing jobs started before threshold', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');

      const threshold = Date.now() + 1000;
      const reclaimed = repository.reclaimStale(threshold);

      expect(reclaimed).toHaveLength(1);
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

      expect(reclaimed).toHaveLength(0);
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

      expect(reclaimed).toHaveLength(4);
    });

    it('scopes reclamation to the requested queues only', () => {
      repository.enqueue({ queue: 'owned-q', payload: {} });
      repository.enqueue({ queue: 'other-q', payload: {} });
      repository.dequeue('owned-q', 1);
      repository.dequeue('other-q', 1);

      const threshold = Date.now() + 1000;
      const reclaimed = repository.reclaimStale(threshold, ['owned-q']);

      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].queue).toBe('owned-q');
      expect(repository.getJob(reclaimed[0].jobId)?.status).toBe('pending');
      const other = repository.listJobs({ queue: 'other-q', status: 'processing' })[0];
      expect(other).toBeDefined();
    });
  });

  describe('reschedulePending', () => {
    it("moves a pending job's run_at (the stale-reclaim jitter seam)", () => {
      const job = repository.enqueue({ queue: 'test', payload: {} });
      const later = Date.now() + 5_000;

      expect(repository.reschedulePending(job.id, later)).toBe(true);
      expect(repository.getJob(job.id)?.runAt).toBe(later);
    });

    it('leaves a processing job untouched and reports false', () => {
      repository.enqueue({ queue: 'test', payload: {} });
      const [job] = repository.dequeue('test');
      const originalRunAt = repository.getJob(job.id)!.runAt;

      expect(repository.reschedulePending(job.id, Date.now() + 60_000)).toBe(false);
      const after = repository.getJob(job.id)!;
      expect(after.status).toBe('processing');
      expect(after.runAt).toBe(originalRunAt);
    });

    it('returns false for an unknown job id', () => {
      expect(repository.reschedulePending('non-existent-id', Date.now())).toBe(false);
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

  describe('hasActiveTurnDeliveryJob', () => {
    function enqueueDeliveryJob(args: { sessionId: string; role: string; status?: string }): void {
      const job = repository.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId: args.sessionId,
          messageUuid: `msg-${args.role}-${args.sessionId}`,
          role: args.role,
          origin: 'chat',
          parentToolUseId: null,
        },
      });
      if (args.status && args.status !== 'pending') {
        db.prepare('UPDATE job_queue SET status = ? WHERE id = ?').run(args.status, job.id);
      }
    }

    it('returns true when a pending turn-role delivery job exists for the session', () => {
      enqueueDeliveryJob({ sessionId: 'sess-1', role: 'turn' });

      expect(repository.hasActiveTurnDeliveryJob('sess-1')).toBe(true);
    });

    it('returns true when the turn-role delivery job is processing', () => {
      enqueueDeliveryJob({ sessionId: 'sess-1', role: 'turn', status: 'processing' });

      expect(repository.hasActiveTurnDeliveryJob('sess-1')).toBe(true);
    });

    it('returns false when only steer-role delivery jobs are active', () => {
      enqueueDeliveryJob({ sessionId: 'sess-1', role: 'steer' });

      expect(repository.hasActiveTurnDeliveryJob('sess-1')).toBe(false);
    });

    it('returns false when the turn-role delivery job has completed', () => {
      enqueueDeliveryJob({ sessionId: 'sess-1', role: 'turn', status: 'completed' });

      expect(repository.hasActiveTurnDeliveryJob('sess-1')).toBe(false);
    });

    it('ignores turn-role delivery jobs of other sessions', () => {
      enqueueDeliveryJob({ sessionId: 'sess-other', role: 'turn' });

      expect(repository.hasActiveTurnDeliveryJob('sess-1')).toBe(false);
    });

    it('returns false for a session with no delivery jobs', () => {
      expect(repository.hasActiveTurnDeliveryJob('sess-1')).toBe(false);
    });
  });
});
