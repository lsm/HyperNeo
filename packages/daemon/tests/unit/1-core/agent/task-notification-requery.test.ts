import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  buildTaskNotificationRequeryEscalationEvent,
  isTopLevelHollowTaskNotificationResult,
  resolveTaskNotificationRequery,
  TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE,
  TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
  taskNotificationRequeryDelayMs,
} from '../../../../src/lib/agent/task-notification-requery';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function buildResultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1000,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 2,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: { ...ZERO_USAGE },
    modelUsage: {},
    permission_denials: [],
    parent_tool_use_id: null,
    uuid: 'result-uuid',
    session_id: 'requery-session-id',
    ...overrides,
  } as unknown as SDKMessage;
}

function buildHollowTaskNotificationResult(): SDKMessage {
  return buildResultMessage({ origin: { kind: 'task-notification' } });
}

function buildSessionStateChangedMessage(state: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: 'state-uuid',
    session_id: 'requery-session-id',
  } as unknown as SDKMessage;
}

function buildRealSuccessResult(): SDKMessage {
  return buildResultMessage({
    result: 'Review handoff submitted.',
    usage: { ...ZERO_USAGE, input_tokens: 1200, output_tokens: 340 },
    num_turns: 8,
  });
}

function buildApiErrorTerminalResult(): SDKMessage {
  return buildResultMessage({
    is_error: true,
    terminal_reason: 'api_error',
    result: 'API Error: Connection refused (ConnectionRefused)',
  });
}

describe('task-notification requery policy', () => {
  afterEach(() => {
    delete process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS;
  });

  describe('isTopLevelHollowTaskNotificationResult', () => {
    it('accepts a hollow task-notification result', () => {
      expect(isTopLevelHollowTaskNotificationResult(buildHollowTaskNotificationResult())).toBe(
        true
      );
    });

    it('rejects results where the model produced output', () => {
      expect(
        isTopLevelHollowTaskNotificationResult(
          buildResultMessage({
            origin: { kind: 'task-notification' },
            usage: { ...ZERO_USAGE, input_tokens: 900 },
          })
        )
      ).toBe(false);
      expect(
        isTopLevelHollowTaskNotificationResult(
          buildResultMessage({
            origin: { kind: 'task-notification' },
            result: 'Consumed the notification.',
          })
        )
      ).toBe(false);
    });

    it('rejects error results, foreign origins, nested results, and non-results', () => {
      expect(
        isTopLevelHollowTaskNotificationResult(
          buildResultMessage({ origin: { kind: 'task-notification' }, is_error: true })
        )
      ).toBe(false);
      expect(
        isTopLevelHollowTaskNotificationResult(buildResultMessage({ origin: { kind: 'human' } }))
      ).toBe(false);
      expect(
        isTopLevelHollowTaskNotificationResult(
          buildResultMessage({
            origin: { kind: 'task-notification' },
            parent_tool_use_id: 'toolu-123',
          })
        )
      ).toBe(false);
      expect(
        isTopLevelHollowTaskNotificationResult({ type: 'assistant' } as unknown as SDKMessage)
      ).toBe(false);
    });
  });

  describe('resolveTaskNotificationRequery', () => {
    const base = { attempts: 0, exhausted: false, followUpQueued: false };

    it('stands down with reset on results that show real model activity', () => {
      expect(
        resolveTaskNotificationRequery({ ...base, message: buildRealSuccessResult() })
      ).toEqual({ action: 'reset' });
      expect(
        resolveTaskNotificationRequery({ ...base, message: buildApiErrorTerminalResult() })
      ).toEqual({ action: 'reset' });
    });

    it('holds on non-result and nested-result messages', () => {
      expect(
        resolveTaskNotificationRequery({ ...base, message: { type: 'user' } as SDKMessage })
      ).toEqual({ action: 'hold' });
      expect(
        resolveTaskNotificationRequery({
          ...base,
          message: buildResultMessage({
            origin: { kind: 'task-notification' },
            parent_tool_use_id: 'toolu-123',
          }),
        })
      ).toEqual({ action: 'hold' });
    });

    it('holds while a follow-up user message is already queued', () => {
      expect(
        resolveTaskNotificationRequery({
          ...base,
          followUpQueued: true,
          message: buildHollowTaskNotificationResult(),
        })
      ).toEqual({ action: 'hold' });
    });

    it('escalates once the bounded budget is exhausted and stays held afterwards', () => {
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
          message: buildHollowTaskNotificationResult(),
        })
      ).toEqual({ action: 'escalate' });
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
          exhausted: true,
          message: buildHollowTaskNotificationResult(),
        })
      ).toEqual({ action: 'hold' });
    });

    it('requeries immediately on the first hollow result and backs off afterwards', () => {
      expect(
        resolveTaskNotificationRequery({ ...base, message: buildHollowTaskNotificationResult() })
      ).toEqual({ action: 'requery', delayMs: 0 });
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: 2,
          message: buildHollowTaskNotificationResult(),
        })
      ).toEqual({ action: 'requery', delayMs: 1000 });
    });
  });

  describe('taskNotificationRequeryDelayMs', () => {
    it('follows the default backoff ladder', () => {
      expect(taskNotificationRequeryDelayMs(0)).toBe(0);
      expect(taskNotificationRequeryDelayMs(1)).toBe(500);
      expect(taskNotificationRequeryDelayMs(2)).toBe(1000);
      expect(taskNotificationRequeryDelayMs(3)).toBe(2000);
      expect(taskNotificationRequeryDelayMs(10)).toBe(8000);
    });

    it('honors the test base-delay override', () => {
      process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '1';
      expect(taskNotificationRequeryDelayMs(2)).toBe(2);
      process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '0';
      expect(taskNotificationRequeryDelayMs(4)).toBe(0);
    });
  });

  describe('buildTaskNotificationRequeryEscalationEvent', () => {
    it('returns null unless space, task, and run context all resolve', () => {
      expect(
        buildTaskNotificationRequeryEscalationEvent({
          sessionId: 's1',
          attempts: 5,
          timestamp: '2026-08-23T00:00:00.000Z',
        })
      ).toBeNull();
      expect(
        buildTaskNotificationRequeryEscalationEvent({
          sessionId: 's1',
          spaceId: 'space-1',
          taskId: 'task-1',
          attempts: 5,
          timestamp: '2026-08-23T00:00:00.000Z',
        })
      ).toBeNull();
    });

    it('builds the needs-attention event when the full context resolves', () => {
      expect(
        buildTaskNotificationRequeryEscalationEvent({
          sessionId: 's1',
          spaceId: 'space-1',
          taskId: 'task-1',
          workflowRunId: 'run-1',
          attempts: 5,
          timestamp: '2026-08-23T00:00:00.000Z',
        })
      ).toEqual({
        sessionId: 's1',
        spaceId: 'space-1',
        runId: 'run-1',
        taskId: 'task-1',
        reason: expect.stringContaining('immediate re-query budget exhausted'),
        retriesExhausted: 5,
        timestamp: '2026-08-23T00:00:00.000Z',
      });
    });
  });
});

