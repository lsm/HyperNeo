import { describe, expect, test } from 'bun:test';
import {
  applyActiveDeliveryJobGate,
  applyBusyGate,
  applyClearBeforeDeliverGate,
  applyNoPriorContextGate,
  applyNotTaskInputGate,
  applySlotNotResetGate,
  applyUnconsumedWorkGate,
  type InjectContextResetReason,
  type InjectContextResetPlan,
  planInjectContextReset,
} from '../../../../src/lib/agent/context-reset-planner';

interface InjectGuardCtx {
  inputKind: string;
  isBusy: boolean;
  hasPriorContext: boolean;
  slotResetsContext: boolean;
  hasActiveDeliveryJob: boolean;
  hasUnconsumedDeliveredWork: boolean;
  decision: InjectContextResetPlan | null;
}

function makeInjectCtx(overrides: Partial<InjectGuardCtx> = {}): InjectGuardCtx {
  return {
    inputKind: 'task',
    isBusy: false,
    hasPriorContext: true,
    slotResetsContext: true,
    hasActiveDeliveryJob: false,
    hasUnconsumedDeliveredWork: false,
    decision: null,
    ...overrides,
  };
}

const injectGuardSequence: Array<(ctx: InjectGuardCtx) => InjectGuardCtx> = [
  applyNotTaskInputGate,
  applyBusyGate,
  applyNoPriorContextGate,
  applySlotNotResetGate,
  applyActiveDeliveryJobGate,
  applyUnconsumedWorkGate,
  applyClearBeforeDeliverGate,
];

function runInjectGuards(ctx: InjectGuardCtx): InjectGuardCtx {
  return injectGuardSequence.reduce(
    (current, gate) => (current.decision !== null ? current : gate(current)),
    ctx
  );
}

describe('inject context-reset guard gates', () => {
  const fireCases: Array<
    [(ctx: InjectGuardCtx) => InjectGuardCtx, Partial<InjectGuardCtx>, InjectContextResetReason]
  > = [
    [applyNotTaskInputGate, { inputKind: 'steer' }, 'not_task_input'],
    [applyBusyGate, { isBusy: true }, 'session_busy'],
    [applyNoPriorContextGate, { hasPriorContext: false }, 'no_prior_context'],
    [applySlotNotResetGate, { slotResetsContext: false }, 'slot_not_reset'],
    [applyActiveDeliveryJobGate, { hasActiveDeliveryJob: true }, 'delivery_job_active'],
    [applyUnconsumedWorkGate, { hasUnconsumedDeliveredWork: true }, 'unconsumed_work_pending'],
  ];

  for (const [gate, overrides, reason] of fireCases) {
    test(`${reason} fires when its guard condition holds`, () => {
      expect(gate(makeInjectCtx(overrides)).decision).toEqual({
        action: 'deliver_without_clear',
        reason,
      });
    });
  }

  test('each guard passes an eligible ctx through untouched', () => {
    for (const gate of [
      applyNotTaskInputGate,
      applyBusyGate,
      applyNoPriorContextGate,
      applySlotNotResetGate,
      applyActiveDeliveryJobGate,
      applyUnconsumedWorkGate,
    ]) {
      const ctx = makeInjectCtx();
      expect(gate(ctx)).toBe(ctx);
    }
  });

  test('the default gate always decides clear_before_deliver', () => {
    for (const overrides of [
      {},
      { inputKind: 'steer' },
      { isBusy: true },
      { hasActiveDeliveryJob: true },
    ] as Partial<InjectGuardCtx>[]) {
      expect(applyClearBeforeDeliverGate(makeInjectCtx(overrides)).decision).toEqual({
        action: 'clear_before_deliver',
      });
    }
  });

  test('an active delivery job outranks unconsumed delivered work', () => {
    const ctx = runInjectGuards(
      makeInjectCtx({ hasActiveDeliveryJob: true, hasUnconsumedDeliveredWork: true })
    );
    expect(ctx.decision).toEqual({
      action: 'deliver_without_clear',
      reason: 'delivery_job_active',
    });
  });

  test('the guard sequence reproduces the pinned wrapper plan for every flag combination', () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const ctx = makeInjectCtx({
        inputKind: (mask & 1) !== 0 ? 'steer' : 'task',
        isBusy: (mask & 2) !== 0,
        hasPriorContext: (mask & 4) === 0,
        slotResetsContext: (mask & 8) === 0,
        hasActiveDeliveryJob: (mask & 16) !== 0,
        hasUnconsumedDeliveredWork: (mask & 32) !== 0,
      });
      const decided = runInjectGuards(ctx);
      expect(decided.decision).toEqual(
        planInjectContextReset({
          inputKind: ctx.inputKind,
          isBusy: ctx.isBusy,
          hasPriorContext: ctx.hasPriorContext,
          slotResetsContext: ctx.slotResetsContext,
          hasActiveDeliveryJob: ctx.hasActiveDeliveryJob,
          hasUnconsumedDeliveredWork: ctx.hasUnconsumedDeliveredWork,
        })
      );
    }
  });
});
