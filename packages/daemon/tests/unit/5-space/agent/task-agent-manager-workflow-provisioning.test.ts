import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const TASK_ID = 'task-1';
const SESSION_ID = `space:space-1:task:${TASK_ID}:post-approval:worker`;
const EXEC_SESSION_ID = `space:space-1:task:${TASK_ID}:exec:e1`;

function makeManager(input: {
  taskStatus?: string;
  runStatus?: string;
  runMissing?: boolean;
  spaceStopped?: boolean;
  spacePaused?: boolean;
  spaceArchived?: boolean;
  cooldown?: boolean;
  spaceError?: Error;
  postApprovalSessionId?: string | null;
  restoreResult?: string | null;
  routingPointerTaskId?: string;
}) {
  const restorePostApprovalWorkerSession = mock(async () => input.restoreResult ?? null);
  const restored = {
    marker: 'restored',
    getSessionData: () => ({ status: 'active' }),
  } as unknown as AgentSession;
  const rehydrateSubSession = mock(async () => restored);
  const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
  const cachedSessions = new Map<string, AgentSession>();
  const registerSession = mock((session: AgentSession, expectedCurrent?: AgentSession) => {
    const sessionId = session.getSessionData().id;
    if (expectedCurrent && cachedSessions.get(sessionId) !== expectedCurrent) return false;
    cachedSessions.set(sessionId, session);
    return true;
  });
  Object.defineProperty(manager, 'config', {
    value: {
      taskRepo: {
        getTask: () => ({
          id: TASK_ID,
          spaceId: 'space-1',
          workflowRunId: 'run-1',
          status: input.taskStatus ?? 'in_progress',
          postApprovalSessionId: input.postApprovalSessionId ?? null,
        }),
      },
      workflowRunRepo: {
        getRun: () =>
          input.runMissing ? null : { id: 'run-1', status: input.runStatus ?? 'in_progress' },
      },
      spaceManager: {
        getSpace: async () => {
          if (input.spaceError) throw input.spaceError;
          return {
            id: 'space-1',
            stopped: input.spaceStopped ?? false,
            paused: input.spacePaused ?? false,
            status: input.spaceArchived ? 'archived' : 'active',
          };
        },
        getSpaceSync: () => ({
          id: 'space-1',
          stopped: input.spaceStopped ?? false,
          paused: input.spacePaused ?? false,
          status: input.spaceArchived ? 'archived' : 'active',
        }),
      },
      sessionManager: {
        getCachedSession: (sessionId: string) => cachedSessions.get(sessionId) ?? null,
        registerSession,
      },
      ...(input.routingPointerTaskId
        ? {
            db: {
              getDatabase: () => ({
                prepare: () => ({ get: () => ({ id: input.routingPointerTaskId }) }),
              }),
            },
          }
        : {}),
    },
  });
  Object.defineProperty(manager, 'restorePostApprovalWorkerSession', {
    value: restorePostApprovalWorkerSession,
    configurable: true,
  });
  Object.defineProperty(manager, 'rehydrateSubSession', {
    value: rehydrateSubSession,
    configurable: true,
  });
  Object.defineProperty(manager, 'agentSessionIndex', { value: new Map(), configurable: true });
  Object.defineProperty(manager, 'sessionOwnershipGenerations', {
    value: new Map(),
    configurable: true,
  });
  Object.defineProperty(manager, 'getSubSession', { value: () => restored, configurable: true });
  if (input.cooldown) {
    Object.defineProperty(manager, 'readPersistedRateLimitCooldown', {
      value: () => ({ retryAt: Date.now() + 60_000 }),
    });
  }
  return {
    manager,
    restorePostApprovalWorkerSession,
    rehydrateSubSession,
    cachedSessions,
    registerSession,
  };
}

function workflowSession(): AgentSession {
  return { getSessionData: () => ({ id: SESSION_ID }) } as unknown as AgentSession;
}

