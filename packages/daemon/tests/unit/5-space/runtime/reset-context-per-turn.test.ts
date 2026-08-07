/**
 * Unit tests for the `resetContextPerTurn` runtime mechanism in TaskAgentManager.
 *
 * Verifies the trigger/gating contract:
 *  - A task input (node→node handoff) to a slot with resetContextPerTurn set,
 *    at a turn boundary with prior context, clears the SDK context before the
 *    turn runs (and still delivers the handoff + persists it).
 *  - Human input, system recovery nags, the slot's first turn (no prior
 *    sdkSessionId), a busy session, and a slot without the flag do NOT clear.
 *
 * The clear primitive itself (AgentSession.clearConversationContext) is covered
 * in agent-session-clear-context.test.ts; here clearConversationContext is
 * mocked so we assert purely on the DECISION to invoke it.
 */
import { describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const SESSION_ID = 'reviewer-session-1';
const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-1';
const NODE_ID = 'node-review';
const AGENT_NAME = 'reviewer';

interface MockSessionOptions {
  sdkSessionId?: string;
  status?: string;
}

function makeManager(opts: {
  slotResets?: boolean;
  nodeMissing?: boolean;
  nodeEmptyAgents?: boolean;
}): {
  manager: TaskAgentManager;
  session: Record<string, ReturnType<typeof mock>>;
} {
  const clearMock = mock(async () => {});
  const ensureStartedMock = mock(async () => ({ started: false }));
  const enqueueMock = mock(async () => {});
  const getProcessingState = mock(() => ({ status: 'idle' }));
  const saveUserMessage = mock(() => 'db-id');

  function makeSession(o: MockSessionOptions) {
    return {
      session: { id: SESSION_ID, sdkSessionId: o.sdkSessionId },
      getProcessingState,
      ensureQueryStarted: ensureStartedMock,
      clearConversationContext: clearMock,
      messageQueue: { enqueueWithId: enqueueMock },
    } as unknown as AgentSession;
  }

  const slot = {
    agentId: 'Reviewer',
    name: AGENT_NAME,
    ...(opts.slotResets ? { resetContextPerTurn: true } : {}),
  };
  const workflow = {
    nodes: opts.nodeMissing
      ? []
      : [{ id: NODE_ID, name: 'Review', agents: opts.nodeEmptyAgents ? [] : [slot] }],
  };

  const config = {
    db: {
      getDatabase: () => ({}),
      saveUserMessage,
    },
    internalEventBus: {
      subscribe: mock(() => () => {}),
      publish: mock(() => {}),
    },
    nodeExecutionRepo: {
      getByAgentSessionId: mock(() => ({
        workflowRunId: RUN_ID,
        workflowNodeId: NODE_ID,
        agentName: AGENT_NAME,
        agentSessionId: SESSION_ID,
      })),
      // dev's terminal-task guard (resolveNodeExecutionForSubSession) calls this on
      // every inject; return empty so the guard finds no execution and skips the
      // cancelled/archived rejection (these tests exercise the clear path, not the
      // guard). SESSION_ID doesn't parse to an embedded exec id, so getById is
      // never reached.
      listByAgentSessionId: mock(() => []),
    },
    workflowRunRepo: {
      getRun: mock(() => ({ workflowId: WORKFLOW_ID })),
    },
    spaceWorkflowManager: {
      getWorkflow: mock(() => workflow),
    },
  } as unknown as TaskAgentManagerConfig;

  const manager = new TaskAgentManager(config);
  return {
    manager,
    session: { clearMock, ensureStartedMock, enqueueMock, getProcessingState, saveUserMessage },
  };
}

/** Sneak a mock session into the private reverse index so inject resolves it. */
function indexSession(manager: TaskAgentManager, session: AgentSession): void {
  (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    SESSION_ID,
    session
  );
}

describe('resetContextPerTurn — TaskAgentManager injection gating', () => {
  it('clears SDK context before a task handoff to a resetContextPerTurn slot with prior context', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    // Build a session that already has prior SDK context (a prior turn ran).
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    // isSyntheticMessage=true → classified as 'task' at the inject entry point.
    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).toHaveBeenCalledTimes(1);
    // The handoff is still delivered and persisted (UI thread continuity).
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('does NOT clear for human input (isSyntheticMessage=false)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'a human follow-up', false);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear on the first turn (no prior sdkSessionId)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    // Fresh session: no sdkSessionId yet (the SDK has not run a turn).
    const live = {
      session: { id: SESSION_ID, sdkSessionId: undefined },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear for a system recovery nag (injectRuntimeRecoveryMessage)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectRuntimeRecoveryMessage(SESSION_ID, '/compact');

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear when the slot does not have the flag set', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear while the session is mid-turn (busy)', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
  });

  it('does NOT clear for synthetic non-handoff injects (external events / hook notices)', async () => {
    // External-event digests (agent.message.inject) and hook-failure notices
    // (notifySourceSession) are synthetic but NOT node→node handoffs — passing
    // inputKind='system' must keep them from clearing a reset-enabled slot.
    const { manager, session } = makeManager({ slotResets: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      'external event digest',
      true,
      undefined,
      'immediate',
      'system'
    );

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).toHaveBeenCalled();
  });

  it('serializes concurrent injects per session so the clear cannot interleave', async () => {
    // Two injects to the same idle reset-enabled session must not interleave:
    // while one is parked in the (async) clear, the other waits on the
    // per-session lock instead of delivering into the stopping query.
    const { manager, session } = makeManager({ slotResets: true });
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: mock(async () => {
        await clearGate;
      }),
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    const settle = () => new Promise((r) => setTimeout(r, 0));

    const p1 = manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);
    await settle(); // first inject reaches the gated clear
    const p2 = manager.injectSubSessionMessage(SESSION_ID, 'a human follow-up', false);
    await settle(); // second inject would deliver here if not serialized

    // First inject is parked in the clear; the second is blocked on the lock —
    // nothing has been delivered yet (saveUserMessage runs AFTER the clear).
    expect(session.saveUserMessage).toHaveBeenCalledTimes(0);

    releaseClear();
    await Promise.all([p1, p2]);
    // Both delivered once serialized.
    expect(session.saveUserMessage).toHaveBeenCalledTimes(2);
  });

  it('does NOT drop the handoff when the node has a corrupt/empty agents array (P2-7)', async () => {
    // resolveNodeAgents throws on an empty agents array. The clear lookup sits
    // on the delivery path, so a throw must not abort the handoff — it should
    // degrade to "no clear" and still deliver.
    const { manager, session } = makeManager({ slotResets: true, nodeEmptyAgents: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    // The handoff is still delivered and persisted.
    expect(session.saveUserMessage).toHaveBeenCalled();
    expect(session.enqueueMock).toHaveBeenCalled();
  });

  it('releases the per-session inject-lock entry after completion (no unbounded growth)', async () => {
    const { manager, session } = makeManager({ slotResets: false });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'msg', true);

    const locks = (manager as unknown as { sessionInjectLocks: Map<string, unknown> })
      .sessionInjectLocks;
    expect(locks.size).toBe(0);
  });
});
