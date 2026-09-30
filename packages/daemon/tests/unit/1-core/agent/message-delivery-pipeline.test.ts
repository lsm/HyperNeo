import { describe, expect, test } from 'bun:test';
import {
  planInjectContextReset,
  planTurnEndFlushContextReset,
} from '../../../../src/lib/agent/context-reset-planner';
import {
  classifyInjectDelivery,
  decideInjectDelivery,
  decideReconcileAdmission,
  decideTurnEndFlush,
  gateDeferredAdmission,
  gateDeliveryNotConsumed,
  gateFlushHasMessages,
  type InjectDeliveryDecision,
  type InjectDeliveryInput,
  selectStrandedDeliveries,
  shouldReopenFailedDelivery,
  type TurnEndFlushInput,
  type TurnEndFlushPlan,
} from '../../../../src/lib/agent/message-delivery-pipeline';
import {
  decideDeferAdmission,
  type FlushMessage,
  planFlushDelivery,
} from '../../../../src/lib/agent/message-ownership-gates';
import {
  decideReconcileAdmission as coreDecideReconcileAdmission,
  selectStrandedDeliveries as coreSelectStrandedDeliveries,
} from '../../../../src/lib/agent/turn-outcome-classification';

function makeInjectInput(overrides: Partial<InjectDeliveryInput> = {}): InjectDeliveryInput {
  return {
    existingSendStatus: null,
    deliveryMode: 'immediate',
    isBusy: false,
    inRateLimitCooldown: false,
    parentTaskLimited: false,
    inputKind: 'task',
    hasPriorContext: true,
    slotResetsContext: true,
    hasActiveDeliveryJob: false,
    hasUnconsumedDeliveredWork: false,
    ...overrides,
  };
}

function makeFlushMessage(overrides: Partial<FlushMessage> = {}): FlushMessage {
  return {
    uuid: 'uuid-1',
    dbId: 'db-1',
    isUserMessage: true,
    isTaskInput: true,
    flattenedText: 'hello',
    ...overrides,
  };
}

function makeFlushInput(overrides: Partial<TurnEndFlushInput> = {}): TurnEndFlushInput {
  return {
    messages: [
      makeFlushMessage({ uuid: 'a' }),
      makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
    ],
    activeInJobQueue: new Set<string>(),
    slotResetsContext: true,
    hasPriorContext: true,
    pendingTaskInput: false,
    ...overrides,
  };
}

