import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { admitSubmission } from '../../../../src/lib/tasks/submit-for-review';
import type { CallContext, UpdateSpaceTaskParams, Session } from '@hyperneo/shared';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createDatabaseDirectTaskWorkerResolver } from '../../../../src/lib/tasks/direct-task-worker-identity';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/tasks/operations';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { SpaceTaskManager, StaleTaskGuardError } from '../../../../src/lib/tasks/task-manager';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createDirectTaskStarter } from '../../../../src/lib/tasks/start-direct-task';
import {
  admitCancellation,
  admitManagedCancellation,
  type CancelPolicyContext,
} from '../../../../src/lib/tasks/cancel-task';
import { createSpaceTransitionTaskOperation } from '../../../../src/lib/tasks/transition-task';
import { SpaceTransitionTaskInputSchema } from '../../../../src/lib/tasks/transition-task-admission';
import { enqueueDirectOutcome } from '../../../../src/lib/tasks/direct-outcome-jobs';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { readDirectFinalizationRequest } from '../../../../src/lib/tasks/finalize-direct-attempt';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import { createDirectOutcomeHandler } from '../../../../src/lib/tasks/direct-outcome-jobs';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

let db: Database;
let jobs: JobQueueRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
let sessionId: string;
let attemptId: string;
function sessionPolicy() {
  return {
    hasDirectWorkerProvenance: (id: string) => attempts.hasSessionProvenance(id),
    resolveDirectWorker: createDatabaseDirectTaskWorkerResolver(db),
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
  };
}
function createAgentSession(base: Session, id: string, type: Session['type'], spaceId: string) {
  const agent = new SpaceLongHorizonAgentRepository(db).create({
    spaceId,
    handle: id.replace(/[^a-z0-9-]/g, '-'),
    sessionId: id,
  });
  sessions.createSession(
    {
      ...base,
      id,
      type,
      context: { spaceId },
      metadata: {
        ...base.metadata,
        promptProvenance: { source: 'test', hash: 'h', agentId: agent.id },
      },
    },
    { enforceWorkspaceOwnership: false }
  );
}
function canceller(policy: CancelPolicyContext) {
  return {
    execute: async (input: { taskId: string }, caller: OperationCaller) => {
      const context = { ...sessionPolicy(), ...policy };
      const managed = await admitManagedCancellation(db, input, caller, context);
      if ('reason' in managed) return managed.reason;
      const direct = admitCancellation(db, input, caller, context);
      if ('reason' in direct) return direct.reason;
      return enqueueDirectOutcome(db, jobs, direct.value);
    },
  };
}
let operation: ReturnType<typeof canceller>;
beforeEach(async () => {
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
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  const started = await createDirectTaskStarter({
    db,
    defaultModel: 'claude-sonnet-4-6',
    sessionDb: {
      getSession: (id) => sessions.getSession(id),
      createSession: (session) =>
        sessions.createSession(session, { enforceWorkspaceOwnership: false }),
    },
    sessionManager: {
      getCachedSession: () => undefined,
      getSessionForControl: async (id) =>
        ({
          getSessionData: () => sessions.getSession(id)!,
          isQueryActiveOrStarting: () => false,
        }) as AgentSession,
      unregisterSession: async () => {},
    },
  })({ taskId, requestKey: 'start' });
  if (!started.started) throw new Error(started.reason);
  sessionId = started.attempt.sessionId;
  attemptId = started.attempt.id;
  operation = canceller({});
});
afterEach(() => db.close());
function outcomeCount() {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue='direct_task_outcome'").get() as {
      n: number;
    }
  ).n;
}

