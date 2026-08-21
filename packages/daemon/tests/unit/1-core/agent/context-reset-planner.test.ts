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
      })
    ).toEqual({
      action: 'deliver_without_clear',
      reason: 'not_task_input',
    });
  });
});

describe('planTurnEndFlushContextReset [KNOWN-BUG #1085]', () => {
  test('turn-end flush never clears even when a reset slot has deliverables', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: true,
        deliverableCount: 3,
      })
    ).toEqual({ action: 'flush_without_clear' });
  });

  test('turn-end flush keeps no-clear behavior for non-reset slots', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: false,
        deliverableCount: 3,
      })
    ).toEqual({ action: 'flush_without_clear' });
  });

  test('turn-end flush keeps no-clear behavior when the queue is empty', () => {
    expect(
      planTurnEndFlushContextReset({
        slotResetsContext: true,
        deliverableCount: 0,
      })
    ).toEqual({ action: 'flush_without_clear' });
  });
});
