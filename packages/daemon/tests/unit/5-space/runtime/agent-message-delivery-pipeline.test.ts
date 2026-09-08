import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { MailboxHandoffArgs } from '../../../../src/lib/mailbox/handoff.ts';
import type { SessionTarget } from '../../../../src/lib/session-resolution/target.ts';
import {
  deliverAgentMessageToTarget,
  type AgentMessageDeliveryDeps,
} from '../../../../src/lib/space/runtime/agent-message-delivery-pipeline.ts';

const WORKER_TARGET: SessionTarget = {
  kind: 'worker',
  taskId: 'task-1',
  agentName: 'reviewer',
  workflowNodeId: 'node-1',
};

function makeSession(opts: { status?: string; sdkSessionId?: string | null } = {}) {
  const clearMock = mock(async () => {});
  const setQueuedIfIdle = mock(async () => true);
  const stub = {
    session: { id: 'sess-1', sdkSessionId: opts.sdkSessionId ?? 'sdk-prior' },
    getProcessingState: () => ({ status: opts.status ?? 'idle' }),
    clearConversationContext: clearMock,
    stateManager: { setQueuedIfIdle },
  };
  return { session: stub as unknown as AgentSession, clearMock, setQueuedIfIdle };
}

function makeDeps(overrides: Partial<AgentMessageDeliveryDeps> = {}) {
  const handoffCalls: Omit<MailboxHandoffArgs, 'jobQueue'>[] = [];
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
    hasSettledDelivery: () => false,
    mailboxDeliveryPending: () => true,
    verifyDeliveryContent: () => {},
    handoffToMailbox: async (args) => {
      handoffCalls.push(args);
      return { kind: 'enqueued' as const, id: 'mbox-1' };
    },
    recordActivity: (sessionId) => activities.push(sessionId),
    ...overrides,
  };
  return { deps, handoffCalls, activities };
}