describe('TaskAgentManager workflow session provisioning', () => {
  it('does not revive a post-approval worker for a stopped space', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({ spaceStopped: true });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('does not revive a post-approval worker for a completed task', async () => {
    const completedTask = makeManager({ taskStatus: 'done' });

    await completedTask.manager.provisionWorkflowSession(workflowSession());

    expect(completedTask.restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('restores an approved post-approval worker after workflow completion', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      taskStatus: 'approved',
      runStatus: 'done',
    });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_ID,
      expect.anything(),
      {}
    );
  });

  it('restores an execution-shaped recorded post-approval worker after workflow completion', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      taskStatus: 'approved',
      runStatus: 'done',
      postApprovalSessionId: EXEC_SESSION_ID,
    });

    await manager.provisionWorkflowSession(executionWorkerSession());

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(
      TASK_ID,
      EXEC_SESSION_ID,
      expect.anything(),
      {}
    );
  });

  it('forwards startQuery:false to the post-approval restore', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      taskStatus: 'approved',
      runStatus: 'done',
    });

    await manager.provisionWorkflowSession(workflowSession(), { startQuery: false });

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_ID,
      expect.anything(),
      { startQuery: false }
    );
  });

  it('does not revive a post-approval worker for a paused space', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({ spacePaused: true });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('does not revive a post-approval worker for an archived space', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({ spaceArchived: true });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
  });

  it('provisions a cooling-down post-approval worker without starting its query', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      cooldown: true,
      taskStatus: 'approved',
    });

    await manager.provisionWorkflowSession(workflowSession());

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_ID,
      expect.anything(),
      { startQuery: false }
    );
  });

  it('provisions a cooling-down post-approval worker for a non-starting retry lookup', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      cooldown: true,
      taskStatus: 'approved',
    });

    await manager.provisionWorkflowSession(workflowSession(), { startQuery: false });

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_ID,
      expect.anything(),
      { startQuery: false }
    );
  });

  it('rejects the lookup when workflow provisioning fails', async () => {
    const { manager } = makeManager({ spaceError: new Error('space lookup failed') });

    await expect(manager.provisionWorkflowSession(workflowSession())).rejects.toThrow(
      'space lookup failed'
    );
  });

  it('rehydrates a cooling-down execution worker without starting its query', async () => {
    const { manager } = makeManager({ cooldown: true, taskStatus: 'in_progress' });
    const rehydrateSubSession = mock(async () => null);
    Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
      value: () => ({ workflowRunId: 'run-1', status: 'in_progress' }),
    });
    Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
      value: () => false,
    });
    Object.defineProperty(manager, 'rehydrateSubSession', {
      value: rehydrateSubSession,
    });

    await manager.provisionWorkflowSession(executionWorkerSession());

    expect(rehydrateSubSession).toHaveBeenCalledWith(
      'space:space-1:task:task-1:exec:e1',
      expect.anything(),
      { startQuery: false }
    );
  });

  it('rehydrates an execution worker with the original options outside cooldowns', async () => {
    const { manager } = makeManager({ taskStatus: 'in_progress' });
    const rehydrateSubSession = mock(async () => null);
    Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
      value: () => ({ workflowRunId: 'run-1', status: 'in_progress' }),
    });
    Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
      value: () => false,
    });
    Object.defineProperty(manager, 'rehydrateSubSession', {
      value: rehydrateSubSession,
    });

    await manager.provisionWorkflowSession(executionWorkerSession());

    expect(rehydrateSubSession).toHaveBeenCalledWith(
      'space:space-1:task:task-1:exec:e1',
      expect.anything(),
      {}
    );
  });

  it('adopts a reset replacement for a live idle execution', async () => {
    const { manager, rehydrateSubSession, cachedSessions } = makeManager({
      taskStatus: 'in_progress',
    });
    const replacement = executionWorkerSession();
    const displaced = {
      getSessionData: () => ({ id: EXEC_SESSION_ID, status: 'active' }),
      getProcessingState: () => ({ status: 'idle' }),
    } as unknown as AgentSession;
    cachedSessions.set(EXEC_SESSION_ID, replacement);
    Object.defineProperty(manager, 'agentSessionIndex', {
      value: new Map([[EXEC_SESSION_ID, displaced]]),
    });
    Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
      value: () => ({ workflowRunId: 'run-1', status: 'idle' }),
    });
    Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
      value: () => false,
    });

    const outcome = await manager.provisionWorkflowSession(replacement, {
      startQuery: true,
      intent: 'reset-replacement',
    });

    expect(rehydrateSubSession).toHaveBeenCalledWith(EXEC_SESSION_ID, replacement, {
      startQuery: false,
      replayPendingMessages: false,
      resetReplacement: {
        expectedCachedSession: replacement,
        ownershipGeneration: 0,
      },
    });
    expect(outcome).toBe('adopted-dormant');
  });

  it('keeps ordinary idle workflow lookups dormant', async () => {
    for (const indexed of [undefined, executionWorkerSession()]) {
      const { manager, rehydrateSubSession } = makeManager({ taskStatus: 'in_progress' });
      const session = indexed ?? executionWorkerSession();
      Object.defineProperty(manager, 'agentSessionIndex', {
        value: new Map(indexed ? [[EXEC_SESSION_ID, indexed]] : []),
      });
      Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
        value: () => ({ workflowRunId: 'run-1', status: 'idle' }),
      });
      Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
        value: () => false,
      });

      await manager.provisionWorkflowSession(session, { startQuery: false });

      expect(rehydrateSubSession).not.toHaveBeenCalled();
    }
  });

  it('does not adopt reset replacements after their owner becomes ineligible', async () => {
    for (const input of [
      { taskStatus: 'done' },
      { runStatus: 'done' },
      { runStatus: 'cancelled' },
      { spacePaused: true },
      { spaceStopped: true },
      { spaceArchived: true },
    ]) {
      const { manager, rehydrateSubSession, registerSession } = makeManager(input);
      const replacement = executionWorkerSession();
      const displaced = {
        getSessionData: () => ({ id: EXEC_SESSION_ID, status: 'active' }),
        getProcessingState: () => ({ status: 'idle' }),
      } as unknown as AgentSession;
      const index = new Map([[EXEC_SESSION_ID, displaced]]);
      Object.defineProperty(manager, 'agentSessionIndex', { value: index });
      Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
        value: () => ({ workflowRunId: 'run-1', status: 'idle' }),
      });
      Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
        value: () => false,
      });

      const outcome = await manager.provisionWorkflowSession(replacement, {
        startQuery: true,
        intent: 'reset-replacement',
      });

      expect(rehydrateSubSession).not.toHaveBeenCalled();
      expect(registerSession).not.toHaveBeenCalled();
      expect(index.get(EXEC_SESSION_ID)).toBe(displaced);
      expect(outcome).toBe('skipped');
    }
  });

  it('keeps owner-ineligible ordinary lookups dormant', async () => {
    const { manager, rehydrateSubSession } = makeManager({ taskStatus: 'done' });
    const session = executionWorkerSession();

    const outcome = await manager.provisionWorkflowSession(session, { startQuery: false });

    expect(rehydrateSubSession).not.toHaveBeenCalled();
    expect(outcome).toBe('skipped');
  });

  it('provisions a waiting-rebind reset replacement without starting it', async () => {
    const { manager, rehydrateSubSession, cachedSessions } = makeManager({
      taskStatus: 'in_progress',
    });
    const replacement = executionWorkerSession();
    const displaced = {
      getSessionData: () => ({ id: EXEC_SESSION_ID, status: 'active' }),
      getProcessingState: () => ({ status: 'idle' }),
    } as unknown as AgentSession;
    cachedSessions.set(EXEC_SESSION_ID, replacement);
    Object.defineProperty(manager, 'agentSessionIndex', {
      value: new Map([[EXEC_SESSION_ID, displaced]]),
    });
    Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
      value: () => ({ workflowRunId: 'run-1', status: 'waiting_rebind' }),
    });

    const outcome = await manager.provisionWorkflowSession(replacement, {
      startQuery: true,
      intent: 'reset-replacement',
    });

    expect(rehydrateSubSession).toHaveBeenCalledWith(EXEC_SESSION_ID, replacement, {
      startQuery: false,
      replayPendingMessages: false,
      resetReplacement: {
        expectedCachedSession: replacement,
        ownershipGeneration: 0,
      },
    });
    expect(outcome).toBe('adopted-dormant');
  });

  it('keeps ordinary waiting-rebind lookups dormant', async () => {
    const { manager, rehydrateSubSession } = makeManager({ taskStatus: 'in_progress' });
    const session = executionWorkerSession();
    Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
      value: () => ({ workflowRunId: 'run-1', status: 'waiting_rebind' }),
    });
    Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
      value: () => false,
    });

    const outcome = await manager.provisionWorkflowSession(session, { startQuery: false });

    expect(rehydrateSubSession).not.toHaveBeenCalled();
    expect(outcome).toBe('skipped');
  });
});

