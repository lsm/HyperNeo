import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

function enqueueDelivery(
  repo: JobQueueRepository,
  sessionId: string,
  payload: Record<string, unknown> = {}
): Job {
  return repo.enqueue({ queue: 'message_delivery', payload: { sessionId, ...payload } });
}

describe('JobQueueRepository — dequeueSessionFifo (dark launch)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('claims at most one job per session even when the limit allows more', () => {
    const first = enqueueDelivery(repo, 'sess-a');
    const second = enqueueDelivery(repo, 'sess-a');
    enqueueDelivery(repo, 'sess-a');

    const claimed = repo.dequeueSessionFifo('message_delivery', 5);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(first.id);
    expect(claimed[0].status).toBe('processing');
    expect(claimed[0].claimToken).toBeTruthy();
    expect(repo.getJob(second.id)?.status).toBe('pending');
  });

  it('claims the earliest job of each distinct session in one dequeue', () => {
    const a1 = enqueueDelivery(repo, 'sess-a');
    const b1 = enqueueDelivery(repo, 'sess-b');
    const a2 = enqueueDelivery(repo, 'sess-a');

    const claimed = repo.dequeueSessionFifo('message_delivery', 5);

    expect(claimed.map((job) => job.id)).toEqual([a1.id, b1.id]);
    expect(claimed.every((job) => job.status === 'processing')).toBe(true);
    expect(repo.getJob(a2.id)?.status).toBe('pending');
  });

  it('breaks a created_at tie by rowid (insertion order)', () => {
    const first = enqueueDelivery(repo, 'sess-a');
    const second = enqueueDelivery(repo, 'sess-a');
    db.prepare(`UPDATE job_queue SET created_at = 424242 WHERE id IN (?, ?)`).run(
      first.id,
      second.id
    );

    const claimed = repo.dequeueSessionFifo('message_delivery', 1);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(first.id);
    expect(repo.getJob(second.id)?.status).toBe('pending');
  });

  it('an earlier pending job with a future run_at blocks a later same-session job', () => {
    const first = repo.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: 'sess-a' },
      runAt: Date.now() + 60_000,
    });
    const second = enqueueDelivery(repo, 'sess-a');

    expect(repo.dequeueSessionFifo('message_delivery', 5)).toHaveLength(0);

    repo.reschedulePending(first.id, Date.now() - 1000);

    const claimed = repo.dequeueSessionFifo('message_delivery', 5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(first.id);
    expect(repo.getJob(second.id)?.status).toBe('pending');
  });

  it('an earlier unreleased job blocks a later released job when releasedPath is set', () => {
    const held = enqueueDelivery(repo, 'sess-a', { released: false });
    const released = enqueueDelivery(repo, 'sess-a', { released: true });

    expect(
      repo.dequeueSessionFifo('message_delivery', 5, { releasedPath: '$.released' })
    ).toHaveLength(0);

    db.prepare(
      `UPDATE job_queue SET payload = json_set(payload, '$.released', json('true')) WHERE id = ?`
    ).run(held.id);

    const claimed = repo.dequeueSessionFifo('message_delivery', 5, {
      releasedPath: '$.released',
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(held.id);
    expect(repo.getJob(released.id)?.status).toBe('pending');
  });

  it('treats a legacy payload without the released flag as released', () => {
    const legacy = enqueueDelivery(repo, 'sess-a');
    const next = enqueueDelivery(repo, 'sess-a', { released: true });

    const claimed = repo.dequeueSessionFifo('message_delivery', 5, {
      releasedPath: '$.released',
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(legacy.id);
    expect(repo.getJob(next.id)?.status).toBe('pending');
  });

  it('a dead, completed, or failed predecessor does not block its session', () => {
    for (const status of ['dead', 'completed', 'failed'] as const) {
      const predecessor = enqueueDelivery(repo, `sess-${status}`);
      db.prepare(`UPDATE job_queue SET status = ? WHERE id = ?`).run(status, predecessor.id);
      const successor = enqueueDelivery(repo, `sess-${status}`);

      const claimed = repo.dequeueSessionFifo('message_delivery', 5);

      expect(claimed.map((job) => job.id)).toEqual([successor.id]);
    }
  });

  it('a stale processing predecessor blocks its session until reclaimStale returns it to pending', () => {
    const first = enqueueDelivery(repo, 'sess-a');
    const second = enqueueDelivery(repo, 'sess-a');
    const [claimedFirst] = repo.dequeue('message_delivery', 1);
    expect(claimedFirst.id).toBe(first.id);

    expect(repo.dequeueSessionFifo('message_delivery', 5)).toHaveLength(0);

    db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
      Date.now() - 10_000,
      Date.now() - 10_000,
      first.id
    );
    expect(repo.reclaimStale(Date.now() - 1000)).toHaveLength(1);

    const reclaimed = repo.dequeueSessionFifo('message_delivery', 5);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(first.id);

    repo.complete(first.id, undefined, reclaimed[0].claimToken);

    const next = repo.dequeueSessionFifo('message_delivery', 5);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(second.id);
  });

  it('skips excluded ids while an excluded pending predecessor still blocks its session', () => {
    const first = enqueueDelivery(repo, 'sess-a');
    const second = enqueueDelivery(repo, 'sess-a');

    const claimed = repo.dequeueSessionFifo('message_delivery', 5, { excludeIds: [first.id] });

    expect(claimed).toHaveLength(0);
    expect(repo.getJob(first.id)?.status).toBe('pending');
    expect(repo.getJob(second.id)?.status).toBe('pending');
  });

  it('excludes payload-matched jobs from selection while an excluded predecessor still blocks its session', () => {
    const steer = enqueueDelivery(repo, 'sess-a', { role: 'steer' });
    const otherTurn = enqueueDelivery(repo, 'sess-b', { role: 'turn' });
    const exclude = { path: '$.role', equals: 'steer' };

    const claimed = repo.dequeueSessionFifo('message_delivery', 5, { exclude });

    expect(claimed.map((job) => job.id)).toEqual([otherTurn.id]);
    expect(repo.getJob(steer.id)?.status).toBe('pending');

    const sameSessionTurn = enqueueDelivery(repo, 'sess-a', { role: 'turn' });
    const blocked = repo.dequeueSessionFifo('message_delivery', 5, { exclude });

    expect(blocked).toHaveLength(0);
    expect(repo.getJob(sameSessionTurn.id)?.status).toBe('pending');
  });

  it('groups FIFO lanes by the configured sessionIdPath', () => {
    const c1First = repo.enqueue({ queue: 'chat_out', payload: { chat: 'c1', n: 1 } });
    const c1Second = repo.enqueue({ queue: 'chat_out', payload: { chat: 'c1', n: 2 } });
    const c2 = repo.enqueue({ queue: 'chat_out', payload: { chat: 'c2', n: 3 } });

    const claimed = repo.dequeueSessionFifo('chat_out', 5, { sessionIdPath: '$.chat' });

    expect(claimed.map((job) => job.id)).toEqual([c1First.id, c2.id]);
    expect(repo.getJob(c1Second.id)?.status).toBe('pending');
  });

  it('never merges a sessionless job with a real session or another sessionless job', () => {
    const sessionless1 = repo.enqueue({ queue: 'message_delivery', payload: {} });
    const sessionless2 = repo.enqueue({ queue: 'message_delivery', payload: {} });
    const realFirst = repo.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: 'rowid:1' },
    });
    const realSecond = repo.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: 'rowid:1' },
    });

    const claimed = repo.dequeueSessionFifo('message_delivery', 5);

    expect(claimed.map((job) => job.id)).toEqual([sessionless1.id, sessionless2.id, realFirst.id]);
    expect(repo.getJob(realSecond.id)?.status).toBe('pending');
  });
});

