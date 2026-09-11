import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createSubmitTaskForReviewOperation } from '../../../../src/lib/space/operations/submit-for-review';
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
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import { createCancelTaskOperation } from '../../../../src/lib/space/operations/cancel-task';
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
let operation: ReturnType<typeof createCancelTaskOperation>;
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
  operation = createCancelTaskOperation(() => db, jobs, {});
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
    const result = await registry.get('task.cancel')!.execute({ taskId }, { source, sessionId });
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
    ).toMatchObject({ accepted: false });
    expect(outcomeCount()).toBe(0);
    expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
  }
);
test('a frozen review request cannot be replaced with cancellation', async () => {
  const review = createSubmitTaskForReviewOperation(() => db, jobs);
  expect(await review.execute({ taskId }, { source: 'rpc' })).toMatchObject({ accepted: true });
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
  expect(operation.inputSchema.safeParse({ taskId, attemptId, sessionId }).success).toBe(false);
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

test('completed frozen cancellation acknowledges again without granting execution authority', async () => {
  const accepted = (await operation.execute({ taskId }, { source: 'mcp', sessionId })) as {
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
  expect(await operation.execute({ taskId }, { source: 'mcp', sessionId })).toEqual(accepted);
  expect(outcomeCount()).toBe(1);
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
    blockExecution: async () => {
      throw new Error('unexpected workflow cleanup');
    },
  });
  const rpc = createOperationRpcHandler(provider, () => ({}));
  const mcp = createOperationMcpHandler(provider, () => ({ sessionId }));
  const context = {} as CallContext;
  const invocation = { name: 'task.cancel', input: { taskId } };
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

test.each(['space_chat', 'general', 'space_task_agent'] as const)(
  'active persisted %s caller in the owning Space can cancel',
  async (type) => {
    const worker = sessions.getSession(sessionId)!;
    const callerId =
      type === 'space_chat' ? `space:chat:${worker.context!.spaceId}` : `caller-${type}`;
    sessions.createSession(
      { ...worker, id: callerId, type, context: { spaceId: worker.context!.spaceId } },
      { enforceWorkspaceOwnership: false }
    );
    expect(
      await operation.execute({ taskId }, { source: 'mcp', sessionId: callerId })
    ).toMatchObject({ accepted: true });
    expect(outcomeCount()).toBe(1);
  }
);

test('reserved attempts reject without freezing an outcome', async () => {
  db.prepare("UPDATE direct_task_execution_attempts SET phase='reserved' WHERE id=?").run(
    attemptId
  );
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toMatchObject({ accepted: false });
  expect(outcomeCount()).toBe(0);
  expect(attempts.isStopRequested(attemptId, sessionId)).toBe(false);
});

test('workflow-backed tasks keep their existing cancellation route', async () => {
  const spaceId = tasks.getTask(taskId)!.spaceId!;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId, name: 'Workflow' });
  const run = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Run',
  });
  tasks.updateTask(taskId, { workflowRunId: run.id });
  expect(await operation.execute({ taskId }, { source: 'rpc' })).toMatchObject({ accepted: false });
  expect(tasks.getTask(taskId)?.workflowRunId).toBe(run.id);
  expect(outcomeCount()).toBe(0);
});