describe('deliverAgentMessageToTarget', () => {
  it('delivers through the mailbox door and reports the resolved session', async () => {
    const live = makeSession();
    const { deps, handoffCalls, activities } = makeDeps({
      getSessionAsync: async () => live.session,
    });
    const outcome = await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'review please',
      messageId: 'msg-1',
    });
    expect(outcome).toEqual({ state: 'delivered', sessionId: 'sess-1', messageId: 'msg-1' });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0].to).toBe('session:sess-1');
    expect(handoffCalls[0].deliveryMode).toBeUndefined();
    expect(handoffCalls[0].messageUuid).toBe('msg-1');
    expect(handoffCalls[0].origin).toBe('space_agent');
    expect(live.setQueuedIfIdle).toHaveBeenCalledTimes(1);
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

  it('does not queue an idle session for a settled duplicate delivery', async () => {
    const live = makeSession();
    const { deps, handoffCalls } = makeDeps({
      getSessionAsync: async () => live.session,
      hasSettledDelivery: () => true,
    });
    const outcome = await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'same message again',
      messageId: 'msg-15',
    });
    expect(outcome).toEqual({ state: 'delivered', sessionId: 'sess-1', messageId: 'msg-15' });
    expect(handoffCalls).toHaveLength(1);
    expect(live.setQueuedIfIdle).not.toHaveBeenCalled();
  });

  it('does not queue an idle session once the mailbox entry has terminated', async () => {
    const live = makeSession();
    const { deps } = makeDeps({
      getSessionAsync: async () => live.session,
      mailboxDeliveryPending: () => false,
    });
    const outcome = await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'dead-lettered race',
      messageId: 'msg-17',
    });
    expect(outcome).toEqual({ state: 'delivered', sessionId: 'sess-1', messageId: 'msg-17' });
    expect(live.setQueuedIfIdle).not.toHaveBeenCalled();
  });

  it('defers admission while the parent task is rate limited', async () => {
    const live = makeSession();
    const { deps, handoffCalls } = makeDeps({
      taskRepo: {
        getTask: () => ({ id: 'task-1', workflowRunId: 'run-1', status: 'rate_limited' }),
      },
      getSessionAsync: async () => live.session,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'x',
      messageId: 'msg-6',
    });
    expect(handoffCalls[0].deliveryMode).toBe('defer');
    expect(live.setQueuedIfIdle).not.toHaveBeenCalled();
  });

  it('defers admission while the parent task is blocked (#3823)', async () => {
    const live = makeSession();
    const { deps, handoffCalls } = makeDeps({
      taskRepo: {
        getTask: () => ({ id: 'task-1', workflowRunId: 'run-1', status: 'blocked' }),
      },
      getSessionAsync: async () => live.session,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'peer nudge',
      messageId: 'msg-6-blocked',
    });
    expect(handoffCalls[0].deliveryMode).toBe('defer');
    expect(live.setQueuedIfIdle).not.toHaveBeenCalled();
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
    expect(handoffCalls[0].deliveryMode).toBe('defer');
  });

  it('defers the handoff when the task flips blocked during the context reset (#3823)', async () => {
    let blocked = false;
    const live = makeSession();
    (
      live.session as unknown as { clearConversationContext: () => Promise<void> }
    ).clearConversationContext = mock(async () => {
      blocked = true;
    });
    const { deps, handoffCalls } = makeDeps({
      getSessionAsync: async () => live.session,
      slotResetsContext: () => true,
      taskRepo: {
        getTask: () => ({
          id: 'task-1',
          workflowRunId: 'run-1',
          status: blocked ? 'blocked' : 'in_progress',
        }),
      },
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'x',
      messageId: 'msg-flip-blocked',
    });
    expect(handoffCalls[0].deliveryMode).toBe('defer');
    expect(live.setQueuedIfIdle).not.toHaveBeenCalled();
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

  it('defers a requested defer mode while the session is busy', async () => {
    const live = makeSession({ status: 'processing' });
    const { deps, handoffCalls } = makeDeps({
      getSessionAsync: async () => live.session,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'defer me',
      messageId: 'msg-10',
      deliveryMode: 'defer',
    });
    expect(handoffCalls[0].deliveryMode).toBe('defer');
  });

  it('delivers immediately when defer is requested but the session is idle', async () => {
    const live = makeSession({ status: 'idle' });
    const { deps, handoffCalls } = makeDeps({
      getSessionAsync: async () => live.session,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'defer me when busy',
      messageId: 'msg-11',
      deliveryMode: 'defer',
    });
    expect(handoffCalls[0].deliveryMode).toBeUndefined();
  });

  it('keeps conversation context for human input on a resetContextPerTurn slot', async () => {
    const live = makeSession({ status: 'idle' });
    const { deps } = makeDeps({
      getSessionAsync: async () => live.session,
      slotResetsContext: () => true,
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'human follow-up',
      messageId: 'msg-12',
      inputKind: 'human',
    });
    expect(live.clearMock).not.toHaveBeenCalled();
  });

  it('carries human and task input provenance through the mailbox message', async () => {
    const { deps, handoffCalls } = makeDeps();
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'human words',
      messageId: 'msg-13',
      inputKind: 'human',
    });
    await deliverAgentMessageToTarget({
      deps,
      target: WORKER_TARGET,
      message: 'task words',
      messageId: 'msg-14',
    });
    expect(handoffCalls[0].message.inputKind).toBe('human');
    expect(handoffCalls[0].message.message.content).toEqual([
      { type: 'text', text: 'human words' },
    ]);
    expect(handoffCalls[1].message.inputKind).toBe('task');
  });

  it('propagates a rejected mailbox handoff as a delivery error', async () => {
    const { deps } = makeDeps({
      handoffToMailbox: async () => ({ kind: 'rejected' as const, reason: 'entry malformed' }),
    });
    await expect(
      deliverAgentMessageToTarget({
        deps,
        target: WORKER_TARGET,
        message: 'x',
        messageId: 'msg-10',
      })
    ).rejects.toThrow('Mailbox handoff rejected: entry malformed');
  });

  it('rejects a conflicting redelivery before the mailbox handoff or queued marking', async () => {
    const live = makeSession();
    const conflict = new Error('prompt handoff: message exists with different content');
    const { deps, handoffCalls } = makeDeps({
      getSessionAsync: async () => live.session,
      verifyDeliveryContent: () => {
        throw conflict;
      },
    });
    await expect(
      deliverAgentMessageToTarget({
        deps,
        target: WORKER_TARGET,
        message: 'different body',
        messageId: 'msg-16',
      })
    ).rejects.toThrow('prompt handoff: message exists with different content');
    expect(handoffCalls).toHaveLength(0);
    expect(live.setQueuedIfIdle).not.toHaveBeenCalled();
  });
});
