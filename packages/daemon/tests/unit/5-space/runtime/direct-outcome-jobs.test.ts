import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SessionManager } from '../../../../src/lib/session/session-manager';
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
  const job = acceptedJob();
  cleanup.mockImplementation(async () => {
    throw new Error('process still live');
  });
  await expect(createDirectOutcomeHandler(deps)(job)).rejects.toThrow('remains unverified');
  expect(attempts.getActive(taskId)?.phase).toBe('running');
  expect(request()).toEqual({ accepted: true, jobId: job.id });
  cleanup.mockImplementation(async () => {});
  expect(await createDirectOutcomeHandler(deps)(job)).toHaveProperty('finalized', true);
});

test('receipt persistence failure rolls back both queued job and accepted stop intent', () => {
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE UPDATE OF finalization_job_id ON direct_task_stop_requests BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;"
  );
  expect(request).toThrow('receipt failed');
  expect(attempts.isStopRequested('attempt', 'worker')).toBe(false);
  expect(jobs.listJobs({ queue: DIRECT_TASK_OUTCOME })).toHaveLength(0);
});
