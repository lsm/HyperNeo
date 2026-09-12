import type { CallContext } from '@hyperneo/shared';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/space/operations/registry';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import { createSubmitTaskForReviewOperation } from '../../../../src/lib/space/operations/submit-for-review';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { readDirectFinalizationRequest } from '../../../../src/lib/space/runtime/finalize-direct-attempt';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import { createDirectOutcomeHandler } from '../../../../src/lib/space/runtime/direct-outcome-jobs';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

let db: Database;
let jobs: JobQueueRepository;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let attempts: DirectTaskExecutionRepository;
let taskId: string;
let sessionId: string;
let attemptId: string;
let operation: ReturnType<typeof createSubmitTaskForReviewOperation>;
let emitTaskUpdated: ReturnType<typeof mock>;
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
  emitTaskUpdated = mock(async () => {});
  operation = createSubmitTaskForReviewOperation(() => db, jobs, {
    getTaskManager: (id) => new SpaceTaskManager(db, id),
    emitTaskUpdated,
  });
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
  '%s invocation returns durable acknowledgement before shutdown/status changes',
  async (source) => {
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('task.submitForReview')!
      .execute({ taskId, reason: '  Ready  ' }, { source, sessionId });
    expect(result).toMatchObject({ accepted: true, jobId: expect.any(String) });
    expect(tasks.getTask(taskId)?.status).toBe('in_progress');
    expect(attempts.getActive(taskId)?.phase).toBe('running');
    expect(attempts.isStopRequested(attemptId, sessionId)).toBe(true);
    expect(readDirectFinalizationRequest(db, { attemptId, sessionId })).toMatchObject({
      status: 'review',
      reviewReason: '  Ready  ',
    });
    expect(await operation.execute({ taskId, reason: '  Ready  ' }, { source, sessionId })).toEqual(
      result
    );
    expect(outcomeCount()).toBe(1);
  }
);
test.each(['missing', 'different', 'wrong-context', 'wrong-type', 'ended'] as const)(
  'MCP %s caller cannot submit or create a stop fence',
  async (kind) => {
    if (kind === 'wrong-context')
      db.prepare('UPDATE sessions SET session_context = ? WHERE id = ?').run(
        JSON.stringify({ taskId: 'foreign', spaceId: 'foreign' }),
        sessionId
      );
    if (kind === 'wrong-type')
      db.prepare("UPDATE sessions SET type='general' WHERE id=?").run(sessionId);
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
    ).toMatchObject({ accepted: false, reason: 'direct_review_submission_denied' });
    expect(outcomeCount()).toBe(0);
    expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
  }
);
test('changed reason cannot overwrite frozen outcome or duplicate its job', async () => {
  await operation.execute({ taskId, reason: 'first' }, { source: 'mcp', sessionId });
  expect(
    await operation.execute({ taskId, reason: 'second' }, { source: 'mcp', sessionId })
  ).toMatchObject({ accepted: false });
  expect(readDirectFinalizationRequest(db, { attemptId, sessionId })?.reviewReason).toBe('first');
  expect(outcomeCount()).toBe(1);
});
test('a replacement task pointer cannot be submitted by the earlier worker', async () => {
  tasks.updateTask(taskId, { taskAgentSessionId: 'replacement' });
  expect(await operation.execute({ taskId }, { source: 'mcp', sessionId })).toMatchObject({
    accepted: false,
  });
  expect(outcomeCount()).toBe(0);
});
test('missing task rejects and schema does not accept caller-owned execution identity', async () => {
  expect(await operation.execute({ taskId: 'missing' }, { source: 'rpc' })).toMatchObject({
    accepted: false,
    reason: 'direct_review_submission_unavailable',
  });
  expect(operation.inputSchema.safeParse({ taskId, attemptId, sessionId }).success).toBe(false);
  expect(outcomeCount()).toBe(0);
});
test('enqueue failure rolls back stop request and later submission can succeed', async () => {
  db.exec(
    "CREATE TRIGGER fail_outcome BEFORE INSERT ON job_queue WHEN NEW.queue='direct_task_outcome' BEGIN SELECT RAISE(ABORT,'queue failed'); END"
  );
  await expect(operation.execute({ taskId }, { source: 'rpc' })).rejects.toThrow('queue failed');
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
  expect(outcomeCount()).toBe(0);
  db.exec('DROP TRIGGER fail_outcome');
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toMatchObject({ accepted: true });
});