describe('TaskAgentManager rehydrateSubSessionById post-approval routing and admission', () => {
  it('routes recorded targets through the dedicated restore; unrecorded ids fall back', async () => {
    for (const [target, recorded] of [
      [SESSION_ID, true],
      [EXEC_SESSION_ID, true],
      ['legacy-worker', true],
      [`space:space-1:task:${TASK_ID}:exec:unrecorded`, false],
    ] as Array<[string, boolean]>) {
      const { manager, restorePostApprovalWorkerSession, rehydrateSubSession } = makeManager({
        taskStatus: 'approved',
        postApprovalSessionId: recorded ? target : null,
        routingPointerTaskId: target === 'legacy-worker' ? TASK_ID : undefined,
        restoreResult: target,
      });

      await manager.rehydrateSubSessionById(target);

      expect(restorePostApprovalWorkerSession).toHaveBeenCalledTimes(recorded ? 1 : 0);
      expect(rehydrateSubSession).toHaveBeenCalledTimes(recorded ? 0 : 1);
      if (recorded) {
        expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(TASK_ID, target, undefined, {
          startQuery: false,
        });
      } else {
        expect(rehydrateSubSession).toHaveBeenCalledWith(target, undefined, {
          startQuery: false,
        });
      }
    }
  });

  it('rehydrates an execution target without starting a query before delivery', async () => {
    const { manager, rehydrateSubSession } = makeManager({ taskStatus: 'in_progress' });

    await manager.rehydrateSubSessionById(EXEC_SESSION_ID);

    expect(rehydrateSubSession).toHaveBeenCalledWith(EXEC_SESSION_ID, undefined, {
      startQuery: false,
    });
  });

  it('rejects restores for terminal tasks or inactive spaces', async () => {
    for (const input of [
      { taskStatus: 'stopped' },
      { taskStatus: 'cancelled' },
      { taskStatus: 'archived' },
      { taskStatus: 'approved', spacePaused: true },
      { taskStatus: 'approved', spaceStopped: true },
      { taskStatus: 'approved', spaceArchived: true },
    ]) {
      const { manager, restorePostApprovalWorkerSession } = makeManager({
        ...input,
        postApprovalSessionId: SESSION_ID,
        restoreResult: SESSION_ID,
      });

      await expect(manager.rehydrateSubSessionById(SESSION_ID)).resolves.toBeNull();
      expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
    }
  });

  it('rejects restores for a missing or cancelled workflow run', async () => {
    for (const input of [{ runMissing: true }, { runStatus: 'cancelled' }]) {
      const { manager, restorePostApprovalWorkerSession } = makeManager({
        ...input,
        taskStatus: 'approved',
        postApprovalSessionId: SESSION_ID,
        restoreResult: SESSION_ID,
      });

      await expect(manager.rehydrateSubSessionById(SESSION_ID)).resolves.toBeNull();
      expect(restorePostApprovalWorkerSession).not.toHaveBeenCalled();
    }
  });

  it('restores a resolved post-approval target without starting an empty query', async () => {
    const { manager, restorePostApprovalWorkerSession } = makeManager({
      taskStatus: 'approved',
      postApprovalSessionId: SESSION_ID,
      restoreResult: SESSION_ID,
    });

    await manager.rehydrateSubSessionById(SESSION_ID);

    expect(restorePostApprovalWorkerSession).toHaveBeenCalledWith(TASK_ID, SESSION_ID, undefined, {
      startQuery: false,
    });
  });

  it('returns null when the restore finds no worker or the restored session is dead', async () => {
    for (const scenario of [
      { restoreResult: null as string | null, deadStatus: null as string | null },
      { restoreResult: SESSION_ID, deadStatus: 'ended' },
      { restoreResult: SESSION_ID, deadStatus: 'archived' },
    ]) {
      const { manager, restorePostApprovalWorkerSession } = makeManager({
        taskStatus: 'approved',
        postApprovalSessionId: SESSION_ID,
        restoreResult: scenario.restoreResult,
      });
      if (scenario.deadStatus !== null) {
        Object.defineProperty(manager, 'getSubSession', {
          value: () =>
            ({
              getSessionData: () => ({ status: scenario.deadStatus }),
            }) as unknown as AgentSession,
          configurable: true,
        });
      }

      await expect(manager.rehydrateSubSessionById(SESSION_ID)).resolves.toBeNull();
      expect(restorePostApprovalWorkerSession).toHaveBeenCalledTimes(1);
    }
  });
});

