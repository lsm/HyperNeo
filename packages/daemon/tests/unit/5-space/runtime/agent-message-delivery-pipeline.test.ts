import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { SessionTarget } from '../../../../src/lib/session-resolution/target.ts';
import {
  deliverAgentMessageToTarget,
  type AgentMessageDeliveryDeps,
} from '../../../../src/lib/space/runtime/agent-message-delivery-pipeline.ts';
import type { MailboxHandoffArgs } from '../../../../src/lib/space/runtime/prompt-mailbox-handoff.ts';

const WORKER_TARGET: SessionTarget = {
  kind: 'worker',
  taskId: 'task-1',
  agentName: 'reviewer',
  workflowNodeId: 'node-1',
};

function makeSession(opts: { status?: string; sdkSessionId?: string | null } = {}) {
  const clearMock = mock(async () => {});
  const stub = {
    session: { id: 'sess-1', sdkSessionId: opts.sdkSessionId ?? 'sdk-prior' },
    getProcessingState: () => ({ status: opts.status ?? 'idle' }),
    clearConversationContext: clearMock,
    stateManager: { setQueuedIfIdle: mock(async () => true) },
  };
  return { session: stub as unknown as AgentSession, clearMock };
}

function makeDeps(overrides: Partial<AgentMessageDeliveryDeps> = {}) {
  const handoffCalls: MailboxHandoffArgs[] = [];
  const activities: string[] = [];
  const deps: AgentMessageDeliveryDeps = {
    workflowRunId: 'run-1',
    taskRepo: {
      getTask: () => ({ id: 'task-1', workflowRunId: 'run-1', status: 'in_progress' }),
    },
    nodeExecutionRepo: {
      listByWorkflowRun: () => [
        { agentSessionId: 'sess-1', agentName: 'reviewer', workflowNodeId: 'node-1' },
      ],
    },
    resolveTerminalStatus: () => null,
    isPostApprovalWorker: () => false,
    ensureSession: async () => ({ kind: 'resolved' as const, sessionId: 'sess-1', created: false }),
    getSessionAsync: async () => makeSession().session,
    withSessionInjectLock: (_sessionId, fn) => fn(),
    isRateOrUsageLimited: (status) => status === 'rate_limited' || status === 'usage_limited',
    slotResetsContext: () => false,
    hasActiveDeliveryJob: () => false,
    hasUnconsumedDeliveredWork: () => false,
    hasHeldDeliveryBacklog: () => false,
    handoffToMailbox: async (args) => {
      handoffCalls.push(args);
      return { state: 'enqueued' as const, dbId: 'db-1', changed: true, advanced: true };
    },
    publishStatusChanged: async () => {},
    recordActivity: (sessionId) => activities.push(sessionId),
    ...overrides,
  };
  return { deps, handoffCalls, activities };
}

