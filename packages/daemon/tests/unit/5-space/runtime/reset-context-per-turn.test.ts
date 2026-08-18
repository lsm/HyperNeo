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
import { describe, expect, it, mock, beforeAll, afterAll } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';

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
  hasActiveDeliveryJob?: boolean;
  /**
   * Controls the v2 idempotent-persist guard: the sendStatus getDeliveryContent
   * returns for the message (undefined ⇒ no existing row → fresh persist). Used
   * by the v2 dedup describe to exercise the consumed/failed/enqueued branches.
   */
  deliveryContent?: { sendStatus: string };
}): {
  manager: TaskAgentManager;
  session: Record<string, ReturnType<typeof mock>>;
} {
  const clearMock = mock(async () => {});
  const ensureStartedMock = mock(async () => ({ started: false }));
  const enqueueMock = mock(async () => {});
  const getProcessingState = mock(() => ({ status: 'idle' }));
  const saveUserMessage = mock(() => 'db-id');
  // Round-14 P2: the inject retry lane resets the startup-timeout budget.
  const resetStartupRetryBudget = mock(() => {});
  // v2 durable-delivery plumbing (harmless under the legacy path, which never
  // reaches these repos): the dedup guard's getDeliveryContent + the
  // deliverMessage jobQueue calls.
  // Test simplification: signal SDK consumption at enqueue time so the v2
  // consumption-await in injectMessageIntoSession resolves (production signals
  // from the bridge on the SDK's onSent; these tests don't drive a real turn).
  const jobQueueEnqueue = mock(
    (args: { payload?: { sessionId?: string; messageUuid?: string } }) => {
      const uuid = args?.payload?.messageUuid;
      if (uuid) signalDeliveryConsumed(args!.payload!.sessionId!, uuid);
      return { id: 'job-1' };
    }
  );
  const reopenDeliveryByUuid = mock(() => null);
  const markDeliveryDeferredByUuid = mock(() => null);

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
      getSDKMessageRepo: () => ({
        // The v2 dedup guard: return the configured prior outcome, or null when
        // no row exists yet (the first-inject case).
        getDeliveryContent: () => opts.deliveryContent ?? null,
        reopenDeliveryByUuid,
        markDeliveryFailedByUuid: () => null,
        markDeliveryDeferredByUuid,
      }),
      // The resetContextPerTurn gate calls hasActiveDeliveryJob (→ getJobQueueRepo
      // .activeDeliveryMessageUuids) regardless of the delivery path. Return a
      // pending job when the test opts in, so the gate's BLOCKING branch (don't
      // clear while a durable turn is pending) is exercised. enqueue +
      // getActiveDeliveryRole back the v2 deliverMessage chokepoint.
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () =>
          new Set<string>(opts.hasActiveDeliveryJob ? ['pending-job'] : []),
        enqueue: jobQueueEnqueue,
        getActiveDeliveryRole: () => null,
      }),
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
      getWorkflowForRun: mock(() => workflow),
    },
  } as unknown as TaskAgentManagerConfig;

  const manager = new TaskAgentManager(config);
  return {
    manager,
    session: {
      clearMock,
      ensureStartedMock,
      enqueueMock,
      resetStartupRetryBudget,
      getProcessingState,
      saveUserMessage,
      jobQueueEnqueue,
      reopenDeliveryByUuid,
      markDeliveryDeferredByUuid,
    },
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
  // These tests validate the resetContextPerTurn CLEAR decision, which is
  // delivery-mechanism agnostic (the clear runs before the v2/legacy branch).
  // Opt into the legacy inline path so the mock session — which has no
  // stateManager and only a gate-level jobQueue stub — exercises the clear
  // decision rather than the durable-delivery plumbing.
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });
  it('clears SDK context before a task handoff to a resetContextPerTurn slot with prior context', async () => {
    const { manager, session } = makeManager({ slotResets: true });
    // Build a session that already has prior SDK context (a prior turn ran).
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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

  it('does NOT clear when a durable turn is already pending for the session', async () => {
    const { manager, session } = makeManager({ slotResets: true, hasActiveDeliveryJob: true });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      resetStartupRetryBudget: session.resetStartupRetryBudget,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    // A durable turn is pending (activeDeliveryMessageUuids non-empty) — the
    // resetContextPerTurn gate must BLOCK the clear so it doesn't race the
    // pending v2 turn, even though the slot is reset-enabled + idle + has prior
    // context (the conditions that would otherwise clear).
    expect(session.clearMock).not.toHaveBeenCalled();
    // The handoff is still delivered and persisted.
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
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
      resetStartupRetryBudget: session.resetStartupRetryBudget,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, 'msg', true);

    const locks = (manager as unknown as { sessionInjectLocks: Map<string, unknown> })
      .sessionInjectLocks;
    expect(locks.size).toBe(0);
  });
});

