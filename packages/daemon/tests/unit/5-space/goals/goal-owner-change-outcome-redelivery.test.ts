import { describe, expect, mock, test } from 'bun:test';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { subscribeGoalOwnerChangeOutcomeRedelivery } from '../../../../src/lib/space/goals/goal-owner-change-outcome-redelivery';

describe('subscribeGoalOwnerChangeOutcomeRedelivery', () => {
  test('redelivers pending outcome notifications for the space whose goal owner changed', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForSpace = mock(async (_spaceId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForSpace,
    });

    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-1',
      goalId: 'goal-1',
    });

    expect(recoverPendingOutcomeNotificationsForSpace).toHaveBeenCalledWith('space-1');
  });

  test('redelivers for an owner change published from a Space agent tool session', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForSpace = mock(async (_spaceId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForSpace,
    });

    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space-agent-tools',
      spaceId: 'space-2',
      goalId: 'goal-2',
    });

    expect(recoverPendingOutcomeNotificationsForSpace).toHaveBeenCalledWith('space-2');
  });

  test('ignores an owner change that carries no spaceId', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForSpace = mock(async (_spaceId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForSpace,
    });

    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: '',
      goalId: 'goal-1',
    });

    expect(recoverPendingOutcomeNotificationsForSpace).not.toHaveBeenCalled();
  });

  test('does not fail the publish when redelivery rejects', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForSpace = mock(async (_spaceId: string) => {
      throw new Error('recovery exploded');
    });
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForSpace,
    });

    const result = await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-3',
      goalId: 'goal-3',
    });

    expect(result.failures).toEqual([]);
    expect(recoverPendingOutcomeNotificationsForSpace).toHaveBeenCalledWith('space-3');
  });

  test('stops redelivering after unsubscribe', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForSpace = mock(async (_spaceId: string) => {});
    const unsubscribe = subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForSpace,
    });

    unsubscribe();
    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-1',
      goalId: 'goal-1',
    });

    expect(recoverPendingOutcomeNotificationsForSpace).not.toHaveBeenCalled();
  });
});