describe('TaskAgentManager on-demand worker resume', () => {
  it('attaches the prior execution session without starting an empty query', async () => {
    const rehydrateSubSession = mock(async () => null);
    const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
    Object.defineProperty(manager, 'config', {
      value: {
        nodeExecutionRepo: {
          listByWorkflowRun: () => [
            {
              agentName: 'coder',
              agentSessionId: EXEC_SESSION_ID,
              workflowNodeId: 'node-1',
            },
          ],
        },
      },
    });
    Object.defineProperty(manager, 'agentSessionIndex', { value: new Map() });
    Object.defineProperty(manager, 'rehydrateSubSession', { value: rehydrateSubSession });

    await manager.tryResumeNodeAgentSession('run-1', 'coder', 'node-1');

    expect(rehydrateSubSession).toHaveBeenCalledWith(EXEC_SESSION_ID, undefined, {
      startQuery: false,
    });
  });

  it('injects the prompt only after a dormant ghost session is attached', async () => {
    const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
    const restored = {} as AgentSession;
    const agentSessionIndex = new Map<string, AgentSession>();
    const rehydrateSubSession = mock(async (sessionId: string) => {
      agentSessionIndex.set(sessionId, restored);
      return restored;
    });
    const injectMessageIntoSession = mock(async () => 'message-1');
    Object.defineProperty(manager, 'agentSessionIndex', { value: agentSessionIndex });
    Object.defineProperty(manager, 'subSessions', { value: new Map() });
    Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', { value: () => null });
    Object.defineProperty(manager, 'rehydrateSubSession', { value: rehydrateSubSession });
    Object.defineProperty(manager, 'injectMessageIntoSession', { value: injectMessageIntoSession });

    await expect(manager.injectSubSessionMessage(EXEC_SESSION_ID, 'hello')).resolves.toBe(
      'message-1'
    );

    expect(rehydrateSubSession).toHaveBeenCalledWith(EXEC_SESSION_ID, undefined, {
      startQuery: false,
    });
    expect(injectMessageIntoSession).toHaveBeenCalledWith(
      restored,
      'hello',
      'immediate',
      undefined,
      true,
      undefined,
      'task',
      undefined
    );
  });
});

