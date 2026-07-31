import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createMemoryDistillationHandler,
  enqueueMemoryDistillationIfMissing,
} from '../../../../src/lib/job-handlers/memory-distillation.handler';
import { MEMORY_DISTILLATION } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

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
			completed_at INTEGER
		);
	`);
  return db;
}

function fakeJob(payload: Record<string, unknown> = {}): Job {
  const now = Date.now();
  return {
    id: 'memory-distillation-test',
    queue: MEMORY_DISTILLATION,
    status: 'processing',
    payload,
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: now,
    createdAt: now,
    startedAt: now,
    completedAt: null,
  };
}

function fakeService(
  overrides: Partial<{
    listActiveAgentIds: () => string[];
    distillAgentById: (id: string) => unknown;
  }> = {}
) {
  return {
    listActiveAgentIds: overrides.listActiveAgentIds ?? (() => ['agent-a', 'agent-b']),
    distillAgentById:
      overrides.distillAgentById ??
      (() => ({
        agentId: 'agent-a',
        spaceId: 'space-1',
        distilled: true,
        messagesRead: 5,
        memoriesWritten: 2,
        cursorRowid: 9,
      })),
  };
}

describe('createMemoryDistillationHandler', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    db = createTestDb();
    jobQueue = new JobQueueRepository(db as never);
  });

  afterEach(() => {
    db.close();
  });

  it('coordinator fans out one per-agent job and self-schedules', async () => {
    const handler = createMemoryDistillationHandler(fakeService() as never, jobQueue);
    const before = Date.now();

    const result = (await handler(fakeJob())) as Record<string, unknown>;
    const after = Date.now();

    expect(result.coordinator).toBe(true);
    expect(result.agentsDispatched).toBe(2);

    const pending = jobQueue.listJobs({
      queue: MEMORY_DISTILLATION,
      status: 'pending',
      limit: 50,
    });
    // Two per-agent jobs + one self-scheduled coordinator tick.
    expect(pending).toHaveLength(3);
    const payloads = pending.map((job) => job.payload);
    expect(payloads.filter((payload) => typeof payload.agentId === 'string')).toHaveLength(2);
    // The coordinator self-schedules ~30 min out; per-agent jobs run now.
    const coordinatorNext = pending.find((job) => !job.payload?.agentId);
    expect(coordinatorNext?.runAt).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
    expect(coordinatorNext?.runAt).toBeLessThanOrEqual(after + 30 * 60 * 1000);
    expect(result.nextRunAt).toBe(coordinatorNext?.runAt);
  });

  it('does not re-dispatch a per-agent job that is already pending/processing', async () => {
    // Simulate a slow prior tick: a per-agent job for agent-a is already pending.
    jobQueue.enqueue({
      queue: MEMORY_DISTILLATION,
      payload: { agentId: 'agent-a' },
      runAt: Date.now(),
    });
    const handler = createMemoryDistillationHandler(fakeService() as never, jobQueue);

    const result = (await handler(fakeJob())) as Record<string, unknown>;
    // agent-a was already queued → only agent-b is newly dispatched.
    expect(result.agentsDispatched).toBe(1);

    const pending = jobQueue.listJobs({
      queue: MEMORY_DISTILLATION,
      status: 'pending',
      limit: 50,
    });
    const agentAJobs = pending.filter((job) => job.payload?.agentId === 'agent-a');
    expect(agentAJobs).toHaveLength(1); // no duplicate
  });

  it('per-agent job distills a single agent', async () => {
    const handler = createMemoryDistillationHandler(fakeService() as never, jobQueue);
    const result = (await handler(fakeJob({ agentId: 'agent-x' }))) as Record<string, unknown>;
    expect(result.agentId).toBe('agent-x');
    expect(result.distilled).toBe(true);
    expect(result.memoriesWritten).toBe(2);
    // Per-agent jobs do NOT self-schedule (the coordinator owns the cadence).
    expect(result.nextRunAt).toBeUndefined();
    const pending = jobQueue.listJobs({
      queue: MEMORY_DISTILLATION,
      status: 'pending',
      limit: 50,
    });
    expect(pending).toHaveLength(0);
  });

  it('trims the agentId payload', async () => {
    const seen: string[] = [];
    const service = fakeService({
      distillAgentById: (id) => {
        seen.push(id);
        return { agentId: id, distilled: true, memoriesWritten: 1 };
      },
    });
    const handler = createMemoryDistillationHandler(service as never, jobQueue);
    await handler(fakeJob({ agentId: ' agent-x ' }));
    expect(seen).toEqual(['agent-x']);
  });
});

describe('enqueueMemoryDistillationIfMissing', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    db = createTestDb();
    jobQueue = new JobQueueRepository(db as never);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueues a coordinator tick (no agentId) when none is pending', () => {
    enqueueMemoryDistillationIfMissing(jobQueue, Date.now() + 1_000);
    const pending = jobQueue.listJobs({
      queue: MEMORY_DISTILLATION,
      status: 'pending',
      limit: 50,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].payload?.agentId).toBeUndefined();
  });

  it('does not enqueue a duplicate coordinator', () => {
    enqueueMemoryDistillationIfMissing(jobQueue, Date.now() + 1_000);
    enqueueMemoryDistillationIfMissing(jobQueue, Date.now() + 2_000);
    const pending = jobQueue.listJobs({
      queue: MEMORY_DISTILLATION,
      status: 'pending',
      limit: 50,
    });
    expect(pending).toHaveLength(1);
  });

  it('still enqueues a coordinator when only per-agent jobs are pending', () => {
    // Per-agent jobs are transient work — they must NOT suppress the cadence.
    jobQueue.enqueue({
      queue: MEMORY_DISTILLATION,
      payload: { agentId: 'agent-a' },
      runAt: Date.now(),
    });
    jobQueue.enqueue({
      queue: MEMORY_DISTILLATION,
      payload: { agentId: 'agent-b' },
      runAt: Date.now(),
    });
    enqueueMemoryDistillationIfMissing(jobQueue, Date.now() + 1_000);

    const pending = jobQueue.listJobs({
      queue: MEMORY_DISTILLATION,
      status: 'pending',
      limit: 50,
    });
    const coordinators = pending.filter((job) => !job.payload?.agentId);
    expect(coordinators).toHaveLength(1);
  });

  it('does not enqueue a duplicate coordinator when one is pending among many per-agent jobs', () => {
    // The coordinator is enqueued FIRST (oldest row); ≥500 newer per-agent jobs
    // would push it outside a listJobs LIMIT window. The targeted payload query
    // must still find it. We approximate with a handful of per-agent jobs.
    jobQueue.enqueue({ queue: MEMORY_DISTILLATION, payload: {}, runAt: Date.now() }); // coordinator
    for (let i = 0; i < 5; i++) {
      jobQueue.enqueue({
        queue: MEMORY_DISTILLATION,
        payload: { agentId: `agent-${i}` },
        runAt: Date.now(),
      });
    }
    expect(jobQueue.hasPendingJobWithoutPayloadField(MEMORY_DISTILLATION, 'agentId')).toBe(true);
    enqueueMemoryDistillationIfMissing(jobQueue, Date.now() + 1_000);
    const coordinators = jobQueue
      .listJobs({ queue: MEMORY_DISTILLATION, status: 'pending', limit: 50 })
      .filter((job) => !job.payload?.agentId);
    expect(coordinators).toHaveLength(1); // no duplicate
  });
});
