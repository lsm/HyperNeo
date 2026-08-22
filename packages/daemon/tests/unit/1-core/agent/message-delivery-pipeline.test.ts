import { describe, expect, test } from 'bun:test';
import {
  planInjectContextReset,
  planTurnEndFlushContextReset,
} from '../../../../src/lib/agent/context-reset-planner';
import {
  applyAlreadyConsumedGate,
  applyDeferAdmissionGate,
  applyFailedReopenGate,
  applyFlushContextResetGate,
  applyFlushEmptyGate,
  applyFlushFinalGate,
  applyFlushOwnershipGate,
  applyInjectContextResetGate,
  applyInjectFinalGate,
  classifyTurnCompletion,
  decideInjectDelivery,
  decideReconcileAdmission,
  decideTurnEndFlush,
  type InjectDeliveryCtx,
  type InjectDeliveryDecision,
  type InjectDeliveryInput,
  selectStrandedDeliveries,
  shouldRearmSpuriousTurnEnd,
  type TurnEndFlushCtx,
  type TurnEndFlushInput,
  type TurnEndFlushPlan,
} from '../../../../src/lib/agent/message-delivery-pipeline';
import {
  decideDeferAdmission,
  type FlushMessage,
  planFlushDelivery,
} from '../../../../src/lib/agent/message-ownership-gates';
import {
  classifyTurnCompletion as coreClassifyTurnCompletion,
  decideReconcileAdmission as coreDecideReconcileAdmission,
  selectStrandedDeliveries as coreSelectStrandedDeliveries,
  shouldRearmSpuriousTurnEnd as coreShouldRearmSpuriousTurnEnd,
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

function makeInjectCtx(overrides: Partial<InjectDeliveryInput> = {}): InjectDeliveryCtx {
  return { ...makeInjectInput(overrides), reopenFailedDelivery: false, decision: null };
}

function makeFlushMessage(overrides: Partial<FlushMessage> = {}): FlushMessage {
  return {
    uuid: 'uuid-1',
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
    pendingInMemoryUuids: new Set<string>(),
    activeTurnInJobQueue: false,
    slotResetsContext: true,
    hasPriorContext: true,
    pendingTaskInput: false,
    ...overrides,
  };
}

function makeFlushCtx(overrides: Partial<TurnEndFlushInput> = {}): TurnEndFlushCtx {
  return {
    ...makeFlushInput(overrides),
    flushPlan: null,
    contextReset: null,
    decision: null,
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

  describe('gate pass-through contract', () => {
    test('gates with a no-op branch leave ctx untouched when not firing', () => {
      const noOpCases: Array<
        [(ctx: InjectDeliveryCtx) => InjectDeliveryCtx, Partial<InjectDeliveryInput>]
      > = [
        [applyAlreadyConsumedGate, { existingSendStatus: 'failed' }],
        [applyAlreadyConsumedGate, { existingSendStatus: 'deferred' }],
        [applyAlreadyConsumedGate, { existingSendStatus: null }],
        [applyFailedReopenGate, { existingSendStatus: 'consumed' }],
        [applyFailedReopenGate, { existingSendStatus: 'enqueued' }],
        [applyFailedReopenGate, { existingSendStatus: null }],
        [applyDeferAdmissionGate, { deliveryMode: 'defer', isBusy: false }],
        [applyDeferAdmissionGate, { deliveryMode: 'immediate', isBusy: true }],
      ];
      for (const [gate, overrides] of noOpCases) {
        const ctx = makeInjectCtx(overrides);
        expect(gate(ctx)).toBe(ctx);
      }
    });

    test('the failed-reopen gate annotates without deciding', () => {
      const ctx = applyFailedReopenGate(makeInjectCtx({ existingSendStatus: 'failed' }));
      expect(ctx.reopenFailedDelivery).toBe(true);
      expect(ctx.decision).toBeNull();
    });

    test('the inject final arbiter always decides', () => {
      for (const overrides of [
        {},
        { existingSendStatus: 'failed' },
        { inputKind: 'steer' },
      ] as Partial<InjectDeliveryInput>[]) {
        const decidedCtx = applyInjectFinalGate(makeInjectCtx(overrides));
        expect(decidedCtx.decision).toEqual({ action: 'deliver' });
      }
    });
  });

  describe('delegation — pipeline output equals the underlying core output', () => {
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

    test('the context-reset gate returns the core plan verbatim', () => {
      for (const overrides of [
        {},
        { inputKind: 'steer' },
        { isBusy: true },
        { hasActiveDeliveryJob: true },
        { hasUnconsumedDeliveredWork: true },
      ] as Partial<InjectDeliveryInput>[]) {
        const input = makeInjectInput(overrides);
        expect(applyInjectContextResetGate(makeInjectCtx(overrides)).decision).toEqual(
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
        messages: [
          makeFlushMessage({ uuid: 'job-owned' }),
          makeFlushMessage({ uuid: 'memory-owned' }),
        ],
        activeInJobQueue: new Set(['job-owned']),
        pendingInMemoryUuids: new Set(['memory-owned']),
      },
      { action: 'noop' },
    ],
    [
      'two batchable messages on a non-reset slot batch without a context clear',
      { slotResetsContext: false },
      { action: 'batch', uuids: ['a', 'b'], contextReset: { action: 'flush_without_clear' } },
    ],
    [
      'a batch of deliverables on a reset slot plans exactly one clear ahead of the batch (#1085)',
      {},
      { action: 'batch', uuids: ['a', 'b'], contextReset: { action: 'clear_then_flush' } },
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
      'an active turn in the job queue forces per-message delivery',
      { slotResetsContext: false, activeTurnInJobQueue: true },
      {
        action: 'each',
        deliver: ['a', 'b'],
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
        action: 'batch',
        uuids: ['human-1', 'human-2'],
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
        action: 'batch',
        uuids: ['human-1', 'task-1'],
        contextReset: { action: 'clear_then_flush' },
      },
    ],
    [
      'a session without prior context flushes without a clear on the first turn',
      { hasPriorContext: false },
      { action: 'batch', uuids: ['a', 'b'], contextReset: { action: 'flush_without_clear' } },
    ],
    [
      'an active delivery job suppresses the flush clear and defers the reset',
      { activeInJobQueue: new Set(['uuid-active']) },
      {
        action: 'batch',
        uuids: ['a', 'b'],
        contextReset: { action: 'flush_without_clear', reason: 'active_delivery_job' },
      },
    ],
    [
      'a pending task input behind a human-only backlog plans one clear ahead of the batch',
      {
        messages: [
          makeFlushMessage({ uuid: 'human-1', isTaskInput: false }),
          makeFlushMessage({ uuid: 'human-2', isTaskInput: false, flattenedText: 'follow-up' }),
        ],
        pendingTaskInput: true,
      },
      {
        action: 'batch',
        uuids: ['human-1', 'human-2'],
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
          activeTurnInJobQueue: true,
          activeInJobQueue: new Set(['ghost']),
        })
      );
      expect(plan).toEqual({ action: 'noop' });
    });
  });

  describe('gate pass-through and annotation contract', () => {
    test('the empty gate leaves ctx untouched for a non-empty queue', () => {
      const ctx = makeFlushCtx({});
      expect(applyFlushEmptyGate(ctx)).toBe(ctx);
    });

    test('the empty gate decides noop for an empty queue', () => {
      expect(applyFlushEmptyGate(makeFlushCtx({ messages: [] })).decision).toEqual({
        action: 'noop',
      });
    });

    test('the ownership gate annotates the core flush plan without deciding', () => {
      const ctx = applyFlushOwnershipGate(makeFlushCtx({ activeTurnInJobQueue: true }));
      expect(ctx.flushPlan).toEqual(
        planFlushDelivery({
          messages: ctx.messages,
          activeInJobQueue: ctx.activeInJobQueue,
          pendingInMemoryUuids: ctx.pendingInMemoryUuids,
          activeTurnInJobQueue: ctx.activeTurnInJobQueue,
        })
      );
      expect(ctx.decision).toBeNull();
    });

    test('the context-reset gate annotates the core plan without deciding', () => {
      const ownershipCtx = applyFlushOwnershipGate(makeFlushCtx({}));
      const ctx = applyFlushContextResetGate(ownershipCtx);
      expect(ctx.contextReset).toEqual(
        planTurnEndFlushContextReset({
          slotResetsContext: true,
          hasPriorContext: true,
          hasActiveDeliveryJob: false,
          taskDeliverableCount: 2,
        })
      );
      expect(ctx.decision).toBeNull();
    });

    test('the flush final arbiter always decides', () => {
      expect(applyFlushFinalGate(makeFlushCtx({})).decision).toEqual({ action: 'noop' });
      expect(
        applyFlushFinalGate(applyFlushContextResetGate(applyFlushOwnershipGate(makeFlushCtx({}))))
          .decision
      ).toEqual({
        action: 'batch',
        uuids: ['a', 'b'],
        contextReset: { action: 'clear_then_flush' },
      });
      expect(
        applyFlushFinalGate(
          applyFlushContextResetGate(
            applyFlushOwnershipGate(makeFlushCtx({ activeTurnInJobQueue: true }))
          )
        ).decision
      ).toEqual({
        action: 'each',
        deliver: ['a', 'b'],
        skip: [],
        contextReset: { action: 'clear_then_flush' },
      });
    });
  });

  describe('delegation — pipeline output equals the underlying core output', () => {
    test('the flush plan is the core delivery plan annotated with the core context reset', () => {
      for (const [, overrides] of cases) {
        const input = makeFlushInput(overrides);
        const core = planFlushDelivery({
          messages: input.messages,
          activeInJobQueue: input.activeInJobQueue,
          pendingInMemoryUuids: input.pendingInMemoryUuids,
          activeTurnInJobQueue: input.activeTurnInJobQueue,
        });
        const deliverables =
          core.action === 'batch' ? core.uuids : core.action === 'each' ? core.deliver : [];
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
  });
});

describe('turn-outcome point decisions re-exported for one import site', () => {
  test('re-exports alias the core implementations', () => {
    expect(classifyTurnCompletion).toBe(coreClassifyTurnCompletion);
    expect(shouldRearmSpuriousTurnEnd).toBe(coreShouldRearmSpuriousTurnEnd);
    expect(decideReconcileAdmission).toBe(coreDecideReconcileAdmission);
    expect(selectStrandedDeliveries).toBe(coreSelectStrandedDeliveries);
  });
});