test.each(['rpc', 'internal', 'mcp'] as const)(
  '%s invocation returns a durable acknowledgement before shutdown, and repeating it while the stop is merely requested (attempt still running) replays the same ack idempotently',
  async (source) => {
    const result = await operation.execute({ taskId }, { source, sessionId });
    expect(result).toMatchObject({ accepted: true, jobId: expect.any(String) });
    expect(tasks.getTask(taskId)?.status).toBe('in_progress');
    expect(attempts.getActive(taskId)?.phase).toBe('running');
    expect(attempts.isStopRequested(attemptId, sessionId)).toBe(true);
    expect(readDirectFinalizationRequest(db, { attemptId, sessionId })).toMatchObject({
      status: 'cancelled',
    });
    expect(await operation.execute({ taskId }, { source, sessionId })).toEqual(result);
    expect(outcomeCount()).toBe(1);
  }
);
test.each(['missing', 'different', 'wrong-context', 'ended'] as const)(
  'MCP %s caller cannot cancel or create a stop fence',
  async (kind) => {
    if (kind === 'wrong-context')
      db.prepare('UPDATE sessions SET session_context = ? WHERE id = ?').run(
        JSON.stringify({ taskId: 'foreign', spaceId: 'foreign' }),
        sessionId
      );
    if (kind === 'ended')
      db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(sessionId);
    expect(
      await operation.execute(
        { taskId },
        {
          source: 'mcp',
          sessionId: kind === 'missing' ? undefined : kind === 'different' ? 'another' : sessionId,
        }
      )
    ).toMatchObject({ accepted: false, reason: 'direct_cancellation_denied' });
    expect(outcomeCount()).toBe(0);
    expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
  }
);
test('a frozen review request cannot be replaced with cancellation', async () => {
  const review = admitSubmission(db, { taskId }, { source: 'rpc' });
  if ('reason' in review) throw new Error('review submission was not admitted');
  expect(enqueueDirectOutcome(db, jobs, review.value)).toMatchObject({ accepted: true });
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toMatchObject({ accepted: false });
  expect(readDirectFinalizationRequest(db, { attemptId, sessionId })?.status).toBe('review');
  expect(outcomeCount()).toBe(1);
});
test('a replacement task pointer cannot be cancelled by the earlier worker', async () => {
  tasks.updateTask(taskId, { taskAgentSessionId: 'replacement' });
  expect(await operation.execute({ taskId }, { source: 'mcp', sessionId })).toMatchObject({
    accepted: false,
  });
  expect(outcomeCount()).toBe(0);
});
test('missing task rejects and schema does not accept caller-owned execution identity', async () => {
  expect(await operation.execute({ taskId: 'missing' }, { source: 'rpc' })).toMatchObject({
    accepted: false,
  });
  expect(
    SpaceTransitionTaskInputSchema.safeParse({ taskId, status: 'cancelled', attemptId, sessionId })
      .success
  ).toBe(false);
  expect(outcomeCount()).toBe(0);
});
test('enqueue failure rolls back stop request and later cancellation can succeed', async () => {
  db.exec(
    "CREATE TRIGGER fail_outcome BEFORE INSERT ON job_queue WHEN NEW.queue='direct_task_outcome' BEGIN SELECT RAISE(ABORT,'queue failed'); END"
  );
  await expect(operation.execute({ taskId }, { source: 'rpc' })).rejects.toThrow('queue failed');
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
  expect(outcomeCount()).toBe(0);
  db.exec('DROP TRIGGER fail_outcome');
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toMatchObject({ accepted: true });
});

test.each(['rpc', 'internal', 'mcp'] as const)(
  'a repeat %s cancellation once the attempt is fully finalized is rejected as unavailable, not replayed as an acknowledgement, even from an ended session',
  async (source) => {
    const accepted = (await operation.execute({ taskId }, { source, sessionId })) as {
      accepted: true;
      jobId: string;
    };
    const dependent = tasks.createTask({
      spaceId: tasks.getTask(taskId)!.spaceId!,
      title: 'Dependent',
      description: '',
      dependsOn: [taskId],
    });
    const terminal = mock(() => {});
    let cached = {
      getSessionData: () => sessions.getSession(sessionId)!,
      getProcessingState: () => ({ status: 'idle' }),
      isInterruptInProgress: () => false,
      getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
      handleInterrupt: async () => {},
      cleanup: async () => {},
    } as unknown as AgentSession | null;
    const owner = Object.assign(Object.create(SessionManager.prototype), {
      directStopVerificationJobs: new Map(),
    }) as SessionManager;
    const result = await createDirectOutcomeHandler({
      db,
      jobQueue: jobs,
      onTerminalTransition: terminal,
      sessionManager: {
        coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
        getCachedSession: () => cached,
        isSessionLoading: () => false,
        unregisterSession: async () => {
          cached = null;
        },
      },
    })(jobs.getJob(accepted.jobId)!);
    expect(result).toMatchObject({ finalized: true });
    expect(attempts.getActive(taskId)).toBeNull();
    expect(tasks.getTask(taskId)?.status).toBe('cancelled');
    expect(tasks.getTask(dependent.id)?.status).toBe(dependent.status);
    expect(terminal).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(sessionId);
    expect(await operation.execute({ taskId }, { source, sessionId })).toMatchObject({
      accepted: false,
      reason: 'cancellation_unavailable',
    });
    expect(outcomeCount()).toBe(1);
  }
);

