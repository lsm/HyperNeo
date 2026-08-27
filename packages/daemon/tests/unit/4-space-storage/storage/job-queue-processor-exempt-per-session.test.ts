import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

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

describe('JobQueueProcessor — exempt per-session cap', () => {
  let db: Database;
  let repo: JobQueueRepository;
  let processor: JobQueueProcessor;
  const resolvers: Array<() => void> = [];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
    processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000, maxConcurrent: 5 });
    resolvers.length = 0;
  });

  afterEach(async () => {
    for (const resolve of resolvers) resolve();
    await processor.stop();
    db.close();
  });

  function blockOnSession(
    handler: (sessionId: string, jobId: string) => void = () => {}
  ): (job: Job) => Promise<void> {
    return (job: Job) =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
        const sessionId = typeof job.payload.sessionId === 'string' ? job.payload.sessionId : '';
        handler(sessionId, job.id);
      });
  }

  it('exempt jobs are tracked in the exempt slot class, not the capped slot class', async () => {
    processor.register('steer-q', blockOnSession(), {
      exemptJobs: { path: '$.role', equals: 'steer' },
    });
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-a', role: 'steer' } });
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-b', role: 'turn' } });

    await processor.tick();
    await flush();

    const snapshot = processor.snapshot('steer-q');
    expect(snapshot.inFlightCapped).toBe(1);
    expect(snapshot.inFlightExempt).toBe(1);
    expect(snapshot.inFlightTotal).toBe(2);
  });

  it('claims at most one in-flight steer per session', async () => {
    processor.register('steer-q', blockOnSession(), {
      exemptJobs: { path: '$.role', equals: 'steer' },
    });
    for (let i = 0; i < 4; i++) {
      repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-a', role: 'steer' } });
    }
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-b', role: 'steer' } });
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-b', role: 'steer' } });

    const claimed = await processor.tick();
    await flush();

    expect(claimed).toBe(2);
    const snapshot = processor.snapshot('steer-q');
    expect(snapshot.inFlightExempt).toBe(2);
    expect(snapshot.inFlightTotal).toBe(2);
    const sessions = snapshot.handlers.map((h) => h.sessionId);
    expect(sessions).toContain('sess-a');
    expect(sessions).toContain('sess-b');
    expect(new Set(sessions).size).toBe(sessions.length);

    const processing = repo.listJobs({ queue: 'steer-q', status: 'processing', limit: 10 });
    expect(processing).toHaveLength(2);
    const pending = repo.listJobs({ queue: 'steer-q', status: 'pending', limit: 10 });
    expect(pending).toHaveLength(4);
  });

  it('fills available slots with distinct sessions before reusing a session', async () => {
    processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000, maxConcurrent: 3 });
    processor.register('steer-q', blockOnSession(), {
      exemptJobs: { path: '$.role', equals: 'steer' },
    });
    for (let i = 0; i < 5; i++) {
      repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-a', role: 'steer' } });
    }
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-b', role: 'steer' } });
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-c', role: 'steer' } });

    const claimed = await processor.tick();
    await flush();

    expect(claimed).toBe(3);
    const snapshot = processor.snapshot('steer-q');
    expect(snapshot.inFlightExempt).toBe(3);
    const sessions = new Set(snapshot.handlers.map((h) => h.sessionId));
    expect(sessions).toEqual(new Set(['sess-a', 'sess-b', 'sess-c']));
  });

  it('claims the next queued steer for a session only after the in-flight one completes', async () => {
    const claimedIds: string[] = [];
    processor.register(
      'steer-q',
      (job: Job) =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
          claimedIds.push(job.id);
        }),
      { exemptJobs: { path: '$.role', equals: 'steer' } }
    );
    const first = repo.enqueue({
      queue: 'steer-q',
      payload: { sessionId: 'sess-a', role: 'steer' },
    });
    const second = repo.enqueue({
      queue: 'steer-q',
      payload: { sessionId: 'sess-a', role: 'steer' },
    });

    await processor.tick();
    await flush();

    expect(claimedIds).toEqual([first.id]);
    expect(repo.getJob(first.id)?.status).toBe('processing');
    expect(repo.getJob(second.id)?.status).toBe('pending');

    resolvers[0]();
    await flush();
    await processor.tick();
    await flush();

    expect(claimedIds).toEqual([first.id, second.id]);
    expect(repo.getJob(first.id)?.status).toBe('completed');
    expect(repo.getJob(second.id)?.status).toBe('processing');
  });

  it('dequeueExempt spreads claims across sessions when excludeSessionIds is supplied', () => {
    for (let i = 0; i < 3; i++) {
      repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-a', role: 'steer' } });
    }
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-b', role: 'steer' } });
    repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-c', role: 'steer' } });

    const first = repo.dequeueExempt('steer-q', { path: '$.role', equals: 'steer' }, 1, undefined, [
      'sess-a',
    ]);
    expect(first).toHaveLength(1);
    expect(first[0].payload.sessionId).toBe('sess-b');

    const second = repo.dequeueExempt(
      'steer-q',
      { path: '$.role', equals: 'steer' },
      1,
      [first[0].id],
      ['sess-a', 'sess-b']
    );
    expect(second).toHaveLength(1);
    expect(second[0].payload.sessionId).toBe('sess-c');

    const third = repo.dequeueExempt(
      'steer-q',
      { path: '$.role', equals: 'steer' },
      1,
      [first[0].id, second[0].id],
      ['sess-a', 'sess-b', 'sess-c']
    );
    expect(third).toHaveLength(0);
  });

  it('dequeueExempt still claims all matching jobs when excludeSessionIds is omitted', () => {
    for (let i = 0; i < 3; i++) {
      repo.enqueue({ queue: 'steer-q', payload: { sessionId: 'sess-a', role: 'steer' } });
    }

    const jobs = repo.dequeueExempt('steer-q', { path: '$.role', equals: 'steer' }, 2);

    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.payload.sessionId === 'sess-a')).toBe(true);
    expect(jobs.every((j) => j.status === 'processing')).toBe(true);
  });
});