describe('injectMessageIntoSession — v2 idempotent persist (Codex P1)', () => {
  // The sibling describe opts into the legacy path to test the clear decision;
  // here v2 runs default-on so the durable-delivery dedup guard is exercised.
  // saveUserMessage mints a fresh row id each call, so a flush retry reusing the
  // pending-row id must NOT insert a second sdk_messages row or re-drive a
  // consumed turn — it checks the existing row first (mirrors the LTA +
  // Space-agent injectors).
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  });
  afterAll(() => {
    if (previousFlag !== undefined) process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
    else delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  });

  function liveSession(session: {
    ensureStartedMock: ReturnType<typeof mock>;
    clearMock: ReturnType<typeof mock>;
    enqueueMock: ReturnType<typeof mock>;
  }): AgentSession {
    return {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      resetStartupRetryBudget: session.resetStartupRetryBudget,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
  }

  it('first inject persists the row and enqueues a durable job', async () => {
    const { manager, session } = makeManager({}); // no existing row
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(session.jobQueueEnqueue).toHaveBeenCalled();
  });

  it('a retry finding an existing CONSUMED row does not re-persist or re-enqueue (no re-drive)', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'consumed' } });
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.jobQueueEnqueue).not.toHaveBeenCalled();
  });

  it('a retry finding an existing FAILED row reopens it and re-enqueues without a duplicate row', async () => {
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'failed' } });
    indexSession(manager, liveSession(session));

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.reopenDeliveryByUuid).toHaveBeenCalledTimes(1);
    // The row already exists (failed) — reuse it, don't insert a second.
    expect(session.saveUserMessage).not.toHaveBeenCalled();
    expect(session.jobQueueEnqueue).toHaveBeenCalled();
  });

  it('a retry finding an existing CONSUMED row skips resetContextPerTurn (no /clear of the just-delivered handoff)', async () => {
    // A crash after the delivery job completed but before markDelivered retries
    // the same stable id. The slot has resetContextPerTurn + prior context, so
    // it WOULD /clear — but the consumed check runs first (hoisted above the
    // clear) and returns, so the context holding the just-delivered handoff is
    // not rotated away. (Codex P1.)
    const { manager, session } = makeManager({
      slotResets: true,
      deliveryContent: { sendStatus: 'consumed' },
    });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'idle' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      resetStartupRetryBudget: session.resetStartupRetryBudget,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.clearMock).not.toHaveBeenCalled();
    expect(session.saveUserMessage).not.toHaveBeenCalled();
  });

  it('a failed-row retry that hits the deferred branch marks the row deferred (replay-selectable)', async () => {
    // A prior attempt's enqueue failed (→ row 'failed'); a retry while the
    // target is in rate_limit_cooldown reaches the deferred branch. The row was
    // reopened to 'enqueued' — the deferred branch must flip it to 'deferred'
    // or QueryModeHandler's replay (send_status='deferred' only) never selects
    // it and the handoff is lost. (Codex P1.)
    const { manager, session } = makeManager({ deliveryContent: { sendStatus: 'failed' } });
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'rate_limit_cooldown' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      resetStartupRetryBudget: session.resetStartupRetryBudget,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    await manager.injectSubSessionMessage(SESSION_ID, '─── Message from coder ───', true);

    expect(session.reopenDeliveryByUuid).toHaveBeenCalledTimes(1); // failed → enqueued
    expect(session.markDeliveryDeferredByUuid).toHaveBeenCalledTimes(1); // enqueued → deferred
    expect(session.saveUserMessage).not.toHaveBeenCalled(); // row reused, no duplicate
  });

  it('a deferred human message to a busy live session persists as a deferred row (task #949)', async () => {
    // Full Queue/next-turn path: space.task.sendMessage forwards
    // deliveryMode:'defer' as injectSubSessionMessage's 5th arg. Against a live,
    // busy (processing) session it must persist via saveUserMessage('deferred')
    // — replayed at the next idle boundary, NOT enqueued as an immediate steer.
    // The rate_limit_cooldown test above enters the deferred branch via the
    // cooldown clause with the default immediate mode; this guards the explicit
    // (deliveryMode === 'defer' && isBusy) clause for a human message.
    const { manager, session } = makeManager({}); // no existing row → fresh persist
    const live = {
      session: { id: SESSION_ID, sdkSessionId: 'prior-sdk-session' },
      getProcessingState: () => ({ status: 'processing' }),
      ensureQueryStarted: session.ensureStartedMock,
      clearConversationContext: session.clearMock,
      resetStartupRetryBudget: session.resetStartupRetryBudget,
      messageQueue: { enqueueWithId: session.enqueueMock },
    } as unknown as AgentSession;
    indexSession(manager, live);

    // isSyntheticMessage=false → inputKind='human' (no resetContextPerTurn clear).
    await manager.injectSubSessionMessage(
      SESSION_ID,
      'queue for next turn',
      false,
      undefined,
      'defer'
    );

    expect(session.saveUserMessage).toHaveBeenCalledTimes(1);
    const [sid, _sdkMsg, status, origin] = session.saveUserMessage.mock.calls[0];
    expect(sid).toBe(SESSION_ID);
    expect(status).toBe('deferred');
    expect(origin).toBeUndefined();
    // Not enqueued for an immediate steer — it waits for the next idle boundary.
    expect(session.enqueueMock).not.toHaveBeenCalled();
  });
});
