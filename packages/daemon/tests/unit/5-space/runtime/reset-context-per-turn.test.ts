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

function makeManager(opts: { slotResets?: boolean; nodeMissing?: boolean }): {
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
    nodes: opts.nodeMissing ? [] : [{ id: NODE_ID, name: 'Review', agents: [slot] }],
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
});
