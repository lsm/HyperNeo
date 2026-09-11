import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { createPendingCompletionOperation } from '../../../../src/lib/space/operations/pending-completion';
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/space/operations/registry';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import { createStartTaskOperation } from '../../../../src/lib/space/operations/start-task';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createTestSession } from '../../../helpers/database';
import type { CallContext } from '@hyperneo/shared';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  JobQueueRepository,
  type Job,
} from '../../../../src/storage/repositories/job-queue-repository';
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import {
  registerDirectStartJobs,
  createDirectStartRequester,
  createDirectStartJobHandler,
} from '../../../../src/lib/space/runtime/direct-start-jobs';
import {
  readDirectStartRequest,
  DIRECT_TASK_START,
} from '../../../../src/lib/space/runtime/direct-start-request';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import { createDirectTaskFinalizer } from '../../../../src/lib/space/runtime/finalize-direct-attempt';
import { readDirectKickoffIntent } from '../../../../src/lib/space/runtime/direct-kickoff-intent';

let db: Database;
let jobs: JobQueueRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
let control: Parameters<typeof createDirectStartJobHandler>[3];
let loading = false;
let load: ReturnType<typeof mock>;
let start: ReturnType<typeof createDirectTaskStarter>;
let request: ReturnType<typeof createDirectStartRequester>;
const inputKey = 'one';
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  jobs = new JobQueueRepository(db);
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  attempts = new DirectTaskExecutionRepository(db);
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  taskId = tasks.createTask({ spaceId, title: 'Task', description: 'Do work', status: 'draft' }).id;
  load = mock(
    async (id: string) =>
      ({
        getSessionData: () => sessions.getSession(id)!,
        isQueryActiveOrStarting: () => false,
      }) as AgentSession
  );
  start = createDirectTaskStarter({
    db,
    defaultModel: 'claude-sonnet-4-6',
    sessionDb: {
      getSession: (id) => sessions.getSession(id),
      createSession: (session) =>
        sessions.createSession(session, { enforceWorkspaceOwnership: false }),
    },
    sessionManager: {
      getCachedSession: () => undefined,
      getSessionForControl: load,
      unregisterSession: async () => {},
    },
  });
  request = createDirectStartRequester({ db, jobQueue: jobs });
  loading = false;
  const owner = Object.assign(Object.create(SessionManager.prototype), {
    directStopVerificationJobs: new Map(),
  }) as SessionManager;
  control = {
    getCachedSession: () => undefined,
    isSessionLoading: () => loading,
    unregisterSession: async () => {},
    coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
  };
});
afterEach(() => db.close());
function acceptedJob() {
  const ack = request({ taskId, requestKey: inputKey });
  if (!ack.accepted || !ack.jobId) throw new Error('expected receipt');
  return jobs.getJob(ack.jobId)!;
}
function count() {
  return (db.prepare('SELECT COUNT(*) AS n FROM direct_task_start_requests').get() as { n: number })
    .n;
}