function executionWorkerSession(): AgentSession {
  return {
    getSessionData: () => ({ id: EXEC_SESSION_ID }),
  } as unknown as AgentSession;
}

function makeIndexedRehydrateManager(input: { taskStatus: string }) {
  const startStreamingQuery = mock(async () => {});
  const replay = mock(async () => true);
  const sessionId = 'space:space-1:task:task-1:exec:e2';
  const session = {
    getSessionData: () => ({ id: sessionId, config: {}, status: 'active' }),
    isQueryActiveOrStarting: () => false,
    startStreamingQuery,
    replayPendingMessagesForImmediateMode: replay,
  } as unknown as AgentSession;
  const task = {
    id: 'task-1',
    spaceId: 'space-1',
    workflowRunId: 'run-1',
    status: input.taskStatus,
  };
  let releaseLock: () => void = () => {};
  const lockGate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
  Object.defineProperty(manager, 'config', {
    value: {
      taskRepo: { getTask: () => task },
      workflowRunRepo: { getRun: () => ({ id: 'run-1', status: 'in_progress' }) },
      spaceManager: {
        getSpace: async () => ({ id: 'space-1', stopped: false, paused: false, status: 'active' }),
      },
      sessionManager: {},
    },
  });
  Object.defineProperty(manager, 'withSessionRestoreLock', {
    value: (_sessionId: string, run: () => Promise<unknown>) => lockGate.then(() => run()),
  });
  Object.defineProperty(manager, 'agentSessionIndex', {
    value: new Map([[sessionId, session]]),
  });
  Object.defineProperty(manager, 'rehydrateInFlight', { value: new Map() });
  Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
    value: () => ({ workflowRunId: 'run-1', status: 'in_progress' }),
  });
  Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
    value: () => false,
  });
  return { manager, session, sessionId, startStreamingQuery, replay, releaseLock, task };
}