describe('deliverAgentMessageToTarget', () => {
  it('delivers through the mailbox door and reports the resolved session', async () => {
    const { deps, handoffCalls, activities } = makeDeps();
    const outcome = await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'review please',
      messageId: 'msg-1',
    });
    expect(outcome).toEqual({ state: 'delivered', sessionId: 'sess-1', messageId: 'msg-1' });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0].target.defer).toBeUndefined();
    expect(activities).toEqual(['sess-1']);
  });

  it('rejects a worker whose task was rebound to another workflow run before resolution', async () => {
    const { deps, handoffCalls } = makeDeps({
      taskRepo: {
        getTask: () => ({ id: 'task-1', workflowRunId: 'run-2', status: 'in_progress' }),
      },
      ensureSession: async () => {
        throw new Error('must not resolve');
      },
    });
    const outcome = await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'stale router',
      messageId: 'msg-2',
    });
    expect(outcome).toEqual({
      state: 'not_found',
      messageId: 'msg-2',
      error: 'workflow run changed',
    });
    expect(handoffCalls).toHaveLength(0);
  });

  it('maps internal resolution failures to failed and plain gaps to not_found', async () => {
    const internalDeps = makeDeps({
      ensureSession: async () => ({ kind: 'unresolved' as const, reason: 'internal: repo down' }),
    });
    expect(
      await deliverAgentMessageToTarget({
        deps: internalDeps.deps,
        target: WORKER_TARGET,
        message: 'x',
        messageId: 'msg-3',
      })
    ).toEqual({ state: 'failed', messageId: 'msg-3', error: 'internal: repo down' });

    const plainDeps = makeDeps({
      ensureSession: async () => ({ kind: 'unresolved' as const, reason: 'no live session' }),
    });
    expect(
      await deliverAgentMessageToTarget({
        deps: plainDeps.deps,
        target: WORKER_TARGET,
        message: 'x',
        messageId: 'msg-4',
      })
    ).toEqual({ state: 'not_found', messageId: 'msg-4', error: 'no live session' });
  });

  it('accepts a provenance-backed post-approval worker without a node execution row', async () => {
    const { deps, handoffCalls } = makeDeps({
      nodeExecutionRepo: { listByWorkflowRun: () => [] },
      isPostApprovalWorker: (_taskId, agentName, sessionId) =>
        agentName === 'reviewer' && sessionId === 'sess-1',
    });
    const outcome = await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'merge blocked',
      messageId: 'msg-pa',
    });
    expect(outcome).toEqual({ state: 'delivered', sessionId: 'sess-1', messageId: 'msg-pa' });
    expect(handoffCalls).toHaveLength(1);
  });

  it('fails delivery when the task or run is terminal', async () => {
    const { deps } = makeDeps({
      resolveTerminalStatus: () => 'cancelled',
    });
    expect(
      await deliverAgentMessageToTarget({
        deps,
        target: WORKER_TARGET,
        message: 'x',
        messageId: 'msg-5',
      })
    ).toEqual({
      state: 'failed',
      messageId: 'msg-5',
      error: 'task/run is terminal (cancelled)',
    });
  });

  it('defers admission while the parent task is rate limited', async () => {
    const { deps, handoffCalls } = makeDeps({
      taskRepo: {
        getTask: () => ({ id: 'task-1', workflowRunId: 'run-1', status: 'rate_limited' }),
      },
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'x',
      messageId: 'msg-6',
    });
    expect(handoffCalls[0].target.defer).toBe(true);
    expect(handoffCalls[0].stateManager).toBeUndefined();
  });

  it('defers admission behind an unconsumed held backlog', async () => {
    const { deps, handoffCalls } = makeDeps({
      hasHeldDeliveryBacklog: () => true,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'x',
      messageId: 'msg-7',
    });
    expect(handoffCalls[0].target.defer).toBe(true);
  });

  it('clears prior context for an idle resetContextPerTurn slot before handoff', async () => {
    const live = makeSession({ status: 'idle' });
    const { deps } = makeDeps({
      getSessionAsync: async () => live.session,
      slotResetsContext: () => true,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'fresh turn',
      messageId: 'msg-8',
    });
    expect(live.clearMock).toHaveBeenCalledTimes(1);
  });

  it('skips the context clear while the session is busy', async () => {
    const live = makeSession({ status: 'processing' });
    const { deps } = makeDeps({
      getSessionAsync: async () => live.session,
      slotResetsContext: () => true,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'queued turn',
      messageId: 'msg-9',
    });
    expect(live.clearMock).not.toHaveBeenCalled();
  });

  it('propagates a stale mailbox handoff as a delivery error', async () => {
    const { deps } = makeDeps({
      handoffToMailbox: async () => ({ state: 'stale' as const }),
    });
    await expect(
      deliverAgentMessageToTarget({
        deps,
        target: WORKER_TARGET,
        message: 'x',
        messageId: 'msg-10',
      })
    ).rejects.toThrow('Mailbox handoff became stale');
  });
});
