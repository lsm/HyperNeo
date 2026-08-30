import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const TASK_ID = 'task-1';
const SESSION_ID = `space:space-1:task:${TASK_ID}:post-approval:worker`;

function makeManager(input: {
  taskStatus?: string;
  runStatus?: string;
  spaceStopped?: boolean;
  spacePaused?: boolean;
  spaceArchived?: boolean;
  cooldown?: boolean;
  spaceError?: Error;
}) {
  const restorePostApprovalWorkerSession = mock(async () => null);
  const manager = Object.create(TaskAgentManager.prototype) as TaskAgentManager;
  Object.defineProperty(manager, 'config', {
    value: {
      taskRepo: {
        getTask: () => ({
          id: TASK_ID,
          spaceId: 'space-1',
          workflowRunId: 'run-1',
          status: input.taskStatus ?? 'in_progress',
        }),
      },
      workflowRunRepo: {
        getRun: () => ({ id: 'run-1', status: input.runStatus ?? 'in_progress' }),
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
      },
    },
  });
  Object.defineProperty(manager, 'restorePostApprovalWorkerSession', {
    value: restorePostApprovalWorkerSession,
  });
  if (input.cooldown) {
    Object.defineProperty(manager, 'readPersistedRateLimitCooldown', {
      value: () => ({ retryAt: Date.now() + 60_000 }),
    });
  }
  return { manager, restorePostApprovalWorkerSession };
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
});

function makeRestoreManager(input: {
  queryMode?: string;
  cleanupState?: string;
  taskStatus?: string;
  spacePaused?: boolean;
}) {
  const startStreamingQuery = mock(async () => {});
  const replay = mock(async () => true);
  const session = {
    getSessionData: () => ({ id: SESSION_ID, config: { queryMode: input.queryMode } }),
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
        getRun: () => ({ id: 'run-1', status: 'in_progress' }),
      },
      spaceManager: {
        getSpace: async () => ({
          id: 'space-1',
          stopped: false,
          paused: input.spacePaused ?? false,
          status: 'active',
        }),
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
  Object.defineProperty(manager, 'readPostApprovalWorkerIdentity', {
    value: () => ({ sessionId: SESSION_ID, agentName: 'worker' }),
  });
  Object.defineProperty(manager, 'withSessionRestoreLock', {
    value: (_sessionId: string, run: () => Promise<string | null>) => run(),
  });
  Object.defineProperty(manager, 'agentSessionIndex', {
    value: new Map([[SESSION_ID, session]]),
  });
  return { manager, startStreamingQuery, replay };
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
});

function makeCooldownManager(input: { watchdogRetryAt?: number | null }) {
  const session = {
    getRateLimitWatchdogState: () => ({ retryAt: input.watchdogRetryAt ?? null }),
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
});