test('completed frozen submission acknowledges again without granting execution authority', async () => {
  const accepted = (await operation.execute(
    { taskId, reason: 'Ready' },
    { source: 'mcp', sessionId }
  )) as { accepted: true; jobId: string };
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
  expect(tasks.getTask(taskId)?.status).toBe('review');
  db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(sessionId);
  expect(
    await operation.execute({ taskId, reason: 'Ready' }, { source: 'mcp', sessionId })
  ).toEqual(accepted);
  expect(
    await operation.execute({ taskId, reason: 'Changed' }, { source: 'mcp', sessionId })
  ).toMatchObject({ accepted: false });
  expect(outcomeCount()).toBe(1);
});

function markTaskWorkflowOwned() {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Workflow' });
  const run = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
  tasks.updateTask(taskId, { workflowRunId: run.id, taskAgentSessionId: null });
  return run.id;
}

test('workflow-owned task via RPC caller completes synchronously with the reason persisted', async () => {
  const runId = markTaskWorkflowOwned();
  expect(await operation.execute({ taskId, reason: 'Ready' }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(taskId)).toMatchObject({
    status: 'review',
    workflowRunId: runId,
    pendingCompletionReason: 'Ready',
  });
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  expect(outcomeCount()).toBe(0);
});

test('workflow-owned task via MCP caller in the owning Space is admitted', async () => {
  markTaskWorkflowOwned();
  const worker = sessions.getSession(sessionId)!;
  sessions.createSession(
    {
      ...worker,
      id: 'caller-in-space',
      type: 'general',
      context: { spaceId: worker.context!.spaceId },
    },
    { enforceWorkspaceOwnership: false }
  );
  expect(
    await operation.execute({ taskId }, { source: 'mcp', sessionId: 'caller-in-space' })
  ).toEqual({ accepted: true, jobId: null });
});

test('workflow-owned task via MCP caller outside the Space is denied', async () => {
  markTaskWorkflowOwned();
  const worker = sessions.getSession(sessionId)!;
  sessions.createSession(
    { ...worker, id: 'caller-outside-space', type: 'general', context: { spaceId: 'other-space' } },
    { enforceWorkspaceOwnership: false }
  );
  expect(
    await operation.execute({ taskId }, { source: 'mcp', sessionId: 'caller-outside-space' })
  ).toMatchObject({ accepted: false, reason: 'review_submission_denied' });
  expect(tasks.getTask(taskId)?.status).not.toBe('review');
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

test('workflow-owned task with an invalid transition is rejected without throwing', async () => {
  markTaskWorkflowOwned();
  tasks.updateTask(taskId, { status: 'done' });
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toEqual({
    accepted: false,
    reason: 'review_submission_invalid_transition',
  });
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

function createPlainTask(status: 'open' | 'in_progress') {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  return tasks.createTask({ spaceId, title: 'Plain', description: '', status }).id;
}

test('rpc caller submits a plain in_progress Space task through the manager path', async () => {
  const plainId = createPlainTask('in_progress');
  expect(await operation.execute({ taskId: plainId, reason: 'Ready' }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(plainId)?.status).toBe('review');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
});

test('rpc caller submits a plain open Space task through the manager path', async () => {
  const plainId = createPlainTask('open');
  expect(await operation.execute({ taskId: plainId }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(plainId)?.status).toBe('review');
});

test('archived plain Space task is rejected as unavailable', async () => {
  const plainId = createPlainTask('in_progress');
  tasks.updateTask(plainId, { archivedAt: Date.now() });
  expect(await operation.execute({ taskId: plainId }, { source: 'rpc' })).toEqual({
    accepted: false,
    reason: 'review_submission_unavailable',
  });
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

test('MCP caller outside the Space is denied on a plain Space task without writing', async () => {
  const plainId = createPlainTask('in_progress');
  const worker = sessions.getSession(sessionId)!;
  sessions.createSession(
    {
      ...worker,
      id: 'plain-caller-outside-space',
      type: 'lobby',
      context: { spaceId: 'other-space' },
    },
    { enforceWorkspaceOwnership: false }
  );
  expect(
    await operation.execute(
      { taskId: plainId },
      { source: 'mcp', sessionId: 'plain-caller-outside-space' }
    )
  ).toMatchObject({ accepted: false, reason: 'review_submission_denied' });
  expect(tasks.getTask(plainId)?.status).toBe('in_progress');
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

test('a manually reopened task with a stopped direct attempt submits through the manager path', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='stopped' WHERE id=?").run(attemptId);
  expect(await operation.execute({ taskId, reason: 'Ready again' }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(tasks.getTask(taskId)?.status).toBe('review');
  expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  expect(outcomeCount()).toBe(0);
});

test('an immediate retry after that reopened submission stays on the manager path', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='stopped' WHERE id=?").run(attemptId);
  await operation.execute({ taskId, reason: 'Ready again' }, { source: 'rpc' });
  expect(tasks.getTask(taskId)?.status).toBe('review');
  expect(await operation.execute({ taskId, reason: 'Ready again' }, { source: 'rpc' })).toEqual({
    accepted: true,
    jobId: null,
  });
  expect(outcomeCount()).toBe(0);
});

test('a plain task racing a concurrent direct claim is rejected instead of writing through the manager', async () => {
  const plainId = createPlainTask('open');
  attempts.select(plainId);
  expect(attempts.claim(plainId, 'direct-reserved', 'reserved-session')).not.toBeNull();
  expect(
    await operation.execute({ taskId: plainId, reason: 'too soon' }, { source: 'rpc' })
  ).toMatchObject({ accepted: false, reason: 'review_submission_unavailable' });
  expect(tasks.getTask(plainId)?.status).toBe('open');
});

test('a non-domain manager throw propagates instead of becoming a domain rejection', async () => {
  markTaskWorkflowOwned();
  const broken = createSubmitTaskForReviewOperation(() => db, jobs, {
    getTaskManager: () =>
      ({
        submitTaskForReview: async () => {
          throw new Error('boom');
        },
      }) as Pick<SpaceTaskManager, 'updateTask' | 'submitTaskForReview'>,
    emitTaskUpdated,
  });
  await expect(broken.execute({ taskId }, { source: 'rpc' })).rejects.toThrow('boom');
  expect(emitTaskUpdated).not.toHaveBeenCalled();
});

test('configured shared catalog discovers lazily and both transports persist the same request', async () => {
  const getDatabase = mock(() => db);
  const database = { getDatabase, notifyChange: () => {} } as unknown as AppDatabase;
  const provider = createSpaceOperationRegistryProvider(database, jobs, {
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
  });
  const rpc = createOperationRpcHandler(provider, () => ({}));
  const mcp = createOperationMcpHandler(provider, () => ({ sessionId }));
  const context = {} as CallContext;
  const invocation = { name: 'task.submitForReview', input: { taskId, reason: 'Ready' } };
  expect(provider()).toBe(provider());
  expect(
    await rpc({ name: 'operations.describe', input: { name: invocation.name } }, context)
  ).toMatchObject({ found: true, name: invocation.name });
  expect(getDatabase).not.toHaveBeenCalled();
  expect(createDatabaseOperationCatalog(database, jobs).get(invocation.name)).toBeUndefined();
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