test('ack atomically publishes, reserves and freezes job before loading any session', async () => {
  const job = acceptedJob();
  const reserved = attempts.getActive(taskId)!;
  expect(reserved.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('open');
  expect(load).not.toHaveBeenCalled();
  expect(readDirectStartRequest(db, reserved.id)).toEqual({
    input: { taskId, requestKey: inputKey },
    jobId: job.id,
    lifecycleGeneration: tasks.getLifecycleGeneration(taskId),
  });
  expect(request({ taskId, requestKey: inputKey })).toEqual({ accepted: true, jobId: job.id });
  expect(count()).toBe(1);
  expect(await createDirectStartJobHandler(db, start, jobs, control)(job)).toMatchObject({
    started: true,
  });
  expect(request({ taskId, requestKey: inputKey })).toEqual({ accepted: true, jobId: job.id });
  expect(await createDirectStartJobHandler(db, start, jobs, control)(job)).toMatchObject({
    started: true,
  });
  expect(load).toHaveBeenCalledTimes(1);
});
test('fresh handler resumes frozen request after failed session loading', async () => {
  const job = acceptedJob();
  load.mockResolvedValueOnce(null);
  await expect(createDirectStartJobHandler(db, start, jobs, control)(job)).rejects.toThrow(
    'Direct start remains unavailable'
  );
  expect(attempts.getActive(taskId)?.phase).toBe('reserved');
  expect(
    await createDirectStartJobHandler(db, start, jobs, control)(jobs.getJob(job.id)!)
  ).toMatchObject({
    started: true,
  });
  expect(count()).toBe(1);
});
test('request queue failure rolls back draft publication and claim', () => {
  db.exec(
    "CREATE TRIGGER reject_start BEFORE INSERT ON job_queue WHEN NEW.queue='direct_task_start' BEGIN SELECT RAISE(ABORT,'queue failed'); END"
  );
  expect(() => acceptedJob()).toThrow('queue failed');
  expect(tasks.getTask(taskId)?.status).toBe('draft');
  expect(attempts.getActive(taskId)).toBeNull();
  expect(count()).toBe(0);
});
test('receipt failure rolls back the queued job and claim', () => {
  db.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON direct_task_start_requests BEGIN SELECT RAISE(ABORT,'receipt failed'); END"
  );
  expect(() => acceptedJob()).toThrow('receipt failed');
  expect(attempts.getActive(taskId)).toBeNull();
  expect(jobs.getLatestByPayload(DIRECT_TASK_START, {})).toBeNull();
});
test('stale or unlinked jobs never invoke the starter', async () => {
  const job = acceptedJob();
  const run = mock(start);
  const handler = createDirectStartJobHandler(db, run, jobs, control);
  expect(await handler({ ...job, id: 'other' })).toMatchObject({ reason: 'superseded' });
  expect(await handler({ ...job, queue: 'wrong' })).toMatchObject({ reason: 'unlinked_job' });
  const old = attempts.getActive(taskId)!;
  attempts.stop(old.id, old.sessionId, 'cancelled');
  expect(await handler(job)).toMatchObject({ reason: 'superseded' });
  expect(run).not.toHaveBeenCalled();
});
test('pruned job receipt is not silently recreated by duplicate request', () => {
  const job = acceptedJob();
  db.prepare('DELETE FROM job_queue WHERE id=?').run(job.id);
  expect(request({ taskId, requestKey: inputKey })).toEqual({ accepted: true, jobId: job.id });
  expect(jobs.getJob(job.id)).toBeNull();
  expect(count()).toBe(1);
});
test.each([
  'request',
  'shared-rejection',
  'paused-rejection',
  'manual-review',
  'manual-review-stale',
  'manual-review-stopped',
  'manual-review-stopped-stale',
] as const)('review rejection via %s retains frozen feedback', async (route) => {
  const initial = await start({ taskId, requestKey: 'initial' });
  if (!initial.started) throw new Error(initial.reason);
  let cached = {
    getSessionData: () => sessions.getSession(initial.attempt.sessionId)!,
    getProcessingState: () => ({ status: 'idle' }),
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
    handleInterrupt: async () => {},
    cleanup: async () => {},
  } as unknown as AgentSession | null;
  const owner = Object.assign(Object.create(SessionManager.prototype), {
    directStopVerificationJobs: new Map(),
  }) as SessionManager;
  const done = await createDirectTaskFinalizer({
    db,
    sessionManager: {
      coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
      getCachedSession: () => cached,
      isSessionLoading: () => false,
      unregisterSession: async () => {
        cached = null;
      },
    },
  })({
    attemptId: initial.attempt.id,
    sessionId: initial.attempt.sessionId,
    generation: initial.attempt.generation,
    status: route.includes('stopped')
      ? 'stopped'
      : route.startsWith('manual-review')
        ? 'blocked'
        : 'review',
  });
  expect(done.finalized).toBe(true);
  if (route.startsWith('manual-review')) {
    const manager = new SpaceTaskManager(db, tasks.getTask(taskId)!.spaceId);
    await manager.submitTaskForReview(taskId, { reason: 'manual review', submittedByNodeId: null });
    if (route.endsWith('-stale')) {
      tasks.updateTask(taskId, { status: 'in_progress' });
      tasks.updateTask(taskId, { status: 'review' });
      await expect(
        manager.reopenPendingCompletion(taskId, 'stale', {
          expectedPendingCompletionGeneration: tasks.getTask(taskId)!.pendingCompletionGeneration!,
        })
      ).rejects.toThrow('superseded');
      expect(attempts.getActive(taskId)).toBeNull();
      expect(count()).toBe(0);
      return;
    }
  }
  const generation = tasks.getTask(taskId)!.pendingCompletionGeneration!;
  const spaces = new SpaceRepository(db);
  const spaceId = tasks.getTask(taskId)!.spaceId;
  if (route === 'paused-rejection') spaces.pauseSpace(spaceId);
  const ack =
    route === 'request'
      ? request({
          taskId,
          requestKey: 'rejected',
          retryFrom: { attemptId: initial.attempt.id, generation: initial.attempt.generation },
          reviewRejection: {
            expectedPendingCompletionGeneration:
              tasks.getTask(taskId)!.pendingCompletionGeneration!,
            reason: '  Fix edge case  ',
          },
        })
      : await (async () => {
          const manager = new SpaceTaskManager(db, tasks.getTask(taskId)!.spaceId);
          const update = mock(async () => {
            throw new Error('atomic rejection must not write twice');
          });
          const rejected = await createPendingCompletionOperation({
            getTask: (id) => manager.getTask(id),
            reopenTask: (id, reason) =>
              manager.reopenPendingCompletion(id, reason, {
                expectedPendingCompletionGeneration: generation,
              }),
            updateTask: update,
            dispatchApproval: async () => {
              throw new Error('not approval');
            },
            warn: () => {},
          })({ taskId, approved: false, reason: '  Fix edge case  ' });
          expect(rejected.status).toBe('open');
          expect(rejected.approvalReason).toBe('  Fix edge case  ');
          expect(update).not.toHaveBeenCalled();
          const next = attempts.getActive(taskId)!;
          const receipt = readDirectStartRequest(db, next.id)!;
          await expect(
            manager.reopenPendingCompletion(taskId, 'different', {
              expectedPendingCompletionGeneration: generation,
            })
          ).rejects.toThrow('superseded');
          expect(attempts.getActive(taskId)?.id).toBe(next.id);
          return { accepted: true as const, jobId: receipt.jobId };
        })();
  if (!ack.accepted || !ack.jobId) throw new Error('expected retry receipt');
  expect(tasks.getTask(taskId)?.pendingCheckpointType).toBeNull();
  if (route === 'paused-rejection') {
    const reserved = attempts.getActive(taskId)!;
    const [claimed] = jobs.dequeue(DIRECT_TASK_START, 1);
    expect(await createDirectStartJobHandler(db, start, jobs, control)(claimed)).toMatchObject({
      parked: 'direct_start_not_ready',
    });
    expect(attempts.getActive(taskId)?.phase).toBe('reserved');
    expect(readDirectKickoffIntent(db, reserved.id)).toBeNull();
    expect(readDirectStartRequest(db, reserved.id)?.input.reviewRejection?.reason).toBe(
      '  Fix edge case  '
    );
    spaces.resumeSpace(spaceId);
  }
  tasks.updateTask(taskId, { approvalReason: 'Mutated note' });
  const result = await createDirectStartJobHandler(
    db,
    start,
    jobs,
    control
  )(jobs.getJob(ack.jobId)!);
  expect(result).toMatchObject({ started: true });
  const current = attempts.getActive(taskId)!;
  expect(readDirectKickoffIntent(db, current.id)?.message.message.content).toContain(
    '  Fix edge case  '
  );
});

