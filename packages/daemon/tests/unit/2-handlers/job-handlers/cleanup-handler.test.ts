import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createCleanupHandler } from '../../../../src/lib/job-handlers/cleanup.handler';
import {
  JOB_QUEUE_CLEANUP,
  LONG_HORIZON_AGENT_REMINDER_FIRE,
} from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

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

		CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		CREATE INDEX idx_job_queue_status ON job_queue(status);
	`);
  return db;
}

const fakeJob: Job = {
  id: 'fake-job-id',
  queue: JOB_QUEUE_CLEANUP,
  status: 'processing',
  payload: {},
  result: null,
  error: null,
  priority: 0,
  maxRetries: 3,
  retryCount: 0,
  runAt: Date.now(),
  createdAt: Date.now(),
  startedAt: Date.now(),
  completedAt: null,
};

describe('createCleanupHandler', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    db = createTestDb();
    jobQueue = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('deletes completed jobs older than 7 days and returns count', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES ('old-completed', 'some.queue', 'completed', '{}', 0, 3, 0, ${eightDaysAgo}, ${eightDaysAgo}, ${eightDaysAgo})
		`);

    const recentTime = Date.now() - 60_000;
    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES ('recent-completed', 'some.queue', 'completed', '{}', 0, 3, 0, ${recentTime}, ${recentTime}, ${recentTime})
		`);

    const handler = createCleanupHandler(jobQueue);
    const result = await handler(fakeJob);

    expect(result.deletedJobs).toBe(1);

    const remaining = jobQueue.listJobs({ limit: 100 });
    expect(remaining.some((j) => j.id === 'old-completed')).toBe(false);
    expect(remaining.some((j) => j.id === 'recent-completed')).toBe(true);
  });

  it('deletes dead jobs older than 7 days', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES ('old-dead', 'some.queue', 'dead', '{}', 0, 3, 3, ${eightDaysAgo}, ${eightDaysAgo}, ${eightDaysAgo})
		`);

    const handler = createCleanupHandler(jobQueue);
    const result = await handler(fakeJob);

    expect(result.deletedJobs).toBe(1);
    const remaining = jobQueue.listJobs({ limit: 100 });
    expect(remaining.every((j) => j.status === 'pending' && j.queue === JOB_QUEUE_CLEANUP)).toBe(
      true
    );
  });

  it('self-schedules the next cleanup job ~1 hour from now', async () => {
    const handler = createCleanupHandler(jobQueue);
    const before = Date.now();
    const result = await handler(fakeJob);
    const after = Date.now();

    const pending = jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending', limit: 10 });
    expect(pending.length).toBe(1);

    const expectedMin = before + 60 * 60 * 1000;
    const expectedMax = after + 60 * 60 * 1000;
    expect(pending[0].runAt).toBeGreaterThanOrEqual(expectedMin);
    expect(pending[0].runAt).toBeLessThanOrEqual(expectedMax);
    expect(result.nextRunAt).toBeGreaterThanOrEqual(expectedMin);
    expect(result.nextRunAt).toBeLessThanOrEqual(expectedMax);
  });

  it('does not create duplicate pending cleanup jobs (dedup)', async () => {
    jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: Date.now() + 1000 });

    const handler = createCleanupHandler(jobQueue);
    await handler(fakeJob);

    const pending = jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending', limit: 10 });
    expect(pending.length).toBe(1);
  });

  it('deletes failed jobs older than 7 days', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES ('old-failed', 'some.queue', 'failed', '{}', 0, 3, 1, ${eightDaysAgo}, ${eightDaysAgo}, ${eightDaysAgo})
		`);

    const handler = createCleanupHandler(jobQueue);
    const result = await handler(fakeJob);

    expect(result.deletedJobs).toBe(1);
    expect(jobQueue.getJob('old-failed')).toBeNull();
  });

  it('returns 0 deletedJobs when nothing is old enough', async () => {
    const recentTime = Date.now() - 60_000;
    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES ('recent', 'some.queue', 'completed', '{}', 0, 3, 0, ${recentTime}, ${recentTime}, ${recentTime})
		`);

    const handler = createCleanupHandler(jobQueue);
    const result = await handler(fakeJob);

    expect(result.deletedJobs).toBe(0);
  });

  it('deletes completed reminder scan jobs older than the per-queue retention', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES
				('old-reminder-scan', '${LONG_HORIZON_AGENT_REMINDER_FIRE}', 'completed', '{}', 0, 3, 0, ${twoHoursAgo}, ${twoHoursAgo}, ${twoHoursAgo}),
				('recent-reminder-scan', '${LONG_HORIZON_AGENT_REMINDER_FIRE}', 'completed', '{}', 0, 3, 0, ${fiveMinutesAgo}, ${fiveMinutesAgo}, ${fiveMinutesAgo}),
				('old-other-queue', 'some.queue', 'completed', '{}', 0, 3, 0, ${twoHoursAgo}, ${twoHoursAgo}, ${twoHoursAgo})
		`);

    const handler = createCleanupHandler(jobQueue);
    const result = await handler(fakeJob);

    expect(result.deletedJobs).toBe(1);
    expect(jobQueue.getJob('old-reminder-scan')).toBeNull();
    expect(jobQueue.getJob('recent-reminder-scan')).not.toBeNull();
    expect(jobQueue.getJob('old-other-queue')).not.toBeNull();
  });

  it('keeps dead and failed reminder scan jobs until the default retention', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

    db.exec(`
			INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at, completed_at)
			VALUES
				('dead-reminder-scan', '${LONG_HORIZON_AGENT_REMINDER_FIRE}', 'dead', '{}', 0, 3, 3, ${twoHoursAgo}, ${twoHoursAgo}, ${twoHoursAgo}),
				('failed-reminder-scan', '${LONG_HORIZON_AGENT_REMINDER_FIRE}', 'failed', '{}', 0, 3, 1, ${twoHoursAgo}, ${twoHoursAgo}, ${twoHoursAgo})
		`);

    const handler = createCleanupHandler(jobQueue);
    const result = await handler(fakeJob);

    expect(result.deletedJobs).toBe(0);
    expect(jobQueue.getJob('dead-reminder-scan')).not.toBeNull();
    expect(jobQueue.getJob('failed-reminder-scan')).not.toBeNull();
  });
});
