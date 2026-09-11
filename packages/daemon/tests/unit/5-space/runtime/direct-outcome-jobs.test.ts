import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  JobQueueRepository,
  type Job,
} from '../../../../src/storage/repositories/job-queue-repository';
import {
  createDirectOutcomeRequester,
  createDirectOutcomeHandler,
  registerDirectOutcomeJobs,
  DIRECT_TASK_OUTCOME,
} from '../../../../src/lib/space/runtime/direct-outcome-jobs';
import {
  requestDirectTaskFinalization,
  type DirectFinalizationInput,
} from '../../../../src/lib/space/runtime/finalize-direct-attempt';

let db: Database;
let jobs: JobQueueRepository;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
let cached: AgentSession | null;
let cleanup: ReturnType<typeof mock>;
let terminal: ReturnType<typeof mock>;
let deps: Parameters<typeof createDirectOutcomeHandler>[0];
const input: DirectFinalizationInput = {
  attemptId: 'attempt',
  sessionId: 'worker',
  generation: 1,
  status: 'blocked',
  options: { result: 'Frozen outcome' },
};
function request() {
  return createDirectOutcomeRequester(db, jobs)(input);
}
function acceptedJob(): Job {
  const accepted = request();
  expect(accepted.accepted).toBe(true);
  if (!accepted.accepted || !accepted.jobId) throw new Error('Expected durable job');
  return jobs.getJob(accepted.jobId)!;
}
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  jobs = new JobQueueRepository(db);
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'worker');
  expect(attempts.activate('attempt', 'worker')?.phase).toBe('running');
  tasks.updateTask(taskId, { status: 'in_progress', taskAgentSessionId: 'worker' });
  cleanup = mock(async () => {});
  terminal = mock(() => {});
  cached = {
    getSessionData: () => ({
      id: 'worker',
      type: 'worker',
      status: 'active',
      context: { taskId, spaceId },
    }),
    getProcessingState: () => ({ status: 'idle' }),
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
    handleInterrupt: async () => {},
    cleanup: () => cleanup(),
  } as unknown as AgentSession;
  const owner = Object.assign(Object.create(SessionManager.prototype), {
    directStopVerificationJobs: new Map(),
  }) as SessionManager;
  deps = {
    db,
    jobQueue: jobs,
    onTerminalTransition: terminal,
    sessionManager: {
      coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
      getCachedSession: () => cached,
      isSessionLoading: () => false,
      unregisterSession: async (_id, expected) => {
        if (cached === expected) cached = null;
      },
    },
  };
});
afterEach(() => db.close());

test('durable acknowledgement leaves caller running until the linked worker processes frozen input', async () => {
  const job = acceptedJob();
  const onTaskUpdated = mock(() => {
    expect(attempts.get('attempt')?.phase).toBe('stopped');
    expect(tasks.getTask(taskId)?.status).toBe('blocked');
  });
  deps.onTaskUpdated = onTaskUpdated;
  expect(onTaskUpdated).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
  expect(tasks.getTask(taskId)?.status).toBe('in_progress');
  expect(attempts.isStopRequested('attempt', 'worker')).toBe(true);
  expect(request()).toEqual({ accepted: true, jobId: job.id });
  expect(await createDirectOutcomeHandler(deps)(job)).toMatchObject({
    finalized: true,
    task: { status: 'blocked', result: 'Frozen outcome' },
  });
  expect(terminal).toHaveBeenCalledWith(taskId, 'in_progress');
  expect(onTaskUpdated).toHaveBeenCalledWith(
    expect.objectContaining({ id: taskId, status: 'blocked' })
  );
  expect(await createDirectOutcomeHandler(deps)(job)).toHaveProperty('finalized', true);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(terminal).toHaveBeenCalledTimes(1);
});