test('configured shared catalog discovers lazily and both transports persist the same request', async () => {
  const getDatabase = mock(() => db);
  const database = { getDatabase, notifyChange: () => {} } as unknown as AppDatabase;
  const provider = createSpaceOperationRegistryProvider(
    database,
    jobs,
    {
      getSession: (id) => sessions.getSession(id),
      getTaskManager: (id) => new SpaceTaskManager(db, id),
      taskRepo: tasks,
      notifyStandalone: () => {},
      emitTaskUpdated: async () => {},
      emitTaskCreated: async () => {},
      getSpace: (id: string) => new SpaceRepository(db).getSpace(id),
      validateDefaultTaskWorkspace: async () => null,
      blockExecution: async () => {
        throw new Error('unexpected workflow cleanup');
      },
      requiresPostApprovalOwner: () => false,
      completionGate: async () => ({ ok: true as const }),
    },
    undefined,
    undefined,
    {
      getSession: (id) => sessions.getSession(id),
      getTaskManager: (id) => new SpaceTaskManager(db, id),
      notifyStandalone: () => {},
      emitTaskUpdated: async () => {},
      isWorkflowRunActive: () => false,
      ...sessionPolicy(),
    }
  );
  const rpc = createOperationRpcHandler(provider, () => ({}));
  const mcp = createOperationMcpHandler(provider, () => ({ sessionId }));
  const context = {} as CallContext;
  const invocation = { name: 'task.transition', input: { taskId, status: 'cancelled' } };
  expect(provider()).toBe(provider());
  expect(
    await rpc({ name: 'operations.describe', input: { name: invocation.name } }, context)
  ).toMatchObject({ found: true, name: invocation.name });
  expect(getDatabase).not.toHaveBeenCalled();
  expect(createDatabaseOperationCatalog(database, jobs).get(invocation.name)?.description).not.toBe(
    provider().get(invocation.name)?.description
  );
  const foreign = createOperationMcpHandler(provider, () => ({ sessionId: 'foreign' }));
  expect(JSON.parse((await foreign(invocation)).content[0].text)).toMatchObject({
    accepted: false,
  });
  expect(outcomeCount()).toBe(0);
  const accepted = await rpc(invocation, context);
  expect(accepted).toMatchObject({ accepted: true });
  expect(JSON.parse((await mcp(invocation)).content[0].text)).toEqual(accepted);
  expect(outcomeCount()).toBe(1);
  expect(tasks.getTask(taskId)?.status).toBe('in_progress');
});

test.each(['space_chat', 'general', 'space_task_agent'] as const)(
  'active persisted %s caller in the owning Space can cancel',
  async (type) => {
    const worker = sessions.getSession(sessionId)!;
    const callerId =
      type === 'space_chat' ? `space:chat:${worker.context!.spaceId}` : `caller-${type}`;
    createAgentSession(worker, callerId, type, worker.context!.spaceId!);
    expect(
      await operation.execute({ taskId }, { source: 'mcp', sessionId: callerId })
    ).toMatchObject({ accepted: true });
    expect(outcomeCount()).toBe(1);
  }
);

test('a reserved attempt with a retained task session is fenced and cancelled through the manager, not frozen as an outcome', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='reserved' WHERE id=?").run(
    attemptId
  );
  const emitTaskUpdated = mock(async () => {});
  const managedOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated,
  });
  expect(await managedOp.execute({ taskId }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(outcomeCount()).toBe(0);
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(true);
  expect(attempts.get(attemptId)?.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('cancelled');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
});

test('a completion landing between the read and the guarded write blocks both the fence and the status overwrite', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='reserved' WHERE id=?").run(
    attemptId
  );
  const realGetTask = SpaceTaskRepository.prototype.getTask;
  let calls = 0;
  const spy = spyOn(SpaceTaskRepository.prototype, 'getTask').mockImplementation(function (
    this: SpaceTaskRepository,
    id: string
  ) {
    calls += 1;
    const row = realGetTask.call(this, id);
    if (calls === 2) db.prepare("UPDATE space_tasks SET status='done' WHERE id=?").run(id);
    return row;
  });
  const emitTaskUpdated = mock(async () => {});
  const managedOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated,
  });
  try {
    expect(await managedOp.execute({ taskId }, { source: 'rpc' })).toEqual({
      accepted: false,
      reason: 'cancellation_unavailable',
    });
  } finally {
    spy.mockRestore();
  }
  expect(tasks.getTask(taskId)?.status).toBe('done');
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
  expect(attempts.get(attemptId)?.phase).toBe('reserved');
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

