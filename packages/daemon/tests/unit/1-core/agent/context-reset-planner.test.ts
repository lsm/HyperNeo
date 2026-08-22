import { describe, expect, test } from 'bun:test';
import {
  planInjectContextReset,
  planTurnEndFlushContextReset,
} from '../../../../src/lib/agent/context-reset-planner';

const baseArgs = {
  inputKind: 'task',
  isBusy: false,
  hasPriorContext: true,
  slotResetsContext: true,
  hasActiveDeliveryJob: false,
  hasUnconsumedDeliveredWork: false,
};

describe('planInjectContextReset', () => {
  test('not a task input skips the clear gate', () => {
    expect(planInjectContextReset({ ...baseArgs, inputKind: 'steer' })).toEqual({
      action: 'deliver_without_clear',
      reason: 'not_task_input',
    });
  });

  test('a busy session keeps context intact', () => {
    expect(planInjectContextReset({ ...baseArgs, isBusy: true })).toEqual({
      action: 'deliver_without_clear',
      reason: 'session_busy',
    });
  });

  test('a fresh session with no prior context skips the clear', () => {
    expect(planInjectContextReset({ ...baseArgs, hasPriorContext: false })).toEqual({
      action: 'deliver_without_clear',
      reason: 'no_prior_context',
    });
  });

  test('a slot that does not reset context per turn skips the clear', () => {
    expect(planInjectContextReset({ ...baseArgs, slotResetsContext: false })).toEqual({
      action: 'deliver_without_clear',
      reason: 'slot_not_reset',
    });
  });

  test('an active delivery job blocks the clear step', () => {
    expect(planInjectContextReset({ ...baseArgs, hasActiveDeliveryJob: true })).toEqual({
      action: 'deliver_without_clear',
      reason: 'delivery_job_active',
    });
  });

  test('unconsumed delivered work blocks the clear step (#1085)', () => {
    expect(planInjectContextReset({ ...baseArgs, hasUnconsumedDeliveredWork: true })).toEqual({
      action: 'deliver_without_clear',
      reason: 'unconsumed_work_pending',
    });
  });

  test('an active delivery job outranks unconsumed delivered work', () => {
    expect(
      planInjectContextReset({
        ...baseArgs,
        hasActiveDeliveryJob: true,
        hasUnconsumedDeliveredWork: true,
      })
    ).toEqual({
      action: 'deliver_without_clear',
      reason: 'delivery_job_active',
    });
  });

  test('all conjuncts true clears before delivery', () => {
    expect(planInjectContextReset(baseArgs)).toEqual({
      action: 'clear_before_deliver',
    });
  });

  test('the first false conjunct wins over later false conjuncts', () => {
    expect(
      planInjectContextReset({
        inputKind: 'steer',
        isBusy: true,
        hasPriorContext: false,
        slotResetsContext: false,
        hasActiveDeliveryJob: true,
        hasUnconsumedDeliveredWork: true,
      })
    ).toEqual({
      action: 'deliver_without_clear',
      reason: 'not_task_input',
    });
  });
});

describe('planTurnEndFlushContextReset', () => {
  test('a reset slot with task deliverables clears once before the first message (#1085)', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: true,
        hasPriorContext: true,
        hasActiveDeliveryJob: false,
        taskDeliverableCount: 3,
      })
    ).toEqual({ action: 'clear_then_flush' });
  });

  test('a batch of any size gets exactly one clear plan, never per message', () => {
    for (const taskDeliverableCount of [1, 2, 8, 64]) {
      expect(
        planTurnEndFlushContextReset({
          slotResetsContext: true,
          hasPriorContext: true,
          hasActiveDeliveryJob: false,
          taskDeliverableCount,
        })
      ).toEqual({
        action: 'clear_then_flush',
      });
    }
  });

  test('a non-reset slot flushes without a clear even with task deliverables', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: false,
        hasPriorContext: true,
        hasActiveDeliveryJob: false,
        taskDeliverableCount: 3,
      })
    ).toEqual({ action: 'flush_without_clear' });
  });

  test('a reset slot with an empty queue flushes without a clear', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: true,
        hasPriorContext: true,
        hasActiveDeliveryJob: false,
        taskDeliverableCount: 0,
      })
    ).toEqual({ action: 'flush_without_clear' });
  });

  test('a session without prior context flushes without a clear on the first turn', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: true,
        hasPriorContext: false,
        hasActiveDeliveryJob: false,
        taskDeliverableCount: 3,
      })
    ).toEqual({ action: 'flush_without_clear' });
  });

  test('an active delivery job suppresses the flush clear and defers the reset', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: true,
        hasPriorContext: true,
        hasActiveDeliveryJob: true,
        taskDeliverableCount: 3,
      })
    ).toEqual({ action: 'flush_without_clear', reason: 'active_delivery_job' });
  });
});