describe('AgentSession task-notification requery (incident replay)', () => {
  let agentSession: AgentSession;
  let enqueueSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let activeDeliveryUuids: Set<string>;
  let consumedFollowUpUuids: Set<string>;
  let revokedPendingMessage: { dbId: string; uuid: string } | null;

  const settleRequery = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  const continueCalls = (): number => enqueueSpy.mock.calls.length;

  const needsAttentionPublishes = (): number =>
    publishSpy.mock.calls.filter(
      ([event]: [string]) => event === 'space.workflowRun.needsAttention'
    ).length;

  function createRequerySession(sessionOverrides: Record<string, unknown> = {}): AgentSession {
    const session = {
      id: 'requery-session-id',
      title: 'Requery Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
      metadata: {},
      ...sessionOverrides,
    } as unknown as Session;

    const db = {
      getSession: mock(() => session),
      updateSession: mock(() => {}),
      saveSDKMessage: mock(() => true),
      getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      getUserMessageIdsByStatus: mock(() => []),
      getMessageByStatusAndUuid: mock((_sessionId: string, status: string, uuid?: string) =>
        status === 'consumed' && uuid !== undefined && consumedFollowUpUuids.has(uuid)
          ? { dbId: 'db-consumed' }
          : null
      ),
      deletePendingUserMessage: mock(() => revokedPendingMessage),
      updateMessageStatus: mock(() => {}),
      updateMessageTimestamp: mock(() => {}),
      beginTransaction: mock(() => {}),
      commitTransaction: mock(() => {}),
      abortTransaction: mock(() => {}),
      getJobQueueRepo: mock(() => ({
        activeDeliveryMessageUuids: () => activeDeliveryUuids,
        cancelForSessionWithMessages: () => [],
        cancelDelivery: () => {},
      })),
      getNodeExecutionRepo: mock(() => ({
        getByAgentSessionId: () => ({ id: 'exec-1', workflowRunId: 'run-1' }),
      })),
    } as unknown as Database;

    return new AgentSession(
      session,
      db,
      { event: mock(() => {}) } as unknown as MessageHub,
      {
        publish: publishSpy,
        publishAsync: publishSpy,
        subscribe: mock(
          (_: string, __: (data: unknown) => void, ___: { subscriberName: string }) => () => {}
        ),
      } as unknown as InternalEventBus<DaemonInternalEventMap>,
      mock(async () => 'test-api-key')
    );
  }

  function armLiveQuery(session: AgentSession): void {
    session.messageQueue.start();
    session.queryPromise = new Promise<void>(() => {});
    (
      session.messageQueue as unknown as {
        enqueueWithId: (
          messageId: string,
          content: string | MessageContent[],
          internal?: boolean
        ) => Promise<void>;
      }
    ).enqueueWithId = enqueueSpy;
  }

  beforeEach(() => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '1';
    activeDeliveryUuids = new Set();
    consumedFollowUpUuids = new Set();
    revokedPendingMessage = null;
    enqueueSpy = mock(async () => {});
    publishSpy = mock(async () => {});
    agentSession = createRequerySession({
      context: { spaceId: 'space-1', taskId: 'task-1' },
    });
    armLiveQuery(agentSession);
  });

  afterEach(() => {
    delete process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS;
    (
      agentSession as unknown as {
        clearTaskNotificationRequeryTimer: () => void;
      }
    ).clearTaskNotificationRequeryTimer();
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();
  });

  it('replays the incident: api_error terminal, hollow wakeup, re-query retries until recovery', async () => {
    await agentSession.onSDKMessage(buildApiErrorTerminalResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);
    expect(enqueueSpy.mock.calls[0]).toEqual([
      expect.any(String),
      TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE,
    ]);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(2);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(3);

    await agentSession.onSDKMessage(buildRealSuccessResult());
    await settleRequery();
    expect(continueCalls()).toBe(3);
    expect(needsAttentionPublishes()).toBe(0);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(4);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('escalates to the needs-attention channel when the budget is exhausted', async () => {
    for (let i = 0; i < TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS; i++) {
      await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
      await settleRequery();
    }
    expect(continueCalls()).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
    expect(needsAttentionPublishes()).toBe(0);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
    expect(needsAttentionPublishes()).toBe(1);
    expect(
      publishSpy.mock.calls.find(
        ([event]: [string]) => event === 'space.workflowRun.needsAttention'
      )
    ).toEqual([
      'space.workflowRun.needsAttention',
      expect.objectContaining({
        sessionId: 'requery-session-id',
        spaceId: 'space-1',
        runId: 'run-1',
        taskId: 'task-1',
        retriesExhausted: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
      }),
    ]);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
    expect(needsAttentionPublishes()).toBe(1);
  });

  it('skips the re-query while a follow-up user message is already queued', async () => {
    activeDeliveryUuids.add('queued-follow-up-uuid');

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('holds the pending re-query while a consumed follow-up turn is processing', async () => {
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await agentSession.stateManager.setProcessing('user-follow-up', 'initializing');
    await settleRequery();
    expect(continueCalls()).toBe(1);
    expect(needsAttentionPublishes()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(2);
  });

  it('preserves retry backoff when a hollow result is deferred to session_state_changed: idle', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '50';
    (
      agentSession as unknown as { taskNotificationRequeryAttempts: number }
    ).taskNotificationRequeryAttempts = 2;

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await agentSession.stateManager.setProcessing('prior-turn', 'initializing');

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(continueCalls()).toBe(1);
  });

  it('stands down when the query is replaced after a continuation is scheduled', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    (
      agentSession as unknown as { incrementQueryGeneration: () => number }
    ).incrementQueryGeneration();

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(continueCalls()).toBe(1);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('drops a pending continuation when the query is replaced before idle', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '1';
    (
      agentSession as unknown as { taskNotificationRequeryAttempts: number }
    ).taskNotificationRequeryAttempts = 2;

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await agentSession.stateManager.setProcessing('prior-turn', 'initializing');

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    (
      agentSession as unknown as { incrementQueryGeneration: () => number }
    ).incrementQueryGeneration();

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(
      (agentSession as unknown as { taskNotificationRequeryAttempts: number })
        .taskNotificationRequeryAttempts
    ).toBe(0);
  });

  it('ignores delivery jobs whose messages were already consumed when detecting follow-ups', async () => {
    activeDeliveryUuids.add('consumed-follow-up');
    consumedFollowUpUuids.add('consumed-follow-up');

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('does not arm a new episode from a hollow result trailing an in-flight interrupt', async () => {
    await agentSession.stateManager.setProcessing('live-turn', 'initializing');
    agentSession.onInterruptRequested();
    await agentSession.stateManager.setIdle();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('keeps arming episodes after an interrupt that landed while idle', async () => {
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    agentSession.onInterruptRequested();
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(2);
  });

  it('suppresses episodes trailing an interrupt during an SDK-busy turn', async () => {
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await agentSession.handleInterrupt();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('keeps revoked-follow-up continuations behind the trailing SDK idle', async () => {
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    activeDeliveryUuids.add('queued-follow-up-uuid');

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    activeDeliveryUuids.clear();
    revokedPendingMessage = { dbId: 'db-pending', uuid: 'queued-follow-up-uuid' };
    await agentSession.revokePendingDelivery('db-pending', 'remove');
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('restarts a dead query to deliver the pending continuation', async () => {
    const ensureQueryStarted = mock(async () => 'started' as const);
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(1);
  });

  it('climbs the retry ladder when the dead-query restart fails', async () => {
    const ensureQueryStarted = mock(async () => {
      throw new Error('restart boom');
    });
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(1);
  });

  it('removes a queued continuation when the session is interrupted before consumption', async () => {
    const slowEnqueue = mock(() => new Promise<void>(() => {}));
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof slowEnqueue }).enqueueWithId =
      slowEnqueue;
    const removeSpy = mock(() => false);
    (agentSession.messageQueue as unknown as { remove: typeof removeSpy }).remove = removeSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(slowEnqueue.mock.calls.length).toBe(1);

    await agentSession.handleInterrupt();
    expect(removeSpy.mock.calls[0]?.[0]).toBe(slowEnqueue.mock.calls[0]?.[0]);
    expect(continueCalls()).toBe(0);
  });

  it('re-arms the re-query when a queued follow-up delivery is revoked', async () => {
    activeDeliveryUuids.add('queued-follow-up-uuid');
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(0);

    activeDeliveryUuids.clear();
    revokedPendingMessage = { dbId: 'db-pending', uuid: 'queued-follow-up-uuid' };
    await agentSession.revokePendingDelivery('db-pending', 'remove');
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('escalates instead of exceeding the budget when a held episode is flushed', async () => {
    activeDeliveryUuids.add('queued-follow-up-uuid');
    (
      agentSession as unknown as { taskNotificationRequeryAttempts: number }
    ).taskNotificationRequeryAttempts = TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    activeDeliveryUuids.clear();
    revokedPendingMessage = { dbId: 'db-pending', uuid: 'queued-follow-up-uuid' };
    await agentSession.revokePendingDelivery('db-pending', 'remove');
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(1);
  });

  it('keeps retrying after restarting the dead query bumps the generation', async () => {
    const ensureQueryStarted = mock(async () => {
      (
        agentSession as unknown as { incrementQueryGeneration: () => number }
      ).incrementQueryGeneration();
      return 'started' as const;
    });
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();
    let failNextEnqueue = true;
    enqueueSpy = mock(async () => {
      if (failNextEnqueue) {
        failNextEnqueue = false;
        throw new Error('enqueue boom');
      }
    });
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof enqueueSpy }).enqueueWithId =
      enqueueSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(continueCalls()).toBe(2);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('defers autonomous-turn continuations to the trailing SDK idle', async () => {
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('re-validates guards when a follow-up lands during the dead-query restart', async () => {
    let addedFollowUp = false;
    const ensureQueryStarted = mock(async () => {
      if (!addedFollowUp) {
        addedFollowUp = true;
        activeDeliveryUuids.add('mid-restart-follow-up');
      }
      return 'started' as const;
    });
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    activeDeliveryUuids.clear();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('stands down when the episode is reset during the dead-query restart', async () => {
    const ensureQueryStarted = mock(async () => {
      agentSession.resetTaskNotificationRequery();
      return 'started' as const;
    });
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('removes a queued continuation when the episode resets', async () => {
    const slowEnqueue = mock(() => new Promise<void>(() => {}));
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof slowEnqueue }).enqueueWithId =
      slowEnqueue;
    const removeSpy = mock(() => false);
    (agentSession.messageQueue as unknown as { remove: typeof removeSpy }).remove = removeSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    agentSession.resetTaskNotificationRequery();
    expect(removeSpy.mock.calls[0]?.[0]).toBe(slowEnqueue.mock.calls[0]?.[0]);
  });

  it('escalates at the budget when a held episode meets a dead query', async () => {
    const ensureQueryStarted = mock(async () => {
      throw new Error('restart boom');
    });
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();
    (
      agentSession as unknown as { taskNotificationRequeryAttempts: number }
    ).taskNotificationRequeryAttempts = TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(0);
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(1);
    expect(
      publishSpy.mock.calls.find(
        ([event]: [string]) => event === 'space.workflowRun.needsAttention'
      )
    ).toEqual([
      'space.workflowRun.needsAttention',
      expect.objectContaining({
        retriesExhausted: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
      }),
    ]);
  });

  it('discards restart failures that land after the episode was reset', async () => {
    const ensureQueryStarted = mock(async () => {
      agentSession.resetTaskNotificationRequery();
      throw new Error('restart boom');
    });
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('clears the SDK-idle latch when the query is replaced', async () => {
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    (
      agentSession as unknown as { incrementQueryGeneration: () => number }
    ).incrementQueryGeneration();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('ignores continuation delivery failures that land after a reset', async () => {
    const holder: { reject?: (error: Error) => void } = {};
    enqueueSpy = mock(
      () =>
        new Promise<void>((_, reject) => {
          holder.reject = reject;
        })
    );
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof enqueueSpy }).enqueueWithId =
      enqueueSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    agentSession.resetTaskNotificationRequery();
    holder.reject?.(new Error('late queue timeout'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('waits out the stopped query teardown window before restarting', async () => {
    const ensureQueryStarted = mock(async () => 'started' as const);
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(0);

    agentSession.queryPromise = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(1);
  });

  it('re-parks a scheduled retry when the SDK turns busy during the backoff', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    (
      agentSession as unknown as { taskNotificationRequeryAttempts: number }
    ).taskNotificationRequeryAttempts = 1;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('re-arms recovery when the query settles after delivering a continuation', async () => {
    const ensureQueryStarted = mock(async () => 'started' as const);
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    const holder: { resolve?: () => void } = {};
    agentSession.queryPromise = new Promise<void>((resolve) => {
      holder.resolve = resolve;
    });

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    holder.resolve?.();
    agentSession.queryPromise = null;
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(2);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('clears a pending re-query timer when the user interrupts', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await agentSession.handleInterrupt();
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(continueCalls()).toBe(1);
    expect(needsAttentionPublishes()).toBe(0);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await agentSession.interruptHandler.handleInterrupt();
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(continueCalls()).toBe(1);
  });

  it('stands down in manual mode without the live query and logs instead of publishing outside space context', async () => {
    const detachedSession = createRequerySession({
      config: { model: 'default', maxTokens: 8192, temperature: 1.0, queryMode: 'manual' },
    });
    armLiveQuery(detachedSession);
    detachedSession.queryPromise = null;
    detachedSession.messageQueue.stop();

    await detachedSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    (
      detachedSession as unknown as { taskNotificationRequeryAttempts: number }
    ).taskNotificationRequeryAttempts = TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS;
    await detachedSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(
      publishSpy.mock.calls.filter(
        ([event]: [string]) => event === 'space.workflowRun.needsAttention'
      ).length
    ).toBe(0);
    const sessionError = publishSpy.mock.calls.find(
      ([event]: [string]) => event === 'session.error'
    );
    expect(sessionError).toBeDefined();
    expect(sessionError?.[1]).toMatchObject({
      sessionId: 'requery-session-id',
      error: expect.stringContaining('background-task notification'),
    });

    (
      detachedSession as unknown as { clearTaskNotificationRequeryTimer: () => void }
    ).clearTaskNotificationRequeryTimer();
    detachedSession.queryPromise = null;
    detachedSession.messageQueue.stop();
  });
});