test('a task with a retained agent session whose attempt already stopped is cancelled through the manager, not the direct binding', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='stopped' WHERE id=?").run(attemptId);
  const emitTaskUpdated = mock(async () => {});
  const managedOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated,
  });
  expect(await managedOp.execute({ taskId }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(outcomeCount()).toBe(0);
  expect(attempts.get(attemptId)?.phase).toBe('stopped');
  expect(tasks.getTask(taskId)?.status).toBe('cancelled');
});

function mockStopForStatus() {
  return mock((_spaceId: string, taskId: string, params: UpdateSpaceTaskParams) =>
    Promise.resolve(tasks.updateTask(taskId, { status: params.status }))
  );
}

function unusedBlockExecution() {
  return mock(async () => {
    throw new Error('blockExecution must not be used for workflow-owned cancellation');
  });
}

function createWorkflowRunId(spaceId: string) {
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Workflow' });
  return new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
}

test.each(['rpc', 'internal'] as const)(
  '%s caller cancels a workflow-owned task through stopForStatus without cascading or using blockExecution',
  async (source) => {
    const spaceId = tasks.getTask(taskId)!.spaceId!;
    tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
    const dependent = tasks.createTask({
      spaceId,
      title: 'Dependent',
      description: '',
      dependsOn: [taskId],
    });
    const stopForStatus = mockStopForStatus();
    const blockExecution = unusedBlockExecution();
    const deps = { stopForStatus, blockExecution };
    const workflowOp = canceller(deps);
    expect(await workflowOp.execute({ taskId }, { source })).toEqual({
      accepted: true,
      jobId: null,
    });
    expect(stopForStatus).toHaveBeenCalledWith(spaceId, taskId, { status: 'cancelled' });
    expect(stopForStatus).toHaveBeenCalledTimes(1);
    expect(blockExecution).not.toHaveBeenCalled();
    expect(tasks.getTask(taskId)?.status).toBe('cancelled');
    expect(tasks.getTask(dependent.id)?.status).toBe('open');
    expect(outcomeCount()).toBe(0);
  }
);

test('MCP caller in the owning Space is admitted for a workflow-owned task', async () => {
  const worker = sessions.getSession(sessionId)!;
  const spaceId = worker.context!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  createAgentSession(worker, 'coordinator', 'space_chat', spaceId);
  const stopForStatus = mockStopForStatus();
  const workflowOp = canceller({ stopForStatus });
  expect(await workflowOp.execute({ taskId }, { source: 'mcp', sessionId: 'coordinator' })).toEqual(
    { accepted: true, jobId: null }
  );
  expect(stopForStatus).toHaveBeenCalledTimes(1);
});

test('MCP caller outside the owning Space is denied for a workflow-owned task', async () => {
  const worker = sessions.getSession(sessionId)!;
  const spaceId = worker.context!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  sessions.createSession(
    { ...worker, id: 'coordinator', type: 'space_chat', context: { spaceId: 'other-space' } },
    { enforceWorkspaceOwnership: false }
  );
  const stopForStatus = mockStopForStatus();
  const workflowOp = canceller({ stopForStatus });
  expect(
    await workflowOp.execute({ taskId }, { source: 'mcp', sessionId: 'coordinator' })
  ).toMatchObject({ accepted: false, reason: 'cancellation_denied' });
  expect(stopForStatus).not.toHaveBeenCalled();
});

test('an already-cancelled workflow-owned task returns unavailable', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId), status: 'cancelled' });
  const stopForStatus = mockStopForStatus();
  const workflowOp = canceller({ stopForStatus });
  expect(await workflowOp.execute({ taskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_unavailable',
  });
  expect(stopForStatus).not.toHaveBeenCalled();
});

test('workflow-owned cancellation is unavailable when the stop binding is not configured', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  const workflowOp = canceller({});
  expect(await workflowOp.execute({ taskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_unavailable',
  });
});

test('an archived workflow-owned task returns cancellation_unavailable, not direct_cancellation_unavailable', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  tasks.archiveTask(taskId);
  const stopForStatus = mockStopForStatus();
  const workflowOp = canceller({ stopForStatus });
  expect(await workflowOp.execute({ taskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_unavailable',
  });
  expect(stopForStatus).not.toHaveBeenCalled();
});

