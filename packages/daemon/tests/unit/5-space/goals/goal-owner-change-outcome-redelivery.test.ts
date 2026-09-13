import { describe, expect, mock, test } from 'bun:test';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { subscribeGoalOwnerChangeOutcomeRedelivery } from '../../../../src/lib/space/goals/goal-owner-change-outcome-redelivery';

describe('subscribeGoalOwnerChangeOutcomeRedelivery', () => {
  test('redelivers pending outcome notifications for the goal whose owner changed', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-1',
      goalId: 'goal-1',
    });

    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith('goal-1');
  });

  test('redelivers for an owner change published from a Space agent tool session', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space-agent-tools',
      spaceId: 'space-2',
      goalId: 'goal-2',
    });

    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith('goal-2');
  });

  test('ignores an owner change that carries no goalId', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-1',
      goalId: '',
    });

    expect(recoverPendingOutcomeNotificationsForGoal).not.toHaveBeenCalled();
  });

  test('does not fail the publish when redelivery rejects', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {
      throw new Error('recovery exploded');
    });
    subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForGoal,
    });

    const result = await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-3',
      goalId: 'goal-3',
    });

    expect(result.failures).toEqual([]);
    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith('goal-3');
  });

  test('stops redelivering after unsubscribe', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    const unsubscribe = subscribeGoalOwnerChangeOutcomeRedelivery({
      internalEventBus,
      recoverPendingOutcomeNotificationsForGoal,
    });

    unsubscribe();
    await internalEventBus.publish('spaceGoal.ownerChanged', {
      sessionId: 'space:session-1',
      spaceId: 'space-1',
      goalId: 'goal-1',
    });

    expect(recoverPendingOutcomeNotificationsForGoal).not.toHaveBeenCalled();
  });
});
