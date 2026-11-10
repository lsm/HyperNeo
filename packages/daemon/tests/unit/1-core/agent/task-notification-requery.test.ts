import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  advanceTaskNotificationRequeryEpisode,
  buildTaskNotificationRequeryEscalationEvent,
  isTopLevelHollowTaskNotificationResult,
  resolveTaskNotificationRequery,
  TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE,
  TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
  taskNotificationRequeryDelayMs,
  type TaskNotificationRequeryEpisode,
} from '../../../../src/lib/agent/task-notification-requery';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';

function openRequeryEpisode(
  attempts: number,
  escalation: TaskNotificationRequeryEpisode['escalation'] = 'none'
): TaskNotificationRequeryEpisode {
  return { episode: 1, attempts, escalation, closed: false };
}

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

    it('keeps an active episode armed across failed continuation results', () => {
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: 3,
          message: buildApiErrorTerminalResult(),
        })
      ).toEqual({ action: 'requery', delayMs: taskNotificationRequeryDelayMs(3) });
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
          message: buildApiErrorTerminalResult(),
        })
      ).toEqual({ action: 'escalate' });
    });

    it('treats a completed terminal reason as model activity, not an error', () => {
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: 3,
          message: buildResultMessage({ terminal_reason: 'completed' }),
        })
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

    it('backs off from the first hollow result and escalates within its own budget', () => {
      expect(
        resolveTaskNotificationRequery({ ...base, message: buildHollowTaskNotificationResult() })
      ).toEqual({ action: 'requery', delayMs: 500 });
      expect(
        resolveTaskNotificationRequery({
          ...base,
          attempts: 2,
          message: buildHollowTaskNotificationResult(),
        })
      ).toEqual({ action: 'requery', delayMs: 1000 });
    });
  });

  describe('advanceTaskNotificationRequeryEpisode', () => {
    it('closes the episode when a consuming success resets it', () => {
      const advanced = advanceTaskNotificationRequeryEpisode(
        openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS),
        { kind: 'result', message: buildRealSuccessResult() }
      );
      expect(advanced.decision).toEqual({ action: 'reset' });
      expect(advanced.episode?.closed).toBe(true);
    });

    it('does not mint an episode for an ordinary result without a prior', () => {
      const advanced = advanceTaskNotificationRequeryEpisode(null, {
        kind: 'result',
        message: buildRealSuccessResult(),
      });
      expect(advanced.decision).toEqual({ action: 'reset' });
      expect(advanced.episode).toBeNull();
    });

    it('does not mint a fresh episode for an ordinary result on a closed prior', () => {
      const closed = { ...openRequeryEpisode(5), closed: true };
      const advanced = advanceTaskNotificationRequeryEpisode(closed, {
        kind: 'result',
        message: buildRealSuccessResult(),
      });
      expect(advanced.decision).toEqual({ action: 'reset' });
      expect(advanced.episode).toBe(closed);
    });

    it('closes the episode on the close signal without bumping a closed prior', () => {
      const open = advanceTaskNotificationRequeryEpisode(openRequeryEpisode(2), {
        kind: 'close',
      });
      expect(open.episode).toMatchObject({ episode: 1, closed: true });

      const alreadyClosed = { ...openRequeryEpisode(2), closed: true };
      const again = advanceTaskNotificationRequeryEpisode(alreadyClosed, { kind: 'close' });
      expect(again.episode).toBe(alreadyClosed);
    });

    it('opens a fresh episode after a closed one', () => {
      const closed = { ...openRequeryEpisode(5), closed: true };
      const advanced = advanceTaskNotificationRequeryEpisode(closed, {
        kind: 'result',
        message: buildHollowTaskNotificationResult(),
      });
      expect(advanced.episode).toMatchObject({ episode: 2, attempts: 0, closed: false });
      expect(advanced.decision.action).toBe('requery');
    });

    it.each(['attempt-issued', 'attempt-failed', 'delivery-failed'] as const)(
      'holds a stale %s signal on a closed episode instead of reopening it',
      (kind) => {
        const closed = { ...openRequeryEpisode(1), closed: true };
        const advanced = advanceTaskNotificationRequeryEpisode(closed, { kind });
        expect(advanced.episode).toBe(closed);
        expect(advanced.decision).toEqual({ action: 'hold' });
      }
    );

    it('retries a failed delivery without counting the attempt twice', () => {
      const advanced = advanceTaskNotificationRequeryEpisode(openRequeryEpisode(1), {
        kind: 'delivery-failed',
      });
      expect(advanced.episode.attempts).toBe(1);
      expect(advanced.decision.action).toBe('requery');
    });

    it('escalates when the last counted attempt fails to deliver', () => {
      const advanced = advanceTaskNotificationRequeryEpisode(
        openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS),
        { kind: 'delivery-failed' }
      );
      expect(advanced.episode).toMatchObject({
        attempts: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
        escalation: 'pending',
      });
      expect(advanced.decision).toEqual({ action: 'escalate' });
    });
  });

  describe('taskNotificationRequeryDelayMs', () => {
    it('follows the default backoff ladder', () => {
      expect(taskNotificationRequeryDelayMs(0)).toBe(500);
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
  let eventSubscribers: Map<string, Array<(data: Record<string, unknown>) => void>>;
  let boundRunIds: Map<string, string>;
  let activeDeliveryUuids: Set<string>;
  let consumedFollowUpUuids: Set<string>;
  let revokedPendingMessage: { dbId: string; uuid: string } | null;

  const fireInternalEvent = (event: string, data: Record<string, unknown>): void => {
    for (const handler of eventSubscribers.get(event) ?? []) handler(data);
  };

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
      getDatabase: mock(() => ({ prepare: mock(() => ({ get: mock(() => null) })) })),
      getSession: mock(() => session),
      updateSession: mock(async (_id: string, updates: { metadata?: unknown }) => {
        const partial = updates.metadata as Record<string, unknown> | undefined;
        if (!partial) return;
        const merged = { ...(session.metadata ?? {}) } as Record<string, unknown>;
        for (const [key, value] of Object.entries(partial)) {
          if (value === undefined || value === null) delete merged[key];
          else merged[key] = value;
        }
        session.metadata = merged as unknown as Session['metadata'];
      }),
      saveSDKMessage: mock(() => true),
      getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      getUserMessageIdsByStatus: mock(() => []),
      getMessageByStatusAndUuid: mock((_sessionId: string, status: string, uuid?: string) =>
        status === 'consumed' && uuid !== undefined && consumedFollowUpUuids.has(uuid)
          ? { dbId: 'db-consumed' }
          : null
      ),
      getSDKMessageRepo: mock(() => ({
        runWrite: mock(async () => revokedPendingMessage),
      })),
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
      spaceSessions: {
        queryStartGuard: () => undefined,
        workflowRunIdForSession: (sessionId: string) => boundRunIds.get(sessionId),
      },
    } as unknown as Database;

    return new AgentSession(
      session,
      db,
      { event: mock(() => {}) } as unknown as MessageHub,
      {
        publish: publishSpy,
        publishAsync: publishSpy,
        subscribe: mock(
          (
            event: string,
            handler: (data: Record<string, unknown>) => void,
            _: { subscriberName: string }
          ) => {
            const list = eventSubscribers.get(event) ?? [];
            list.push(handler);
            eventSubscribers.set(event, list);
            return () => {};
          }
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
    eventSubscribers = new Map();
    boundRunIds = new Map([['requery-session-id', 'run-1']]);
    activeDeliveryUuids = new Set();
    consumedFollowUpUuids = new Set();
    revokedPendingMessage = null;
    enqueueSpy = mock(async () => {});
    publishSpy = mock(async (_event?: unknown) => ({ delivered: 1, failures: [] }));
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
      true,
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

  it('closes a self-recovered episode so the next hollow fault gets a fresh budget', async () => {
    for (let i = 0; i < TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS; i++) {
      await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
      await settleRequery();
      await agentSession.onSDKMessage(buildRealSuccessResult());
      await settleRequery();
    }
    expect(continueCalls()).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
    expect(needsAttentionPublishes()).toBe(0);
    expect(agentSession.getSessionData().metadata.taskNotificationRequeryEpisode).toMatchObject({
      closed: true,
    });

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS + 1);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('five failures escalate once, and later failures still hold after a restart', async () => {
    for (let i = 0; i < TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS + 1; i++) {
      await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
      await settleRequery();
    }
    expect(needsAttentionPublishes()).toBe(1);
    expect(agentSession.getSessionData().metadata.taskNotificationRequeryEpisode).toMatchObject({
      attempts: TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
      escalation: 'done',
    });

    const restarted = createRequerySession({
      context: { spaceId: 'space-1', taskId: 'task-1' },
      metadata: { ...agentSession.getSessionData().metadata },
    });
    try {
      armLiveQuery(restarted);
      await restarted.onSDKMessage(buildHollowTaskNotificationResult());
      await settleRequery();
      expect(continueCalls()).toBe(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
      expect(needsAttentionPublishes()).toBe(1);
    } finally {
      (
        restarted as unknown as { clearTaskNotificationRequeryTimer: () => void }
      ).clearTaskNotificationRequeryTimer();
      restarted.queryPromise = null;
      restarted.messageQueue.stop();
    }
  });

  it('closes the episode when the owning task retry is recorded', async () => {
    const episodeOf = () =>
      (agentSession as unknown as { taskNotificationRequeryEpisode: unknown })
        .taskNotificationRequeryEpisode as TaskNotificationRequeryEpisode | null;
    (
      agentSession as unknown as { taskNotificationRequeryEpisode: unknown }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(5, 'done');

    fireInternalEvent('space.workflowRun.retry', {
      spaceId: 'space-1',
      taskId: 'other-task',
      runId: 'run-1',
      originalReason: 'blocked',
      attemptNumber: 1,
      maxAttempts: 3,
      timestamp: new Date().toISOString(),
    });
    expect(episodeOf()?.closed).toBe(false);

    fireInternalEvent('space.workflowRun.retry', {
      spaceId: 'space-1',
      taskId: 'task-1',
      runId: 'run-1',
      originalReason: 'blocked',
      attemptNumber: 1,
      maxAttempts: 3,
      timestamp: new Date().toISOString(),
    });
    expect(episodeOf()?.closed).toBe(true);
  });

  it('closes the episode on a terminal task update or the bound run completing', async () => {
    const episodeOf = () =>
      (agentSession as unknown as { taskNotificationRequeryEpisode: unknown })
        .taskNotificationRequeryEpisode as TaskNotificationRequeryEpisode | null;
    (
      agentSession as unknown as { taskNotificationRequeryEpisode: unknown }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(5, 'done');

    fireInternalEvent('space.task.updated', {
      spaceId: 'space-1',
      taskId: 'task-1',
      task: { id: 'task-1', status: 'in_progress' },
    });
    expect(episodeOf()?.closed).toBe(false);

    fireInternalEvent('space.task.updated', {
      spaceId: 'space-1',
      taskId: 'task-1',
      task: { id: 'task-1', status: 'done' },
    });
    expect(episodeOf()?.closed).toBe(true);

    (
      agentSession as unknown as { taskNotificationRequeryEpisode: unknown }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(5, 'done');

    fireInternalEvent('space.workflowRun.completed', {
      spaceId: 'space-1',
      runId: 'other-run',
      status: 'done',
      timestamp: new Date().toISOString(),
    });
    expect(episodeOf()?.closed).toBe(false);

    fireInternalEvent('space.workflowRun.completed', {
      spaceId: 'space-1',
      runId: 'run-1',
      status: 'done',
      timestamp: new Date().toISOString(),
    });
    expect(episodeOf()?.closed).toBe(true);
  });

  it('disarms the armed requery when the episode closes mid-backoff', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '200';
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 30));

    fireInternalEvent('space.task.updated', {
      spaceId: 'space-1',
      taskId: 'task-1',
      task: { id: 'task-1', status: 'done' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
    expect(agentSession.getSessionData().metadata.taskNotificationRequeryEpisode).toMatchObject({
      closed: true,
    });
  });

  it('keeps the episode when an unbound session sees an unrelated run complete', async () => {
    boundRunIds.delete('requery-session-id');
    const episodeOf = () =>
      (agentSession as unknown as { taskNotificationRequeryEpisode: unknown })
        .taskNotificationRequeryEpisode as TaskNotificationRequeryEpisode | null;
    (
      agentSession as unknown as { taskNotificationRequeryEpisode: unknown }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(5, 'done');

    fireInternalEvent('space.workflowRun.completed', {
      spaceId: 'space-1',
      runId: 'run-1',
      status: 'done',
      timestamp: new Date().toISOString(),
    });
    expect(episodeOf()?.closed).toBe(false);

    fireInternalEvent('space.workflowRun.reopened', {
      spaceId: 'space-1',
      runId: 'run-1',
      fromStatus: 'done',
      reason: 'retry',
      by: 'operator',
      timestamp: new Date().toISOString(),
    });
    expect(episodeOf()?.closed).toBe(false);
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
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(2);

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
    await new Promise((resolve) => setTimeout(resolve, 650));
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
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(2);

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
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode
    ).toMatchObject({ attempts: 2, closed: false });
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

  it('keeps arming episodes after a post-Stop restart', async () => {
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    agentSession.onInterruptRequested();
    (
      agentSession as unknown as { incrementQueryGeneration: () => number }
    ).incrementQueryGeneration();

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
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

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
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

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

  it('re-parks the episode while rate-limit recovery is pending', async () => {
    const isRecoveryPending = mock(() => true);
    (
      agentSession as unknown as {
        rateLimitWatchdog: { isRecoveryPending: typeof isRecoveryPending };
      }
    ).rateLimitWatchdog = { isRecoveryPending };

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    isRecoveryPending.mockImplementation(() => false);
    await agentSession.stateManager.setIdle();
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('probes parked episodes after limit recovery is cancelled without an idle transition', async () => {
    const isRecoveryPending = mock(() => true);
    (
      agentSession as unknown as {
        rateLimitWatchdog: { isRecoveryPending: typeof isRecoveryPending };
      }
    ).rateLimitWatchdog = { isRecoveryPending };

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    isRecoveryPending.mockImplementation(() => false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(continueCalls()).toBe(1);
  });

  it('surfaces a session error when the needs-attention event has no subscriber', async () => {
    publishSpy.mockImplementation(async () => ({ delivered: 0, failures: [] }));
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);
    expect(
      publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')
    ).toBeDefined();
  });

  it('probes pending episodes parked by a recovery-pending flush', async () => {
    const isRecoveryPending = mock(() => true);
    (
      agentSession as unknown as {
        rateLimitWatchdog: { isRecoveryPending: typeof isRecoveryPending };
      }
    ).rateLimitWatchdog = { isRecoveryPending };
    activeDeliveryUuids.add('queued-follow-up-uuid');

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.stateManager.setIdle();
    await settleRequery();
    expect(continueCalls()).toBe(0);

    isRecoveryPending.mockImplementation(() => false);
    activeDeliveryUuids.clear();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(continueCalls()).toBe(1);
  });

  it('rechecks the SDK-busy latch after the dead-query restart', async () => {
    let sentBusy = false;
    const ensureQueryStarted = mock(async () => {
      if (!sentBusy) {
        sentBusy = true;
        await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
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

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('suppresses episodes after an interrupt lands on a yielded continuation', async () => {
    enqueueSpy = mock(() => new Promise<void>(() => {}));
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof enqueueSpy }).enqueueWithId =
      enqueueSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    await agentSession.handleInterrupt();
    expect(agentSession.messageQueue.isRunning()).toBe(false);
    agentSession.queryPromise = null;
    agentSession.messageQueue.start();
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    (
      agentSession as unknown as { incrementQueryGeneration: () => number }
    ).incrementQueryGeneration();
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(2);
  });

  it('parks the episode without consuming budget while transcript recovery awaits input', async () => {
    const ensureQueryStarted = mock(async () => 'blocked' as const);
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
    expect(
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode?.attempts
    ).toBe(0);
  });

  it('surfaces a session error when needs-attention publishing rejects', async () => {
    publishSpy.mockImplementation(async (event?: unknown) => {
      if (event === 'space.workflowRun.needsAttention') {
        throw new Error('bus boom');
      }
      return { delivered: 1, failures: [] };
    });
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);
    expect(
      publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')
    ).toBeDefined();
  });

  it('consumes the parked flag when a recovery probe delivers the continuation', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    const isRecoveryPending = mock(() => true);
    (
      agentSession as unknown as {
        rateLimitWatchdog: { isRecoveryPending: typeof isRecoveryPending };
      }
    ).rateLimitWatchdog = { isRecoveryPending };

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    isRecoveryPending.mockImplementation(() => false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(continueCalls()).toBe(1);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(continueCalls()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(continueCalls()).toBe(2);
  });

  it('discards observations that outlive their query generation', async () => {
    const handleMessage = mock(async () => {
      (
        agentSession as unknown as { incrementQueryGeneration: () => number }
      ).incrementQueryGeneration();
    });
    (
      agentSession.messageHandler as unknown as { handleMessage: typeof handleMessage }
    ).handleMessage = handleMessage;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('resets the episode when the circuit breaker stops the session', async () => {
    enqueueSpy = mock(() => new Promise<void>(() => {}));
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof enqueueSpy }).enqueueWithId =
      enqueueSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode?.attempts
    ).toBe(1);

    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();
    await (
      agentSession.messageHandler as unknown as {
        handleCircuitBreakerTrip: (reason: string, userMessage: string) => Promise<void>;
      }
    ).handleCircuitBreakerTrip('error loop', 'too many consecutive errors');

    expect(
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode
    ).toMatchObject({ closed: false });
  });

  it('re-parks a scheduled retry when the SDK turns busy during the backoff', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(1);

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

  it('clears the SDK-busy latch when the delivering query settles without idle', async () => {
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

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    holder.resolve?.();
    agentSession.queryPromise = null;
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(2);
  });

  it('does not re-arm settlement recovery after escalation', async () => {
    const holder: { resolve?: () => void } = {};
    agentSession.queryPromise = new Promise<void>((resolve) => {
      holder.resolve = resolve;
    });
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);

    holder.resolve?.();
    agentSession.queryPromise = null;
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);
    expect(continueCalls()).toBe(0);
  });

  it('latches the SDK-busy protocol before awaiting message subscribers', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(1);
    const originalHandler = (agentSession.messageHandler as unknown as { handleMessage: unknown })
      .handleMessage;
    const holder: { release?: () => void } = {};
    (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage = async (message: SDKMessage) => {
      if (
        (message as { subtype?: string }).subtype === 'session_state_changed' &&
        (message as { state?: string }).state === 'busy'
      ) {
        await new Promise<void>((resolve) => {
          holder.release = resolve;
        });
        return;
      }
      await (originalHandler as (m: SDKMessage) => Promise<void>).call(
        agentSession.messageHandler,
        message
      );
    };

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    const busyDone = agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(continueCalls()).toBe(0);

    holder.release?.();
    await busyDone;
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('skips the fallback when the target space acknowledges the escalation', async () => {
    publishSpy.mockImplementation(
      async (event?: unknown, payload?: { handledBySpaceService?: boolean }) => {
        if (event === 'space.workflowRun.needsAttention' && payload) {
          payload.handledBySpaceService = true;
        }
        return { delivered: 1, failures: [] };
      }
    );
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);
    expect(publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')).toBe(
      undefined
    );
  });

  it('releases protocol latches when the owning query settles before delivery', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    const ensureQueryStarted = mock(async () => 'started' as const);
    (
      agentSession as unknown as {
        lifecycleManager: { ensureQueryStarted: typeof ensureQueryStarted };
      }
    ).lifecycleManager = { ensureQueryStarted };
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(1);
    const holder: { resolve?: () => void } = {};
    agentSession.queryPromise = new Promise<void>((resolve) => {
      holder.resolve = resolve;
    });

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    holder.resolve?.();
    agentSession.queryPromise = null;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(continueCalls()).toBe(1);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('attaches the settlement watcher to directly parked episodes', async () => {
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

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    holder.resolve?.();
    agentSession.queryPromise = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(1);
  });

  it('cancels the escalation when the episode resets before the publish resolves', async () => {
    publishSpy.mockImplementation(async (event?: unknown, payload?: Record<string, unknown>) => {
      if (event === 'space.workflowRun.needsAttention') {
        agentSession.resetTaskNotificationRequery();
        if (payload) payload.handledBySpaceService = false;
      }
      return { delivered: 1, failures: [] };
    });
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(needsAttentionPublishes()).toBe(1);
    expect(publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')).toBe(
      undefined
    );
  });

  it('skips the escalation fallback when a reset lands during a rejecting publish', async () => {
    publishSpy.mockImplementation(async (event?: unknown) => {
      if (event === 'space.workflowRun.needsAttention') {
        agentSession.resetTaskNotificationRequery();
        throw new Error('bus boom');
      }
      return { delivered: 1, failures: [] };
    });
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(needsAttentionPublishes()).toBe(1);
    expect(publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')).toBe(
      undefined
    );
  });

  it('watches held follow-up episodes for query settlement', async () => {
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
    activeDeliveryUuids.add('queued-follow-up-uuid');

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    holder.resolve?.();
    agentSession.queryPromise = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(continueCalls()).toBe(0);
    expect(ensureQueryStarted.mock.calls.length).toBe(0);

    activeDeliveryUuids.clear();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(ensureQueryStarted.mock.calls.length).toBe(1);
    expect(continueCalls()).toBe(1);
  });

  it('observes real results before flushing pending continuations', async () => {
    activeDeliveryUuids.add('queued-follow-up-uuid');
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);

    const originalHandler = (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage;
    (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage = async (message: SDKMessage) => {
      await (originalHandler as (m: SDKMessage) => Promise<void>).call(
        agentSession.messageHandler,
        message
      );
      if ((message as { type?: string }).type === 'result') {
        await agentSession.stateManager.setIdle();
      }
    };

    await agentSession.onSDKMessage(buildRealSuccessResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('suppresses the fallback publication when the episode resets inside handleError', async () => {
    publishSpy.mockImplementation(async (event?: unknown) => {
      if (event === 'space.workflowRun.needsAttention') {
        throw new Error('bus boom');
      }
      return { delivered: 1, failures: [] };
    });
    const errorManagerRef = agentSession.errorManager as unknown as {
      handleError: (...args: unknown[]) => Promise<unknown>;
    };
    const originalHandleError = errorManagerRef.handleError.bind(agentSession.errorManager);
    errorManagerRef.handleError = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      agentSession.resetTaskNotificationRequery();
      return originalHandleError(...args);
    };
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(needsAttentionPublishes()).toBe(1);
    expect(publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')).toBe(
      undefined
    );
  });

  it('marks the escalation done when the token moves during the publish', async () => {
    publishSpy.mockImplementation(async (event?: unknown, payload?: Record<string, unknown>) => {
      if (event === 'space.workflowRun.needsAttention') {
        (
          agentSession as unknown as { taskNotificationRequeryEpisodeToken: number }
        ).taskNotificationRequeryEpisodeToken += 1;
        if (payload) payload.handledBySpaceService = true;
      }
      return { delivered: 1, failures: [] };
    });
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);
    expect(agentSession.getSessionData().metadata.taskNotificationRequeryEpisode).toMatchObject({
      escalation: 'done',
    });
  });

  it('counts one attempt when a counted continuation fails to deliver', async () => {
    let enqueueCalls = 0;
    enqueueSpy = mock(async () => {
      enqueueCalls += 1;
      if (enqueueCalls === 1) throw new Error('enqueue boom');
    });
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof enqueueSpy }).enqueueWithId =
      enqueueSpy;

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(continueCalls()).toBe(2);
    expect(
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode?.attempts
    ).toBe(2);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('does not rewrite identical episode metadata on a held result', async () => {
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(
      TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS,
      'done'
    );
    const updateSessionSpy = (
      agentSession as unknown as { db: { updateSession: ReturnType<typeof mock> } }
    ).db.updateSession;
    const episodeWrites = () =>
      updateSessionSpy.mock.calls.filter(
        (call: unknown[]) =>
          (call[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata?.[
            'taskNotificationRequeryEpisode'
          ] !== undefined
      ).length;
    const writesBefore = episodeWrites();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();

    expect(episodeWrites()).toBe(writesBefore);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('writes no episode metadata for an ordinary result without an open episode', async () => {
    const updateSessionSpy = (
      agentSession as unknown as { db: { updateSession: ReturnType<typeof mock> } }
    ).db.updateSession;
    const episodeWrites = () =>
      updateSessionSpy.mock.calls.filter(
        (call: unknown[]) =>
          (call[1] as { metadata?: Record<string, unknown> } | undefined)?.metadata?.[
            'taskNotificationRequeryEpisode'
          ] !== undefined
      ).length;
    const writesBefore = episodeWrites();

    await agentSession.onSDKMessage(buildRealSuccessResult());
    await settleRequery();

    expect(episodeWrites()).toBe(writesBefore);
    expect(
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode
    ).toBeNull();
  });

  it('invalidates the episode during cleanup instead of escalating from teardown', async () => {
    enqueueSpy = mock(() => new Promise<void>(() => {}));
    (agentSession.messageQueue as unknown as { enqueueWithId: typeof enqueueSpy }).enqueueWithId =
      enqueueSpy;
    (
      agentSession as unknown as {
        lifecycleManager: { cleanup: () => Promise<void> };
      }
    ).lifecycleManager = {
      cleanup: async () => {
        (agentSession as unknown as { setCleaningUp: (v: boolean) => void }).setCleaningUp(true);
      },
    };

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    await agentSession.cleanup();
    expect(
      (
        agentSession as unknown as {
          taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
        }
      ).taskNotificationRequeryEpisode
    ).toMatchObject({ closed: false });
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(0);
    expect(publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')).toBe(
      undefined
    );
  });

  it('keeps result-observation suppression scoped per in-flight handler', async () => {
    activeDeliveryUuids.add('queued-follow-up-uuid');
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();

    const holder: { release?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      holder.release = resolve;
    });
    const originalHandler = (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage;
    (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage = async (message: SDKMessage) => {
      if ((message as { uuid?: string }).uuid === 'old-gen-result') {
        await gate;
        return;
      }
      await (originalHandler as (m: SDKMessage) => Promise<void>).call(
        agentSession.messageHandler,
        message
      );
    };

    const oldGen = {
      ...buildRealSuccessResult(),
      uuid: 'old-gen-result',
    } as unknown as SDKMessage;
    const oldCall = agentSession.onSDKMessage(oldGen);
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await agentSession.onSDKMessage(buildRealSuccessResult());
    await settleRequery();
    holder.release?.();
    await oldCall;
    expect(continueCalls()).toBe(0);
  });

  it('observes a real result even when an sdk.message subscriber rejects', async () => {
    activeDeliveryUuids.add('queued-follow-up-uuid');
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);

    const originalHandler = (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage;
    (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage = async (message: SDKMessage) => {
      await (originalHandler as (m: SDKMessage) => Promise<void>).call(
        agentSession.messageHandler,
        message
      );
      if ((message as { type?: string }).type === 'result') {
        throw new Error('subscriber boom');
      }
    };

    await expect(agentSession.onSDKMessage(buildRealSuccessResult())).rejects.toThrow(
      'subscriber boom'
    );
    await settleRequery();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('flushes the surviving episode when the stale handler releases the last guard', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    const originalHandler = (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage;
    const oldHolder: { release?: () => void } = {};
    const oldGate = new Promise<void>((resolve) => {
      oldHolder.release = resolve;
    });
    (
      agentSession.messageHandler as unknown as { handleMessage: (m: SDKMessage) => Promise<void> }
    ).handleMessage = async (message: SDKMessage) => {
      if ((message as { uuid?: string }).uuid === 'old-gen-result') {
        await oldGate;
        return;
      }
      await (originalHandler as (m: SDKMessage) => Promise<void>).call(
        agentSession.messageHandler,
        message
      );
    };

    const oldCall = agentSession.onSDKMessage({
      ...buildRealSuccessResult(),
      uuid: 'old-gen-result',
    } as unknown as SDKMessage);
    (
      agentSession as unknown as { incrementQueryGeneration: () => number }
    ).incrementQueryGeneration();
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(1);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('busy'));
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(continueCalls()).toBe(0);

    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    oldHolder.release?.();
    await oldCall;
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('routes interrupts through the real path while an acknowledged continuation runs', async () => {
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(1);

    expect(agentSession.messageQueue.isRunning()).toBe(true);
    await agentSession.handleInterrupt();
    expect(agentSession.messageQueue.isRunning()).toBe(false);
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
    expect(needsAttentionPublishes()).toBe(0);
  });

  it('honours a successful space delivery despite partial publish failure', async () => {
    publishSpy.mockImplementation(
      async (event?: unknown, payload?: { handledBySpaceService?: boolean }) => {
        if (event === 'space.workflowRun.needsAttention') {
          if (payload) payload.handledBySpaceService = true;
          throw new Error('other subscriber boom');
        }
        return { delivered: 1, failures: [] };
      }
    );
    (
      agentSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(needsAttentionPublishes()).toBe(1);
    expect(publishSpy.mock.calls.find(([event]: [string]) => event === 'session.error')).toBe(
      undefined
    );
  });

  it('re-parks when limit recovery starts during the dead-query restart', async () => {
    let recoveryPending = false;
    let restartedOnce = false;
    const ensureQueryStarted = mock(async () => {
      if (!restartedOnce) {
        restartedOnce = true;
        recoveryPending = true;
      }
      return 'started' as const;
    });
    (
      agentSession as unknown as {
        lifecycleManager: {
          ensureQueryStarted: typeof ensureQueryStarted;
          executeDeferredRestartIfPending: () => Promise<void>;
        };
      }
    ).lifecycleManager = {
      ensureQueryStarted,
      executeDeferredRestartIfPending: async () => {},
    };
    (
      agentSession as unknown as {
        rateLimitWatchdog: { isRecoveryPending: () => boolean };
      }
    ).rateLimitWatchdog = { isRecoveryPending: () => recoveryPending };
    agentSession.queryPromise = null;
    agentSession.messageQueue.stop();

    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await settleRequery();
    expect(continueCalls()).toBe(0);
    expect(ensureQueryStarted.mock.calls.length).toBe(1);

    recoveryPending = false;
    await agentSession.onSDKMessage(buildSessionStateChangedMessage('idle'));
    await settleRequery();
    expect(continueCalls()).toBe(1);
  });

  it('clears a pending re-query timer when the user interrupts', async () => {
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '500';
    await agentSession.onSDKMessage(buildHollowTaskNotificationResult());
    await new Promise((resolve) => setTimeout(resolve, 650));
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
      detachedSession as unknown as {
        taskNotificationRequeryEpisode: TaskNotificationRequeryEpisode | null;
      }
    ).taskNotificationRequeryEpisode = openRequeryEpisode(TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS);
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