function makeRestoreManager(input: {
  queryMode?: string;
  cleanupState?: string;
  taskStatus?: string;
  runStatus?: string;
  spacePaused?: boolean;
  sessionId?: string;
  executionStatus?: string | null;
  archiveDuringAdmission?: boolean;
  endedStatus?: boolean;
  spaceError?: Error;
}) {
  const startStreamingQuery = mock(async () => {});
  const replay = mock(async () => true);
  let getSpaceCalls = 0;
  const sessionId = input.sessionId ?? SESSION_ID;
  const data: { id: string; status: string; config: { queryMode?: string } } = {
    id: sessionId,
    status: input.endedStatus ? 'ended' : 'active',
    config: { queryMode: input.queryMode },
  };
  const session = {
    getSessionData: () => data,
    isQueryActiveOrStarting: () => false,
    startStreamingQuery,
    replayPendingMessagesForImmediateMode: replay,
  } as unknown as AgentSession;
  const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
  Object.defineProperty(manager, 'config', {
    value: {
      taskRepo: {
        getTask: () => ({
          id: TASK_ID,
          spaceId: 'space-1',
          workflowRunId: 'run-1',
          status: input.taskStatus ?? 'approved',
        }),
      },
      workflowRunRepo: {
        getRun: () => ({ id: 'run-1', status: input.runStatus ?? 'in_progress' }),
      },
      spaceManager: {
        getSpace: async () => {
          getSpaceCalls += 1;
          if (input.spaceError) throw input.spaceError;
          if (input.archiveDuringAdmission) data.status = 'archived';
          return {
            id: 'space-1',
            stopped: false,
            paused: input.spacePaused ?? false,
            status: 'active',
          };
        },
      },
      sessionManager: {
        cleanupState: input.cleanupState,
        getCachedSession: () => session,
        getCleanupState(): string | undefined {
          return this.cleanupState;
        },
      },
    },
  });
  Object.defineProperty(manager, 'resolveNodeExecutionForSubSession', {
    value: () =>
      input.executionStatus === null
        ? null
        : { workflowRunId: 'run-1', status: input.executionStatus ?? 'in_progress' },
  });
  Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
    value: () => false,
  });
  Object.defineProperty(manager, 'readPostApprovalWorkerIdentity', {
    value: () => ({ sessionId, agentName: 'worker' }),
  });
  Object.defineProperty(manager, 'withSessionRestoreLock', {
    value: (_sessionId: string, run: () => Promise<string | null>) => run(),
  });
  Object.defineProperty(manager, 'agentSessionIndex', {
    value: new Map([[sessionId, session]]),
  });
  return { manager, startStreamingQuery, replay, getSpaceCalls: () => getSpaceCalls };
}