test('a stop rejection naming an invalid transition surfaces cancellation_invalid_transition', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  const stopForStatus = mock(async () => {
    throw new Error("Invalid status transition from 'in_progress' to 'cancelled'. Allowed: none");
  });
  const workflowOp = canceller({ stopForStatus });
  expect(await workflowOp.execute({ taskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_invalid_transition',
  });
});

test('a stale workflow stop guard surfaces cancellation_unavailable', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  const stopForStatus = mock(async () => {
    throw new StaleTaskGuardError('Task transition snapshot is stale');
  });
  const workflowOp = canceller({ stopForStatus });
  expect(await workflowOp.execute({ taskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_unavailable',
  });
});

test('an unrelated stop failure is not swallowed as a domain rejection and surfaces as execution_failed', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  tasks.updateTask(taskId, { workflowRunId: createWorkflowRunId(spaceId) });
  const stopForStatus = mock(async () => {
    throw new Error('ECONNRESET');
  });
  const registry = createOperationRegistry([transitionOperation({ stopForStatus }).operation]);
  const outcome = await invokeOperation(
    registry,
    'task.transition',
    { taskId, status: 'cancelled' },
    { source: 'rpc' }
  );
  expect(outcome).toMatchObject({ kind: 'failed', code: 'execution_failed' });
});

test('a plain in_progress task is cancelled directly through the task manager, without a stop call', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({
    spaceId,
    title: 'Plain',
    description: '',
    status: 'in_progress',
  }).id;
  const emitTaskUpdated = mock(async () => {});
  const stopForStatus = mockStopForStatus();
  const plainOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated,
    stopForStatus,
  });
  expect(await plainOp.execute({ taskId: plainTaskId }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(plainTaskId)?.status).toBe('cancelled');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  expect(stopForStatus).not.toHaveBeenCalled();
});

test('a plain open task can be cancelled', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({ spaceId, title: 'Plain', description: '' }).id;
  const plainOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: async () => {},
  });
  expect(await plainOp.execute({ taskId: plainTaskId }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(plainTaskId)?.status).toBe('cancelled');
});

test('a plain task with a reserved direct attempt and no session yet is fenced then cancelled through the manager', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({ spaceId, title: 'Plain', description: '' }).id;
  attempts.select(plainTaskId);
  const reserved = attempts.claim(plainTaskId, 'direct-reserved', 'reserved-session');
  expect(reserved).not.toBeNull();
  const emitTaskUpdated = mock(async () => {});
  const plainOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated,
  });
  expect(await plainOp.execute({ taskId: plainTaskId }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(plainTaskId)?.status).toBe('cancelled');
  expect(attempts.isStopRequested(reserved!.id, reserved!.sessionId)).toBe(true);
  expect(attempts.get(reserved!.id)?.phase).toBe('reserved');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
});

test('a plain done task returns cancellation_unavailable', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({
    spaceId,
    title: 'Plain',
    description: '',
    status: 'done',
  }).id;
  const plainOp = canceller({
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated: async () => {},
  });
  expect(await plainOp.execute({ taskId: plainTaskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_unavailable',
  });
});

test('an MCP session in another Space cannot cancel a plain task', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({ spaceId, title: 'Plain', description: '' }).id;
  const worker = sessions.getSession(sessionId)!;
  sessions.createSession(
    { ...worker, id: 'coordinator', type: 'space_chat', context: { spaceId: 'other-space' } },
    { enforceWorkspaceOwnership: false }
  );
  const getTaskManager = mock((id: string) => new SpaceTaskManager(db, id));
  const plainOp = canceller({
    getTaskManager,
    emitTaskUpdated: async () => {},
  });
  expect(
    await plainOp.execute({ taskId: plainTaskId }, { source: 'mcp', sessionId: 'coordinator' })
  ).toMatchObject({ accepted: false, reason: 'cancellation_denied' });
  expect(getTaskManager).not.toHaveBeenCalled();
  expect(tasks.getTask(plainTaskId)?.status).toBe('open');
});

test('a plain-task transition rejection surfaces cancellation_invalid_transition', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({ spaceId, title: 'Plain', description: '' }).id;
  const plainOp = canceller({
    getTaskManager: () => ({
      setTaskStatus: async () => {
        throw new Error("Invalid status transition from 'open' to 'cancelled'. Allowed: none");
      },
    }),
    emitTaskUpdated: async () => {},
  });
  expect(await plainOp.execute({ taskId: plainTaskId }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'cancellation_invalid_transition',
  });
});