describe('JobQueueProcessor — session-fifo dequeue mode (dark launch)', () => {
  let db: Database;
  let repo: JobQueueRepository;
  let processor: JobQueueProcessor;
  const resolvers: Array<() => void> = [];
  const processors: JobQueueProcessor[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(DB_SCHEMA);
    repo = new JobQueueRepository(db as any);
    processor = new JobQueueProcessor(repo, { pollIntervalMs: 60_000, maxConcurrent: 5 });
    resolvers.length = 0;
    processors.length = 0;
    processors.push(processor);
  });

  afterEach(async () => {
    for (const resolve of resolvers) resolve();
    for (const tracked of processors) await tracked.stop();
    db.close();
  });

  function registerBlockingFifo(
    target: JobQueueProcessor,
    options: {
      sessionIdPath?: string;
      releasedPath?: string;
      onClaim?: (job: Job) => void;
    } = {}
  ): void {
    target.register(
      'message_delivery',
      (job: Job) =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
          options.onClaim?.(job);
        }),
      {
        dequeueMode: {
          kind: 'session-fifo',
          sessionIdPath: options.sessionIdPath,
          releasedPath: options.releasedPath,
        },
      }
    );
  }

  it('claims one job per session per tick and one per distinct session concurrently', async () => {
    const claimedIds: string[] = [];
    registerBlockingFifo(processor, { onClaim: (job) => claimedIds.push(job.id) });
    const a1 = enqueueDelivery(repo, 'sess-a');
    const b1 = enqueueDelivery(repo, 'sess-b');
    enqueueDelivery(repo, 'sess-a');
    enqueueDelivery(repo, 'sess-b');

    const claimed = await processor.tick();
    await flush();

    expect(claimed).toBe(2);
    expect(claimedIds).toHaveLength(2);
    expect(claimedIds).toContain(a1.id);
    expect(claimedIds).toContain(b1.id);
    const snapshot = processor.snapshot('message_delivery');
    expect(snapshot.inFlightCapped).toBe(2);
    expect(new Set(snapshot.handlers.map((handler) => handler.sessionId))).toEqual(
      new Set(['sess-a', 'sess-b'])
    );
    const pending = repo.listJobs({ queue: 'message_delivery', status: 'pending', limit: 10 });
    expect(pending).toHaveLength(2);
  });

  it('advances a session only after its in-flight predecessor settles', async () => {
    const claimedIds: string[] = [];
    registerBlockingFifo(processor, { onClaim: (job) => claimedIds.push(job.id) });
    const first = enqueueDelivery(repo, 'sess-a');
    const second = enqueueDelivery(repo, 'sess-a');

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

  it('honors releasedPath from the registration while an unreleased predecessor holds the lane', async () => {
    const claimedIds: string[] = [];
    registerBlockingFifo(processor, {
      releasedPath: '$.released',
      onClaim: (job) => claimedIds.push(job.id),
    });
    const held = enqueueDelivery(repo, 'sess-a', { released: false });
    enqueueDelivery(repo, 'sess-a', { released: true });

    await processor.tick();
    await flush();

    expect(claimedIds).toHaveLength(0);

    db.prepare(
      `UPDATE job_queue SET payload = json_set(payload, '$.released', json('true')) WHERE id = ?`
    ).run(held.id);

    const claimed = await processor.tick();
    await flush();

    expect(claimed).toBe(1);
    expect(claimedIds).toEqual([held.id]);
  });

  it('preserves exempt-job isolation when session-fifo mode and exemptJobs combine', async () => {
    processor.register(
      'message_delivery',
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      {
        exemptJobs: { path: '$.role', equals: 'steer' },
        dequeueMode: { kind: 'session-fifo' },
      }
    );
    const steerA1 = enqueueDelivery(repo, 'sess-a', { role: 'steer' });
    enqueueDelivery(repo, 'sess-a', { role: 'turn' });
    const steerA2 = enqueueDelivery(repo, 'sess-a', { role: 'steer' });

    const firstClaimed = await processor.tick();
    await flush();

    expect(firstClaimed).toBe(1);
    let snapshot = processor.snapshot('message_delivery');
    expect(snapshot.inFlightCapped).toBe(0);
    expect(snapshot.inFlightExempt).toBe(1);
    expect(snapshot.handlers[0].role).toBe('steer');
    expect(snapshot.handlers[0].slotClass).toBe('exempt');
    expect(repo.getJob(steerA1.id)?.status).toBe('processing');
    expect(repo.getJob(steerA2.id)?.status).toBe('pending');

    resolvers[0]();
    await flush();
    const secondClaimed = await processor.tick();
    await flush();

    expect(secondClaimed).toBe(2);
    snapshot = processor.snapshot('message_delivery');
    expect(snapshot.inFlightCapped).toBe(1);
    expect(snapshot.inFlightExempt).toBe(1);
    const slotsByRole = new Map(
      snapshot.handlers.map((handler) => [handler.role, handler.slotClass])
    );
    expect(slotsByRole.get('turn')).toBe('capped');
    expect(slotsByRole.get('steer')).toBe('exempt');
    for (const handler of snapshot.handlers) {
      if (handler.role === 'steer') expect(handler.slotClass).not.toBe('capped');
    }
  });

  it('two concurrent ticks cannot double-claim the same session job', async () => {
    const claimedIds: string[] = [];
    const other = new JobQueueProcessor(repo, { pollIntervalMs: 60_000, maxConcurrent: 2 });
    processors.push(other);
    registerBlockingFifo(processor, { onClaim: (job) => claimedIds.push(job.id) });
    registerBlockingFifo(other, { onClaim: (job) => claimedIds.push(job.id) });

    const first = enqueueDelivery(repo, 'sess-a');
    const second = enqueueDelivery(repo, 'sess-a');

    const [claimedMain, claimedOther] = await Promise.all([processor.tick(), other.tick()]);
    await flush();

    expect(claimedMain + claimedOther).toBe(1);
    expect(claimedIds).toEqual([first.id]);
    expect(repo.getJob(first.id)?.status).toBe('processing');
    expect(repo.getJob(second.id)?.status).toBe('pending');
  });
});
