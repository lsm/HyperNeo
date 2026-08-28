import { describe, expect, test } from 'bun:test';
import {
  applyActiveDeliveryJobGate,
  applyClearThenFlushGate,
  applyFlushWithoutClearGate,
  planTurnEndFlushContextReset,
  type TurnEndFlushContextResetPlan,
} from '../../../../src/lib/agent/context-reset-planner';

interface FlushGuardCtx {
  slotResetsContext: boolean;
  hasPriorContext: boolean;
  hasActiveDeliveryJob: boolean;
  taskDeliverableCount: number;
  contextReset: TurnEndFlushContextResetPlan | null;
}

function makeFlushCtx(overrides: Partial<FlushGuardCtx> = {}): FlushGuardCtx {
  return {
    slotResetsContext: true,
    hasPriorContext: true,
    hasActiveDeliveryJob: false,
    taskDeliverableCount: 3,
    contextReset: null,
    ...overrides,
  };
}

const flushGuardSequence: Array<(ctx: FlushGuardCtx) => FlushGuardCtx> = [
  applyClearThenFlushGate,
  applyActiveDeliveryJobGate,
  applyFlushWithoutClearGate,
];

describe('turn-end flush context-reset guard gates', () => {
  test('all four conjuncts true clears then flushes', () => {
    expect(applyClearThenFlushGate(makeFlushCtx()).contextReset).toEqual({
      action: 'clear_then_flush',
    });
  });

  test('each false conjunct keeps the clear-then-flush gate a no-op', () => {
    for (const overrides of [
      { slotResetsContext: false },
      { hasPriorContext: false },
      { hasActiveDeliveryJob: true },
      { taskDeliverableCount: 0 },
    ] as Partial<FlushGuardCtx>[]) {
      const ctx = makeFlushCtx(overrides);
      expect(applyClearThenFlushGate(ctx)).toBe(ctx);
    }
  });

  test('an active delivery job with both reset conjuncts flushes without clear with its reason', () => {
    expect(
      applyActiveDeliveryJobGate(makeFlushCtx({ hasActiveDeliveryJob: true })).contextReset
    ).toEqual({ action: 'flush_without_clear', reason: 'active_delivery_job' });
  });

  test('the active_delivery_job reason never appears when a reset conjunct is false', () => {
    for (const overrides of [
      { slotResetsContext: false },
      { hasPriorContext: false },
    ] as Partial<FlushGuardCtx>[]) {
      const ctx = makeFlushCtx({ ...overrides, hasActiveDeliveryJob: true });
      expect(applyActiveDeliveryJobGate(ctx)).toBe(ctx);
    }
  });

  test('the active-job guard never overwrites an existing reset plan', () => {
    const ctx = makeFlushCtx({
      hasActiveDeliveryJob: true,
      contextReset: { action: 'clear_then_flush' },
    });
    expect(applyActiveDeliveryJobGate(ctx)).toBe(ctx);
  });

  test('the flush-without-clear gate fires the plain fallback without a reason', () => {
    expect(applyFlushWithoutClearGate(makeFlushCtx()).contextReset).toEqual({
      action: 'flush_without_clear',
    });
  });

  test('the flush-without-clear gate never overwrites an existing reset plan', () => {
    for (const contextReset of [
      { action: 'clear_then_flush' },
      { action: 'flush_without_clear', reason: 'active_delivery_job' },
    ] as TurnEndFlushContextResetPlan[]) {
      const ctx = makeFlushCtx({ contextReset });
      expect(applyFlushWithoutClearGate(ctx)).toBe(ctx);
    }
  });

  test('the guard sequence reproduces the pinned wrapper plan for every flag combination', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const ctx = makeFlushCtx({
        slotResetsContext: (mask & 1) === 0,
        hasPriorContext: (mask & 2) === 0,
        hasActiveDeliveryJob: (mask & 4) !== 0,
        taskDeliverableCount: (mask & 8) !== 0 ? 3 : 0,
      });
      const planned = flushGuardSequence.reduce((current, gate) => gate(current), ctx);
      expect(planned.contextReset).toEqual(
        planTurnEndFlushContextReset({
          slotResetsContext: ctx.slotResetsContext,
          hasPriorContext: ctx.hasPriorContext,
          hasActiveDeliveryJob: ctx.hasActiveDeliveryJob,
          taskDeliverableCount: ctx.taskDeliverableCount,
        })
      );
    }
  });
});