function transitionOperation(overrides: Record<string, unknown> = {}) {
  const emitTaskUpdated = mock(async () => {});
  const operationUnderTest = createSpaceTransitionTaskOperation({
    db,
    getSession: (id) => sessions.getSession(id),
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    notifyStandalone: () => {},
    emitTaskUpdated,
    isWorkflowRunActive: () => false,
    requestDirectOutcome: (input) => enqueueDirectOutcome(db, jobs, input),
    ...sessionPolicy(),
    ...overrides,
  } as Parameters<typeof createSpaceTransitionTaskOperation>[0]);
  return { operation: operationUnderTest, emitTaskUpdated };
}

test('task.transition to cancelled queues a durable outcome for a running attempt', async () => {
  const { operation: transition } = transitionOperation();

  const viaTransition = await transition.execute(
    { taskId, status: 'cancelled' },
    { source: 'rpc' }
  );

  expect(viaTransition).toMatchObject({ accepted: true, jobId: expect.any(String) });
  expect(tasks.getTask(taskId)?.status).toBe('in_progress');
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(true);
  expect(readDirectFinalizationRequest(db, { attemptId, sessionId })).toMatchObject({
    status: 'cancelled',
  });
  expect(outcomeCount()).toBe(1);
});

test('task.transition fences a reserved attempt instead of queueing an outcome', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='reserved' WHERE id=?").run(
    attemptId
  );
  const { operation: transition, emitTaskUpdated } = transitionOperation();

  expect(await transition.execute({ taskId, status: 'cancelled' }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });

  expect(outcomeCount()).toBe(0);
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(true);
  expect(attempts.get(attemptId)?.phase).toBe('reserved');
  expect(tasks.getTask(taskId)?.status).toBe('cancelled');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
});

test('an inactive MCP session is refused at the transition door, before the cancel stage', async () => {
  db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(sessionId);
  const { operation: transition } = transitionOperation();

  expect(
    await transition.execute({ taskId, status: 'cancelled' }, { source: 'mcp', sessionId })
  ).toMatchObject({ accepted: false, reason: 'task_transition_denied' });
  expect(outcomeCount()).toBe(0);
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
});

test('the attempt worker itself still cancels through the transition door', async () => {
  const { operation: transition } = transitionOperation();

  expect(
    await transition.execute({ taskId, status: 'cancelled' }, { source: 'mcp', sessionId })
  ).toMatchObject({ accepted: true, jobId: expect.any(String) });
  expect(readDirectFinalizationRequest(db, { attemptId, sessionId })).toMatchObject({
    status: 'cancelled',
  });
  expect(outcomeCount()).toBe(1);
});

test('task.transition reports cancellation_unavailable for an already terminal plain task', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({
    spaceId,
    title: 'Plain',
    description: '',
    status: 'done',
  }).id;
  const { operation: transition } = transitionOperation();

  expect(
    await transition.execute({ taskId: plainTaskId, status: 'cancelled' }, { source: 'rpc' })
  ).toEqual({ accepted: false, reason: 'cancellation_unavailable' });
  expect(tasks.getTask(plainTaskId)?.status).toBe('done');
});

test('a direct start claimed between the route read and the write is refused', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const plainTaskId = tasks.createTask({ spaceId, title: 'Plain', description: '' }).id;
  attempts.select(plainTaskId);

  const realGetActive = DirectTaskExecutionRepository.prototype.getActive;
  let reads = 0;
  const spy = spyOn(DirectTaskExecutionRepository.prototype, 'getActive').mockImplementation(
    function (this: DirectTaskExecutionRepository, id: string) {
      reads += 1;
      if (reads === 1 && id === plainTaskId) return null;
      return realGetActive.call(this, id);
    }
  );
  attempts.claim(plainTaskId, 'late-claim', 'late-session');

  const run = transitionOperation().operation.execute(
    { taskId: plainTaskId, status: 'cancelled' },
    { source: 'rpc' }
  );

  expect(await run).toEqual({ accepted: false, reason: 'cancellation_unavailable' });
  expect(tasks.getTask(plainTaskId)?.status).toBe('open');
  expect(attempts.get('late-claim')?.phase).toBe('reserved');
  spy.mockRestore();
});