describe('TaskAgentManager restored worker query admission', () => {
  it('starts the query and replays pending messages for an admitted worker', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({});

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('keeps a manual-mode worker dormant while still settling replay provisioning', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      queryMode: 'manual',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('skips query startup and replay while the session manager is cleaning up', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      cleanupState: 'cleaning',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('skips query startup when the space pauses during restoration', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      spacePaused: true,
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('skips query startup when the task leaves approved during restoration', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      taskStatus: 'cancelled',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('skips query startup when the session archives during admission', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      archiveDuringAdmission: true,
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('skips query startup for a session persisted as ended', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      endedStatus: true,
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('starts an approved post-approval worker after workflow completion', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      runStatus: 'done',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID);

    expect(startStreamingQuery).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
  });
});

describe('TaskAgentManager restored worker admission short-circuits', () => {
  it('never awaits the space lookup when an early gate denies every admission', async () => {
    const denyCases = [
      { cleanupState: 'cleaning' },
      { taskStatus: 'cancelled' },
      { taskStatus: 'archived' },
    ];
    for (const denyCase of denyCases) {
      const { manager, startStreamingQuery, replay, getSpaceCalls } = makeRestoreManager({
        ...denyCase,
        spaceError: new Error('space lookup failed'),
      });

      await expect(manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID)).resolves.toBe(
        SESSION_ID
      );

      expect(getSpaceCalls()).toBe(0);
      expect(startStreamingQuery).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
    }
  });

  it('rejects when the space lookup fails after the early gates pass', async () => {
    const { manager } = makeRestoreManager({ spaceError: new Error('space lookup failed') });

    await expect(manager.restorePostApprovalWorkerSession(TASK_ID, SESSION_ID)).rejects.toThrow(
      'space lookup failed'
    );
  });
});

describe('TaskAgentManager ordinary worker startup revalidation', () => {
  const WORKER_SESSION_ID = 'space:space-1:task:task-1:exec:e9';

  it('starts an ordinary worker whose execution is still resumable', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      sessionId: WORKER_SESSION_ID,
      taskStatus: 'in_progress',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, WORKER_SESSION_ID);

    expect(startStreamingQuery).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('does not start an ordinary worker whose task finished', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      sessionId: WORKER_SESSION_ID,
      taskStatus: 'done',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, WORKER_SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not start an ordinary worker whose run completed', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      sessionId: WORKER_SESSION_ID,
      taskStatus: 'in_progress',
      runStatus: 'done',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, WORKER_SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not start an ordinary worker whose execution is no longer resumable', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      sessionId: WORKER_SESSION_ID,
      taskStatus: 'in_progress',
      executionStatus: 'completed',
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, WORKER_SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not start an ordinary worker whose execution cannot be resolved', async () => {
    const { manager, startStreamingQuery, replay } = makeRestoreManager({
      sessionId: WORKER_SESSION_ID,
      taskStatus: 'in_progress',
      executionStatus: null,
    });

    await manager.restorePostApprovalWorkerSession(TASK_ID, WORKER_SESSION_ID);

    expect(startStreamingQuery).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });
});

function makeCooldownManager(input: {
  watchdogRetryAt?: number | null;
  watchdogPersisted?: boolean;
}) {
  const session = {
    getRateLimitWatchdogState: () => ({
      retryAt: input.watchdogRetryAt ?? null,
      persistedCooldown: input.watchdogPersisted ?? false,
    }),
  } as unknown as AgentSession;
  const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
  Object.defineProperty(manager, 'config', {
    value: { sessionManager: { getCachedSession: () => session } },
  });
  Object.defineProperty(manager, 'readPersistedRateLimitCooldown', {
    value: () => ({ retryAt: 1234 }),
  });
  Object.defineProperty(manager, 'agentSessionIndex', { value: new Map() });
  return manager;
}

describe('TaskAgentManager restored rate-limit cooldown lookup', () => {
  it('returns the persisted retry time when no live watchdog owns the cooldown', () => {
    const manager = makeCooldownManager({});

    expect(manager.getRestoredRateLimitRetryAt(SESSION_ID)).toBe(1234);
  });

  it('returns null while a live watchdog cooldown is armed', () => {
    const manager = makeCooldownManager({ watchdogRetryAt: 5678 });

    expect(manager.getRestoredRateLimitRetryAt(SESSION_ID)).toBeNull();
  });

  it('parks on the persisted retry time when the watchdog arm was restored from storage', () => {
    const manager = makeCooldownManager({ watchdogRetryAt: 5678, watchdogPersisted: true });

    expect(manager.getRestoredRateLimitRetryAt(SESSION_ID)).toBe(1234);
  });
});

describe('TaskAgentManager startup rehydration admission', () => {
  function makeStartupManager(input: {
    activeDelivery?: boolean;
    cooldown?: boolean;
    pendingMessage?: boolean;
    pendingToolContinuation?: boolean;
  }) {
    const rehydrateSubSession = mock(async () => null);
    const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
    Object.defineProperty(manager, 'config', {
      value: {
        taskRepo: { listByWorkflowRun: () => [] },
        nodeExecutionRepo: {
          listByWorkflowRun: () => [
            {
              id: 'exec-1',
              workflowRunId: 'run-1',
              agentSessionId: 'space:space-1:task:task-1:exec:e1',
              status: 'in_progress',
            },
          ],
        },
        toolContinuationRepo: {
          listPendingInboxForSession: () => (input.pendingToolContinuation ? [{}] : []),
        },
      },
    });
    Object.defineProperty(manager, 'agentSessionIndex', { value: new Map() });
    Object.defineProperty(manager, 'hasActiveDeliveryJob', {
      value: () => input.activeDelivery ?? false,
    });
    Object.defineProperty(manager, 'hasUnconsumedDeliveredWork', {
      value: () => input.pendingMessage ?? false,
    });
    Object.defineProperty(manager, 'hasQueuedRetryableHookAction', {
      value: () => false,
    });
    Object.defineProperty(manager, 'rehydrateSubSession', {
      value: rehydrateSubSession,
    });
    if (input.cooldown) {
      Object.defineProperty(manager, 'readPersistedRateLimitCooldown', {
        value: () => ({ retryAt: Date.now() + 60_000 }),
      });
    }
    return { manager, rehydrateSubSession };
  }

  it('rehydrates a cooling-down worker without starting its query at startup', async () => {
    const { manager, rehydrateSubSession } = makeStartupManager({
      cooldown: true,
      pendingMessage: true,
    });
    const run = (
      manager as unknown as {
        rehydrateSubSessionsForRun: (runId: string) => Promise<void>;
      }
    ).rehydrateSubSessionsForRun.bind(manager);

    await run('run-1');

    expect(rehydrateSubSession).toHaveBeenCalledWith(
      'space:space-1:task:task-1:exec:e1',
      undefined,
      { startQuery: false, replayPendingMessages: false }
    );
  });

  it('rehydrates an idle worker without starting its query at startup', async () => {
    const { manager, rehydrateSubSession } = makeStartupManager({});
    const run = (
      manager as unknown as {
        rehydrateSubSessionsForRun: (runId: string) => Promise<void>;
      }
    ).rehydrateSubSessionsForRun.bind(manager);

    await run('run-1');

    expect(rehydrateSubSession).toHaveBeenCalledWith(
      'space:space-1:task:task-1:exec:e1',
      undefined,
      { startQuery: false, replayPendingMessages: false }
    );
  });

  for (const [name, input] of [
    ['pending message', { pendingMessage: true }],
    ['active delivery job', { activeDelivery: true }],
    ['pending tool continuation', { pendingToolContinuation: true }],
  ] as const) {
    it(`starts recovery for a worker with a ${name}`, async () => {
      const { manager, rehydrateSubSession } = makeStartupManager(input);
      const run = (
        manager as unknown as {
          rehydrateSubSessionsForRun: (runId: string) => Promise<void>;
        }
      ).rehydrateSubSessionsForRun.bind(manager);

      await run('run-1');

      expect(rehydrateSubSession).toHaveBeenCalledWith(
        'space:space-1:task:task-1:exec:e1',
        undefined,
        { startQuery: false, replayPendingMessages: true }
      );
    });
  }
});

describe('TaskAgentManager indexed rehydrate revalidation', () => {
  it('starts and replays an admitted indexed worker after acquiring the lock', async () => {
    const fixture = makeIndexedRehydrateManager({ taskStatus: 'in_progress' });
    const rehydrate = (
      fixture.manager as unknown as {
        rehydrateSubSession: (id: string) => Promise<AgentSession | null>;
      }
    ).rehydrateSubSession.bind(fixture.manager);

    const pending = rehydrate(fixture.sessionId);
    fixture.releaseLock();
    const restored = await pending;

    expect(restored).toBe(fixture.session);
    expect(fixture.startStreamingQuery).toHaveBeenCalledTimes(1);
    expect(fixture.replay).toHaveBeenCalledTimes(1);
  });

  it('skips startup and replay when the task finishes while the lock is held', async () => {
    const fixture = makeIndexedRehydrateManager({ taskStatus: 'in_progress' });
    const rehydrate = (
      fixture.manager as unknown as {
        rehydrateSubSession: (id: string) => Promise<AgentSession | null>;
      }
    ).rehydrateSubSession.bind(fixture.manager);

    const pending = rehydrate(fixture.sessionId);
    fixture.task.status = 'done';
    fixture.releaseLock();
    await pending;

    expect(fixture.startStreamingQuery).not.toHaveBeenCalled();
    expect(fixture.replay).not.toHaveBeenCalled();
  });
});