describe('message inject delivery decision pipeline', () => {
  const cases: Array<[string, Partial<InjectDeliveryInput>, InjectDeliveryDecision]> = [
    [
      'an already-consumed delivery is a no-op',
      { existingSendStatus: 'consumed' },
      { action: 'noop' },
    ],
    ['defer mode while busy defers', { deliveryMode: 'defer', isBusy: true }, { action: 'defer' }],
    ['a rate-limit cooldown defers', { inRateLimitCooldown: true }, { action: 'defer' }],
    ['a limited parent task defers', { parentTaskLimited: true }, { action: 'defer' }],
    [
      'a non-task input delivers without clear',
      { inputKind: 'steer' },
      { action: 'deliver_without_clear', reason: 'not_task_input' },
    ],
    [
      'a busy session delivers without clear',
      { isBusy: true },
      { action: 'deliver_without_clear', reason: 'session_busy' },
    ],
    [
      'a session without prior context delivers without clear',
      { hasPriorContext: false },
      { action: 'deliver_without_clear', reason: 'no_prior_context' },
    ],
    [
      'a slot that does not reset context delivers without clear',
      { slotResetsContext: false },
      { action: 'deliver_without_clear', reason: 'slot_not_reset' },
    ],
    [
      'an active delivery job delivers without clear',
      { hasActiveDeliveryJob: true },
      { action: 'deliver_without_clear', reason: 'delivery_job_active' },
    ],
    [
      'unconsumed delivered work delivers without clear (#1085)',
      { hasUnconsumedDeliveredWork: true },
      { action: 'deliver_without_clear', reason: 'unconsumed_work_pending' },
    ],
    [
      'a fresh task input on a reset slot clears before delivery',
      {},
      { action: 'clear_before_deliver' },
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    test(label, () => {
      expect(decideInjectDelivery(makeInjectInput(overrides)).decision).toEqual(expected);
    });
  }

  test('a failed delivery is annotated for reopen and still delivers', () => {
    const outcome = decideInjectDelivery(makeInjectInput({ existingSendStatus: 'failed' }));
    expect(outcome.reopenFailedDelivery).toBe(true);
    expect(outcome.decision).toEqual({ action: 'clear_before_deliver' });
  });

  test('a non-failed delivery never requests a reopen', () => {
    for (const status of [null, 'consumed', 'deferred', 'enqueued', 'submitted'] as const) {
      expect(
        decideInjectDelivery(makeInjectInput({ existingSendStatus: status })).reopenFailedDelivery
      ).toBe(false);
    }
  });

  describe('gate precedence — first decision wins', () => {
    test('consumed beats defer admission and context reset', () => {
      const decision = decideInjectDelivery(
        makeInjectInput({
          existingSendStatus: 'consumed',
          deliveryMode: 'defer',
          isBusy: true,
          inRateLimitCooldown: true,
          parentTaskLimited: true,
          hasActiveDeliveryJob: true,
        })
      );
      expect(decision.decision).toEqual({ action: 'noop' });
      expect(decision.reopenFailedDelivery).toBe(false);
    });

    test('failed reopen annotation survives a defer decision', () => {
      const decision = decideInjectDelivery(
        makeInjectInput({
          existingSendStatus: 'failed',
          deliveryMode: 'defer',
          isBusy: true,
        })
      );
      expect(decision.decision).toEqual({ action: 'defer' });
      expect(decision.reopenFailedDelivery).toBe(true);
    });

    test('defer admission beats the context-reset gate', () => {
      const decision = decideInjectDelivery(
        makeInjectInput({
          deliveryMode: 'defer',
          isBusy: true,
          inputKind: 'steer',
          hasActiveDeliveryJob: true,
        })
      );
      expect(decision.decision).toEqual({ action: 'defer' });
    });

    test('the context-reset gate beats the final arbiter', () => {
      const decision = decideInjectDelivery(makeInjectInput({ inputKind: 'steer' }));
      expect(decision.decision).toEqual({
        action: 'deliver_without_clear',
        reason: 'not_task_input',
      });
    });
  });

  describe('admission gates', () => {
    test('a consumed delivery admits nothing further', () => {
      expect(gateDeliveryNotConsumed(makeInjectInput({ existingSendStatus: 'consumed' }))).toEqual({
        reason: { action: 'noop' },
      });
    });

    test('a non-consumed delivery passes through', () => {
      for (const status of ['failed', 'deferred', null] as const) {
        const input = makeInjectInput({ existingSendStatus: status });
        expect(gateDeliveryNotConsumed(input)).toEqual({ value: input });
      }
    });

    test('a deferred admission rejects with defer', () => {
      expect(
        gateDeferredAdmission(makeInjectInput({ deliveryMode: 'defer', isBusy: true }))
      ).toEqual({ reason: { action: 'defer' } });
    });

    test('an admitted delivery passes through', () => {
      for (const overrides of [
        { deliveryMode: 'defer' as const, isBusy: false },
        { deliveryMode: 'immediate' as const, isBusy: true },
      ]) {
        const input = makeInjectInput(overrides);
        expect(gateDeferredAdmission(input)).toEqual({ value: input });
      }
    });

    test('the failed-reopen flag follows the persisted status, not the cascade', () => {
      expect(shouldReopenFailedDelivery(makeInjectInput({ existingSendStatus: 'failed' }))).toBe(
        true
      );
      expect(shouldReopenFailedDelivery(makeInjectInput({ existingSendStatus: 'consumed' }))).toBe(
        false
      );
      expect(shouldReopenFailedDelivery(makeInjectInput({ existingSendStatus: null }))).toBe(false);
    });
  });

  describe('classification delegates to the core planners', () => {
    test('the inject decision matches the deciding core function for every table row', () => {
      for (const [, overrides] of cases) {
        const input = makeInjectInput(overrides);
        const admission = decideDeferAdmission({
          deliveryMode: input.deliveryMode,
          isBusy: input.isBusy,
          inRateLimitCooldown: input.inRateLimitCooldown,
          parentTaskLimited: input.parentTaskLimited,
        });
        const reset = planInjectContextReset({
          inputKind: input.inputKind,
          isBusy: input.isBusy,
          hasPriorContext: input.hasPriorContext,
          slotResetsContext: input.slotResetsContext,
          hasActiveDeliveryJob: input.hasActiveDeliveryJob,
          hasUnconsumedDeliveredWork: input.hasUnconsumedDeliveredWork,
        });
        const coreExpected =
          input.existingSendStatus === 'consumed'
            ? ({ action: 'noop' } as InjectDeliveryDecision)
            : admission.action === 'defer'
              ? admission
              : reset;
        expect(decideInjectDelivery(input).decision).toEqual(coreExpected);
      }
    });

    test('the classifier returns the core plan verbatim', () => {
      for (const overrides of [
        {},
        { inputKind: 'steer' },
        { isBusy: true },
        { hasActiveDeliveryJob: true },
        { hasUnconsumedDeliveredWork: true },
      ] as Partial<InjectDeliveryInput>[]) {
        const input = makeInjectInput(overrides);
        expect(classifyInjectDelivery(input)).toEqual(
          planInjectContextReset({
            inputKind: input.inputKind,
            isBusy: input.isBusy,
            hasPriorContext: input.hasPriorContext,
            slotResetsContext: input.slotResetsContext,
            hasActiveDeliveryJob: input.hasActiveDeliveryJob,
            hasUnconsumedDeliveredWork: input.hasUnconsumedDeliveredWork,
          })
        );
      }
    });
  });
});

describe('message turn-end flush decision pipeline', () => {
  const cases: Array<[string, Partial<TurnEndFlushInput>, TurnEndFlushPlan]> = [
    ['an empty queue is a noop', { messages: [] }, { action: 'noop' }],
    [
      'a queue where every message is owned is a noop',
      {
        messages: [makeFlushMessage({ uuid: 'job-owned' })],
        activeInJobQueue: new Set(['job-owned']),
      },
      { action: 'noop' },
    ],
    [
      'two deliverable messages on a non-reset slot flush without a context clear',
      { slotResetsContext: false },
      {
        action: 'each',
        deliver: ['a', 'b'],
        skip: [],
        contextReset: { action: 'flush_without_clear' },
      },
    ],
    [
      'deliverables on a reset slot plan exactly one clear ahead of the flush (#1085)',
      {},
      {
        action: 'each',
        deliver: ['a', 'b'],
        skip: [],
        contextReset: { action: 'clear_then_flush' },
      },
    ],
    [
      'owned and non-user messages are skipped alongside per-message delivery',
      {
        slotResetsContext: false,
        messages: [
          makeFlushMessage({ uuid: 'job-owned' }),
          makeFlushMessage({ uuid: 'assistant', isUserMessage: false, flattenedText: null }),
          makeFlushMessage({ uuid: 'a' }),
          makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
        ],
        activeInJobQueue: new Set(['job-owned']),
      },
      {
        action: 'each',
        deliver: ['a', 'b'],
        skip: [
          { uuid: 'job-owned', ownership: 'job_queue' },
          { uuid: 'assistant', ownership: 'not_user_message' },
        ],
        contextReset: { action: 'flush_without_clear' },
      },
    ],
    [
      'a single deliverable message is delivered per message',
      {
        slotResetsContext: false,
        messages: [makeFlushMessage({ uuid: 'solo' })],
      },
      {
        action: 'each',
        deliver: ['solo'],
        skip: [],
        contextReset: { action: 'flush_without_clear' },
      },
    ],
    [
      'a slash command forces per-message delivery',
      {
        slotResetsContext: false,
        messages: [
          makeFlushMessage({ uuid: 'slash', flattenedText: '/compact' }),
          makeFlushMessage({ uuid: 'plain', flattenedText: 'hello' }),
        ],
      },
      {
        action: 'each',
        deliver: ['slash', 'plain'],
        skip: [],
        contextReset: { action: 'flush_without_clear' },
      },
    ],
    [
      'a slash-command flush on a reset slot still plans one clear ahead of per-message delivery',
      {
        messages: [
          makeFlushMessage({ uuid: 'slash', flattenedText: '/compact' }),
          makeFlushMessage({ uuid: 'plain', flattenedText: 'hello' }),
        ],
      },
      {
        action: 'each',
        deliver: ['slash', 'plain'],
        skip: [],
        contextReset: { action: 'clear_then_flush' },
      },
    ],
    [
      'human-only deliverables on a reset slot flush without a clear',
      {
        messages: [
          makeFlushMessage({ uuid: 'human-1', isTaskInput: false }),
          makeFlushMessage({ uuid: 'human-2', isTaskInput: false, flattenedText: 'follow-up' }),
        ],
      },
      {
        action: 'each',
        deliver: ['human-1', 'human-2'],
        skip: [],
        contextReset: { action: 'flush_without_clear' },
      },
    ],
    [
      'a mixed human and task batch plans one clear ahead of the batch',
      {
        messages: [
          makeFlushMessage({ uuid: 'human-1', isTaskInput: false }),
          makeFlushMessage({ uuid: 'task-1', flattenedText: 'handoff' }),
        ],
      },
      {
        action: 'each',
        deliver: ['human-1', 'task-1'],
        skip: [],
        contextReset: { action: 'clear_then_flush' },
      },
    ],
    [
      'a session without prior context flushes without a clear on the first turn',
      { hasPriorContext: false },
      {
        action: 'each',
        deliver: ['a', 'b'],
        skip: [],
        contextReset: { action: 'flush_without_clear' },
      },
    ],
    [
      'an active delivery job suppresses the flush clear and defers the reset',
      { activeInJobQueue: new Set(['uuid-active']) },
      {
        action: 'each',
        deliver: ['a', 'b'],
        skip: [],
        contextReset: { action: 'flush_without_clear', reason: 'active_delivery_job' },
      },
    ],
    [
      'a pending task input behind a human-only backlog plans one clear ahead of the flush',
      {
        messages: [
          makeFlushMessage({ uuid: 'human-1', isTaskInput: false }),
          makeFlushMessage({ uuid: 'human-2', isTaskInput: false, flattenedText: 'follow-up' }),
        ],
        pendingTaskInput: true,
      },
      {
        action: 'each',
        deliver: ['human-1', 'human-2'],
        skip: [],
        contextReset: { action: 'clear_then_flush' },
      },
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    test(label, () => {
      expect(decideTurnEndFlush(makeFlushInput(overrides))).toEqual(expected);
    });
  }

  describe('gate precedence — first decision wins', () => {
    test('the empty gate beats the ownership gate', () => {
      const plan = decideTurnEndFlush(
        makeFlushInput({
          messages: [],
          activeInJobQueue: new Set(['ghost']),
        })
      );
      expect(plan).toEqual({ action: 'noop' });
    });
  });

  describe('flush admission and classification', () => {
    test('an empty queue is rejected as a noop before anything is planned', () => {
      expect(gateFlushHasMessages(makeFlushInput({ messages: [] }))).toEqual({
        reason: { action: 'noop' },
      });
    });

    test('a non-empty queue passes through', () => {
      const input = makeFlushInput({});
      expect(gateFlushHasMessages(input)).toEqual({ value: input });
    });

    test('the flush plan is the core delivery plan annotated with the core context reset', () => {
      for (const [, overrides] of cases) {
        const input = makeFlushInput(overrides);
        const core = planFlushDelivery({
          messages: input.messages,
          activeInJobQueue: input.activeInJobQueue,
        });
        const deliverables = core.action === 'each' ? core.deliver : [];
        const deliverableSet = new Set(deliverables);
        const taskDeliverableCount = input.messages.filter(
          (message) => deliverableSet.has(message.uuid) && message.isTaskInput
        ).length;
        const expected =
          core.action === 'noop'
            ? ({ action: 'noop' } as TurnEndFlushPlan)
            : {
                ...core,
                contextReset: planTurnEndFlushContextReset({
                  slotResetsContext: input.slotResetsContext,
                  hasPriorContext: input.hasPriorContext,
                  hasActiveDeliveryJob: input.activeInJobQueue.size > 0,
                  taskDeliverableCount: taskDeliverableCount + (input.pendingTaskInput ? 1 : 0),
                }),
              };
        expect(decideTurnEndFlush(input)).toEqual(expected);
      }
    });

    test('an empty queue reports noop through the pipeline', () => {
      expect(decideTurnEndFlush(makeFlushInput({ messages: [] }))).toEqual({ action: 'noop' });
    });
  });
});

describe('reconcile helpers re-exported for one import site', () => {
  test('re-exports alias the core implementations', () => {
    expect(decideReconcileAdmission).toBe(coreDecideReconcileAdmission);
    expect(selectStrandedDeliveries).toBe(coreSelectStrandedDeliveries);
  });
});