async function waitForIdle(processor: JobQueueProcessor) {
  for (let i = 0; i < 100 && processor.snapshot().inFlightTotal > 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(processor.snapshot().inFlightTotal).toBe(0);
}
test('dependency readiness defers same claimed job beyond retry budget then starts once', async () => {
  const dependency = tasks.createTask({
    spaceId: tasks.getTask(taskId)!.spaceId,
    title: 'Dependency',
    description: '',
  });
  tasks.updateTask(taskId, { dependsOn: [dependency.id] });
  const job = acceptedJob();
  const processor = new JobQueueProcessor(jobs, { maxConcurrent: 1 });
  processor.register(DIRECT_TASK_START, createDirectStartJobHandler(db, start, jobs, control));
  try {
    for (let i = 0; i < job.maxRetries + 3; i++) {
      jobs.reschedulePending(job.id, Date.now() - 1);
      expect(await processor.tick()).toBe(1);
      await waitForIdle(processor);
      expect(jobs.getJob(job.id)).toMatchObject({ status: 'pending', retryCount: 0 });
      expect(count()).toBe(1);
    }
    tasks.updateTask(dependency.id, { status: 'done' });
    jobs.reschedulePending(job.id, Date.now() - 1);
    expect(await processor.tick()).toBe(1);
    await waitForIdle(processor);
    expect(jobs.getJob(job.id)).toMatchObject({ status: 'completed', retryCount: 0 });
    expect(attempts.getActive(taskId)?.phase).toBe('running');
  } finally {
    await processor.stop();
  }
});

test('stale claim cannot defer a replacement job claim', async () => {
  const job = acceptedJob();
  const [old] = jobs.dequeue(DIRECT_TASK_START, 1);
  expect(jobs.requeue(job.id, Date.now() - 1, old.claimToken)).not.toBeNull();
  const [replacement] = jobs.dequeue(DIRECT_TASK_START, 1);
  const unavailable = async () => ({ started: false as const, reason: 'not_ready' });
  expect(await createDirectStartJobHandler(db, unavailable, jobs, control)(old)).toMatchObject({
    reason: 'superseded_claim',
  });
  expect(jobs.getJob(job.id)).toEqual(replacement);
});

test.each(['cancelled', 'archived', 'done', 'blocked'] as const)(
  'terminal %s settles queued start after verified reservation release',
  async (status) => {
    const job = acceptedJob();
    const old = attempts.getActive(taskId)!;
    tasks.updateTask(taskId, { status });
    expect(await createDirectStartJobHandler(db, start, jobs, control)(job)).toMatchObject({
      reason: 'superseded',
    });
    expect(attempts.getActive(taskId)).toBeNull();
    expect(attempts.get(old.id)?.phase).toBe('stopped');
    expect(load).not.toHaveBeenCalled();
    expect(tasks.getTask(taskId)?.status).toBe(status);
  }
);
test('cancellation during loading retains fenced ownership until verification then releases exact reservation', async () => {
  const queued = acceptedJob();
  const [job] = jobs.dequeue(DIRECT_TASK_START, 1);
  const old = attempts.getActive(taskId)!;
  loading = true;
  const waiting = async () => {
    if (!attempts.isStopRequested(old.id, old.sessionId))
      tasks.updateTask(taskId, { status: 'cancelled' });
    return { started: false as const, reason: 'not_ready' };
  };
  const handler = createDirectStartJobHandler(db, waiting, jobs, control);
  expect(await handler(job)).toMatchObject({ parked: 'direct_start_cleanup_unverified' });
  expect(attempts.getActive(taskId)?.id).toBe(old.id);
  expect(attempts.isStopRequested(old.id, old.sessionId)).toBe(true);
  expect(attempts.activate(old.id, old.sessionId)).toBeNull();
  loading = false;
  tasks.updateTask(taskId, { status: 'open' });
  jobs.reschedulePending(queued.id, Date.now() - 1);
  const [next] = jobs.dequeue(DIRECT_TASK_START, 1);
  expect(await handler(next)).toMatchObject({ reason: 'superseded' });
  expect(attempts.getActive(taskId)).toBeNull();
  expect(request({ taskId, requestKey: 'replacement' })).toMatchObject({ accepted: true });
  const replacement = attempts.getActive(taskId)!;
  expect(await handler(next)).toMatchObject({ reason: 'superseded' });
  expect(attempts.getActive(taskId)?.id).toBe(replacement.id);
});

test.each(['between-jobs', 'during-load'] as const)(
  'lifecycle ABA %s cannot activate old frozen request',
  async (window) => {
    const queued = acceptedJob();
    if (window === 'between-jobs') {
      load.mockResolvedValueOnce(null);
      const [first] = jobs.dequeue(DIRECT_TASK_START, 1);
      expect(await createDirectStartJobHandler(db, start, jobs, control)(first)).toMatchObject({
        parked: 'direct_start_not_ready',
      });
      tasks.updateTask(taskId, { status: 'cancelled' });
      tasks.updateTask(taskId, { status: 'open' });
      jobs.reschedulePending(queued.id, Date.now() - 1);
    } else
      load.mockImplementationOnce(async (id: string) => {
        tasks.updateTask(taskId, { status: 'in_progress' });
        tasks.updateTask(taskId, { status: 'open' });
        return {
          getSessionData: () => sessions.getSession(id)!,
          isQueryActiveOrStarting: () => false,
        } as AgentSession;
      });
    const [job] = jobs.dequeue(DIRECT_TASK_START, 1);
    const previous = attempts.getActive(taskId)!;
    expect(await createDirectStartJobHandler(db, start, jobs, control)(job)).toMatchObject({
      reason: 'superseded',
    });
    expect(attempts.getActive(taskId)).toBeNull();
    expect(attempts.get(previous.id)?.phase).toBe('stopped');
    expect(readDirectKickoffIntent(db, previous.id)).toBeNull();
    expect(tasks.getTask(taskId)?.status).toBe('open');
  }
);

test('configured worker resumes the durable request without eager loading or ordinary task pickup', async () => {
  const ordinary = tasks.createTask({
    spaceId: tasks.getTask(taskId)!.spaceId,
    title: 'Ordinary task',
    description: 'Workflow default',
    status: 'open',
  });
  const job = acceptedJob();
  const register = mock();
  registerDirectStartJobs({
    db,
    defaultModel: 'configured-model',
    sessionDb: {
      getSession: (id) => sessions.getSession(id),
      createSession: (session) =>
        sessions.createSession(session, { enforceWorkspaceOwnership: false }),
    },
    sessionManager: { ...control, getSessionForControl: load },
    jobQueue: jobs,
    jobProcessor: { register },
  });
  expect(register).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledWith(DIRECT_TASK_START, expect.any(Function));
  expect(load).not.toHaveBeenCalled();
  expect(attempts.getActive(taskId)?.phase).toBe('reserved');
  const handler = register.mock.calls[0][1] as ReturnType<typeof createDirectStartJobHandler>;
  expect(await handler(job)).toMatchObject({ started: true });
  const active = attempts.getActive(taskId)!;
  expect(active.phase).toBe('running');
  expect(sessions.getSession(active.sessionId)?.config.model).toBe('configured-model');
  expect(await handler(job)).toMatchObject({ started: true, attempt: { id: active.id } });
  expect(load).toHaveBeenCalledTimes(1);
  expect(count()).toBe(1);
  expect(attempts.getActive(ordinary.id)).toBeNull();
  expect(tasks.getTask(ordinary.id)?.status).toBe('open');
});

test('legacy UI review rejection resumes only its matching active direct worker', async () => {
  const initial = await start({ taskId, requestKey: 'ui-review' });
  if (!initial.started) throw new Error(initial.reason);
  const manager = new SpaceTaskManager(db, tasks.getTask(taskId)!.spaceId);
  const review = await manager.submitTaskForReview(taskId, {
    reason: 'ready',
    submittedByNodeId: null,
  });
  const guard = { expectedPendingCompletionGeneration: review.pendingCompletionGeneration! };
  const rejected = await createPendingCompletionOperation({
    getTask: (id) => manager.getTask(id),
    reopenTask: (id, reason) => manager.reopenPendingCompletion(id, reason, guard),
    updateTask: (id, fields) => manager.updateTask(id, fields),
    dispatchApproval: async () => {
      throw new Error('not approval');
    },
    warn: () => {},
  })({ taskId, approved: false, reason: '  UI feedback  ' });
  expect(rejected.status).toBe('in_progress');
  expect(rejected.approvalReason).toBe('  UI feedback  ');
  expect(rejected.pendingCheckpointType).toBeNull();
  expect(attempts.getActive(taskId)?.id).toBe(initial.attempt.id);
  expect(count()).toBe(0);
  const nextReview = await manager.submitTaskForReview(taskId, {
    reason: 'again',
    submittedByNodeId: null,
  });
  attempts.requestStop(initial.attempt.id, initial.attempt.sessionId, 'cancelled');
  await expect(
    manager.reopenPendingCompletion(taskId, 'no', {
      expectedPendingCompletionGeneration: nextReview.pendingCompletionGeneration!,
    })
  ).rejects.toThrow('superseded');
  expect(tasks.getTask(taskId)?.status).toBe('review');
});

test('review submission cannot invalidate an unactivated direct request', async () => {
  const job = acceptedJob();
  const reserved = attempts.getActive(taskId)!;
  const before = tasks.getTask(taskId)!;
  const generation = tasks.getLifecycleGeneration(taskId);
  const requestBefore = readDirectStartRequest(db, reserved.id);
  const manager = new SpaceTaskManager(db, before.spaceId);
  await expect(
    manager.submitTaskForReview(taskId, {
      reason: 'premature review',
      submittedByNodeId: null,
    })
  ).rejects.toThrow('direct start is queued');
  expect(tasks.getTask(taskId)).toEqual(before);
  expect(tasks.getLifecycleGeneration(taskId)).toBe(generation);
  expect(readDirectStartRequest(db, reserved.id)).toEqual(requestBefore);
  expect(attempts.getActive(taskId)).toEqual(reserved);
  expect(await createDirectStartJobHandler(db, start, jobs, control)(job)).toMatchObject({
    started: true,
    attempt: { id: reserved.id },
  });
});

test('shared start transports return one durable receipt without preparing a session', async () => {
  const operation = createStartTaskOperation(() => db, jobs, {}, { onTaskReopened: () => {} });
  const registry = createOperationRegistry([operation]);
  const caller = 'member';
  sessions.createSession(
    { ...createTestSession(caller), context: { spaceId: tasks.getTask(taskId)!.spaceId } },
    { enforceWorkspaceOwnership: false }
  );
  const invocation = { name: 'task.start', input: { taskId, requestKey: 'shared' } };
  const rpc = createOperationRpcHandler(registry, () => ({}));
  const accepted = await rpc(invocation, {} as CallContext);
  expect(accepted).toMatchObject({ accepted: true, jobId: expect.any(String) });
  expect(
    JSON.parse(
      (await createOperationMcpHandler(registry, () => ({ sessionId: caller }))(invocation))
        .content[0].text
    )
  ).toEqual(accepted);
  expect(count()).toBe(1);
  expect(attempts.getActive(taskId)?.phase).toBe('reserved');
  expect(load).not.toHaveBeenCalled();
  expect(
    await operation.execute({ taskId, requestKey: 'competing' }, { source: 'rpc' })
  ).toMatchObject({ accepted: false });
  expect(
    operation.inputSchema.safeParse({
      taskId,
      requestKey: 'spoof',
      retryFrom: { attemptId: 'foreign', generation: 1 },
    }).success
  ).toBe(false);
});

test.each(['missing', 'foreign', 'ended'] as const)(
  'shared start rejects %s MCP caller without claiming',
  async (kind) => {
    if (kind !== 'missing')
      sessions.createSession(
        {
          ...createTestSession('caller'),
          status: kind === 'ended' ? 'ended' : 'active',
          context: { spaceId: kind === 'foreign' ? 'other' : tasks.getTask(taskId)!.spaceId },
        },
        { enforceWorkspaceOwnership: false }
      );
    const operation = createStartTaskOperation(() => db, jobs, {}, { onTaskReopened: () => {} });
    expect(
      await operation.execute(
        { taskId, requestKey: 'denied' },
        { source: 'mcp', sessionId: 'caller' }
      )
    ).toMatchObject({ accepted: false });
    expect(attempts.getActive(taskId)).toBeNull();
    expect(count()).toBe(0);
  }
);

test.each(['blocked', 'cancelled', 'stopped'] as const)(
  'shared start derives verified %s retry identity and replays its receipt',
  async (status) => {
    const initial = await start({ taskId, requestKey: 'initial' });
    if (!initial.started) throw new Error(initial.reason);
    let cached = {
      getSessionData: () => sessions.getSession(initial.attempt.sessionId)!,
      getProcessingState: () => ({ status: 'idle' }),
      isInterruptInProgress: () => false,
      getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
      handleInterrupt: async () => {},
      cleanup: async () => {},
    } as unknown as AgentSession | null;
    const owner = Object.assign(Object.create(SessionManager.prototype), {
      directStopVerificationJobs: new Map(),
    }) as SessionManager;
    const finalized = await createDirectTaskFinalizer({
      db,
      sessionManager: {
        coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
        getCachedSession: () => cached,
        isSessionLoading: () => false,
        unregisterSession: async () => {
          cached = null;
        },
      },
    })({
      attemptId: initial.attempt.id,
      sessionId: initial.attempt.sessionId,
      generation: initial.attempt.generation,
      status,
    });
    expect(finalized.finalized).toBe(true);
    const reopened = mock(() => {});
    const operation = createStartTaskOperation(() => db, jobs, {}, { onTaskReopened: reopened });
    const input = { taskId, requestKey: 'retry' };
    const accepted = await operation.execute(input, { source: 'rpc' });
    expect(accepted).toMatchObject({ accepted: true, jobId: expect.any(String) });
    const next = attempts.getActive(taskId)!;
    expect(next.generation).toBe(initial.attempt.generation + 1);
    expect(readDirectStartRequest(db, next.id)?.input.retryFrom).toEqual({
      attemptId: initial.attempt.id,
      generation: initial.attempt.generation,
    });
    expect(await operation.execute(input, { source: 'rpc' })).toEqual(accepted);
    expect(reopened).toHaveBeenCalledTimes(1);
  }
);

test('configured start capability is lazy and requires bound lifecycle callbacks', async () => {
  const getDatabase = mock(() => db);
  const database = { getDatabase, notifyChange: () => {} } as unknown as AppDatabase;
  const dependencies = {
    getSession: (id: string) => sessions.getSession(id),
    getTaskManager: (id: string) => new SpaceTaskManager(db, id),
    taskRepo: tasks,
    notifyStandalone: () => {},
    emitTaskUpdated: async () => {},
    blockExecution: async () => {
      throw new Error('unexpected workflow');
    },
  };
  expect(
    createSpaceOperationRegistryProvider(database, jobs, dependencies)().get('task.start')
  ).toBeUndefined();
  const provider = createSpaceOperationRegistryProvider(database, jobs, dependencies, undefined, {
    onTaskReopened: () => {},
  });
  const rpc = createOperationRpcHandler(provider, () => ({}));
  expect(
    await rpc({ name: 'operations.describe', input: { name: 'task.start' } }, {} as CallContext)
  ).toMatchObject({ found: true });
  expect(getDatabase).not.toHaveBeenCalled();
  expect(
    await rpc(
      { name: 'task.start', input: { taskId, requestKey: 'configured' } },
      {} as CallContext
    )
  ).toMatchObject({ accepted: true });
  expect(load).not.toHaveBeenCalled();
});