test('enqueue failure rolls back the durable request and stop fence', () => {
  db.exec(
    "CREATE TRIGGER reject_outcome_job BEFORE INSERT ON job_queue WHEN NEW.queue = 'direct_task_outcome' BEGIN SELECT RAISE(ABORT, 'enqueue failed'); END;"
  );
  expect(request).toThrow('enqueue failed');
  expect(attempts.isStopRequested('attempt', 'worker')).toBe(false);
  expect(jobs.listJobs({ queue: DIRECT_TASK_OUTCOME })).toHaveLength(0);
  expect(cleanup).not.toHaveBeenCalled();
});

for (const change of ['jobId', 'generation', 'session', 'queue'] as const) {
  test(`unlinked ${change} cannot trigger shutdown`, async () => {
    const job = acceptedJob();
    const changed = { ...job, payload: { ...job.payload } };
    if (change === 'jobId') changed.id = 'unlinked';
    if (change === 'generation') changed.payload.generation = 2;
    if (change === 'session') changed.payload.sessionId = 'other';
    if (change === 'queue') changed.queue = 'other';
    expect(await createDirectOutcomeHandler(deps)(changed)).toEqual({
      finalized: false,
      reason: 'unavailable',
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(attempts.getActive(taskId)?.phase).toBe('running');
  });
}

test('dead and pruned jobs retain receipt identity without resetting retries', () => {
  const job = acceptedJob();
  db.prepare("UPDATE job_queue SET status = 'dead', retry_count = max_retries WHERE id = ?").run(
    job.id
  );
  expect(request()).toEqual({ accepted: true, jobId: job.id });
  db.prepare('DELETE FROM job_queue WHERE id = ?').run(job.id);
  expect(request()).toEqual({ accepted: true, jobId: job.id });
  expect(jobs.listJobs({ queue: DIRECT_TASK_OUTCOME })).toHaveLength(0);
});

test('registration recovers unlinked requests and safely repeats startup recovery', async () => {
  requestDirectTaskFinalization(db, input);
  const register = mock(() => {});
  registerDirectOutcomeJobs({ ...deps, jobQueue: jobs, jobProcessor: { register } });
  registerDirectOutcomeJobs({ ...deps, jobQueue: jobs, jobProcessor: { register } });
  const queued = jobs.listJobs({ queue: DIRECT_TASK_OUTCOME });
  expect(queued).toHaveLength(1);
  expect(cleanup).not.toHaveBeenCalled();
  expect(register).toHaveBeenCalledWith(DIRECT_TASK_OUTCOME, expect.any(Function));
  expect(await createDirectOutcomeHandler(deps)(queued[0])).toHaveProperty('finalized', true);
});

test('unverified shutdown is retryable without dropping the durable request', async () => {
  acceptedJob();
  const [job] = jobs.dequeue(DIRECT_TASK_OUTCOME, 1);
  cleanup.mockImplementation(async () => {
    throw new Error('process still live');
  });
  expect(await createDirectOutcomeHandler(deps)(job)).toMatchObject({
    finalized: false,
    parked: 'direct_stop_unverified',
  });
  expect(jobs.getJob(job.id)).toMatchObject({ status: 'pending', retryCount: 0 });
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(request()).toEqual({ accepted: true, jobId: job.id });
  cleanup.mockImplementation(async () => {});
  jobs.reschedulePending(job.id, Date.now() - 1);
  const [retry] = jobs.dequeue(DIRECT_TASK_OUTCOME, 1);
  expect(await createDirectOutcomeHandler(deps)(retry)).toHaveProperty('finalized', true);
});

function freshUncachedManager(processor: JobQueueProcessor): SessionManager {
  type Args = ConstructorParameters<typeof SessionManager>;
  return new SessionManager(
    { getGoalRepo: () => ({}) } as Args[0],
    {} as Args[1],
    {} as Args[2],
    {} as Args[3],
    { subscribe: () => () => {} } as unknown as Args[4],
    { defaultModel: 'test', maxTokens: 100, temperature: 0 },
    jobs,
    processor
  );
}

async function waitForIdle(processor: JobQueueProcessor) {
  for (let i = 0; i < 1000 && processor.snapshot().inFlightTotal > 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(processor.snapshot().inFlightTotal).toBe(0);
}

test('uncached retries preserve the same job beyond its budget and settle once after valid proof', async () => {
  const job = acceptedJob();
  const processor = new JobQueueProcessor(jobs, { maxConcurrent: 1 });
  const manager = freshUncachedManager(processor);
  const onTaskUpdated = mock(() => {});
  registerDirectOutcomeJobs({
    ...deps,
    sessionManager: manager,
    jobProcessor: processor,
    jobQueue: jobs,
    onTaskUpdated,
  });
  try {
    expect(manager.getCachedSession('worker')).toBeNull();
    for (let i = 0; i < job.maxRetries + 3; i++) {
      expect(jobs.reschedulePending(job.id, Date.now() - 1)).toBe(true);
      expect(await processor.tick()).toBe(1);
      await waitForIdle(processor);
      expect(jobs.getJob(job.id)).toMatchObject({ status: 'pending', retryCount: 0 });
      expect(jobs.getJob(job.id)!.runAt).toBeGreaterThan(Date.now());
      expect(attempts.getActive(taskId)?.phase).toBe('running');
      expect(attempts.isStopRequested('attempt', 'worker')).toBe(true);
      expect(request()).toEqual({ accepted: true, jobId: job.id });
    }
    expect(terminal).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(attempts.beginStopVerification('attempt', 'worker', 1, 'valid-proof')).toBe(true);
    expect(attempts.recordStopVerification('attempt', 'worker', 1, 'valid-proof')).toBe(true);
    jobs.reschedulePending(job.id, Date.now() - 1);
    expect(await processor.tick()).toBe(1);
    await waitForIdle(processor);
    expect(jobs.getJob(job.id)).toMatchObject({ status: 'completed', retryCount: 0 });
    expect(attempts.get('attempt')?.phase).toBe('stopped');
    expect(tasks.getTask(taskId)?.status).toBe('blocked');
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(onTaskUpdated).toHaveBeenCalledTimes(1);
    expect(await processor.tick()).toBe(0);
  } finally {
    await processor.stop();
    await manager.cleanup();
  }
});

test('stale unverified handler cannot requeue or complete a replacement claim', async () => {
  const job = acceptedJob();
  const processor = new JobQueueProcessor(jobs);
  const manager = freshUncachedManager(processor);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let original: Job | undefined;
  const handler = createDirectOutcomeHandler({ ...deps, sessionManager: manager });
  processor.register(DIRECT_TASK_OUTCOME, async (claimed) => {
    original = claimed;
    await paused;
    return handler(claimed);
  });
  try {
    expect(await processor.tick()).toBe(1);
    expect(original?.claimToken).toBeTruthy();
    expect(jobs.requeue(job.id, Date.now() - 1, original!.claimToken)).not.toBeNull();
    const [replacement] = jobs.dequeue(DIRECT_TASK_OUTCOME, 1);
    expect(replacement.claimToken).not.toBe(original!.claimToken);
    release();
    await waitForIdle(processor);
    expect(jobs.getJob(job.id)).toEqual(replacement);
    expect(terminal).not.toHaveBeenCalled();
    expect(attempts.getActive(taskId)?.phase).toBe('running');
  } finally {
    release();
    await processor.stop();
    await manager.cleanup();
  }
});

test('unclaimed unverified handler cannot use an unfenced requeue', async () => {
  const job = acceptedJob();
  cached = null;
  await expect(createDirectOutcomeHandler(deps)(job)).rejects.toThrow('remains unverified');
  expect(jobs.getJob(job.id)).toEqual(job);
});

test('receipt persistence failure rolls back both queued job and accepted stop intent', () => {
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE UPDATE OF finalization_job_id ON direct_task_stop_requests BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;"
  );
  expect(request).toThrow('receipt failed');
  expect(attempts.isStopRequested('attempt', 'worker')).toBe(false);
  expect(jobs.listJobs({ queue: DIRECT_TASK_OUTCOME })).toHaveLength(0);
});
