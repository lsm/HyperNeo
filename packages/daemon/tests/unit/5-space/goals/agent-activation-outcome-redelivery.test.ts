import { describe, expect, mock, test } from 'bun:test';
import type { SpaceLongHorizonAgent, SpaceLongHorizonAgentGoal } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import {
  ownedGoalIdsFromLinks,
  subscribeAgentActivationOutcomeRedelivery,
} from '../../../../src/lib/space/goals/agent-activation-outcome-redelivery';

const SPACE_ID = 'space-1';

function link(
  goalId: string,
  relationship: SpaceLongHorizonAgentGoal['relationship']
): SpaceLongHorizonAgentGoal {
  return { agentId: 'agent-1', goalId, relationship, createdAt: 1, updatedAt: 1 };
}

function agent(status: SpaceLongHorizonAgent['status']): SpaceLongHorizonAgent {
  return { id: 'agent-1', spaceId: SPACE_ID, status } as SpaceLongHorizonAgent;
}

describe('ownedGoalIdsFromLinks', () => {
  test('keeps only owner relationships', () => {
    expect(ownedGoalIdsFromLinks([link('goal-1', 'owner'), link('goal-2', 'watcher')])).toEqual([
      'goal-1',
    ]);
  });

  test('deduplicates repeated owner links for the same goal', () => {
    expect(ownedGoalIdsFromLinks([link('goal-1', 'owner'), link('goal-1', 'owner')])).toEqual([
      'goal-1',
    ]);
  });

  test('returns nothing for an agent with no owner links', () => {
    expect(ownedGoalIdsFromLinks([link('goal-1', 'manager')])).toEqual([]);
  });
});

describe('subscribeAgentActivationOutcomeRedelivery', () => {
  test('redelivers every owned goal when an agent becomes active', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeAgentActivationOutcomeRedelivery({
      internalEventBus,
      listAgentGoalLinks: mock(() => [link('goal-1', 'owner'), link('goal-2', 'owner')]),
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceAgent.updated', {
      sessionId: `space:${SPACE_ID}`,
      spaceId: SPACE_ID,
      agent: agent('active'),
    });

    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith('goal-1');
    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith('goal-2');
  });

  test('ignores goals the agent only watches', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeAgentActivationOutcomeRedelivery({
      internalEventBus,
      listAgentGoalLinks: mock(() => [link('goal-watched', 'watcher')]),
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceAgent.updated', {
      sessionId: `space:${SPACE_ID}`,
      spaceId: SPACE_ID,
      agent: agent('active'),
    });

    expect(recoverPendingOutcomeNotificationsForGoal).not.toHaveBeenCalled();
  });

  test('does not redeliver while the agent is still paused', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const listAgentGoalLinks = mock(() => [link('goal-1', 'owner')]);
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeAgentActivationOutcomeRedelivery({
      internalEventBus,
      listAgentGoalLinks,
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceAgent.updated', {
      sessionId: `space:${SPACE_ID}`,
      spaceId: SPACE_ID,
      agent: agent('paused'),
    });

    expect(listAgentGoalLinks).not.toHaveBeenCalled();
    expect(recoverPendingOutcomeNotificationsForGoal).not.toHaveBeenCalled();
  });

  test('ignores an update that carries no agent', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    subscribeAgentActivationOutcomeRedelivery({
      internalEventBus,
      listAgentGoalLinks: mock(() => [link('goal-1', 'owner')]),
      recoverPendingOutcomeNotificationsForGoal,
    });

    await internalEventBus.publish('spaceAgent.updated', {
      sessionId: `space:${SPACE_ID}`,
      spaceId: SPACE_ID,
      agent: undefined as unknown as SpaceLongHorizonAgent,
    });

    expect(recoverPendingOutcomeNotificationsForGoal).not.toHaveBeenCalled();
  });

  test('does not fail the publish when one goal redelivery rejects', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (goalId: string) => {
      if (goalId === 'goal-1') throw new Error('recovery exploded');
    });
    subscribeAgentActivationOutcomeRedelivery({
      internalEventBus,
      listAgentGoalLinks: mock(() => [link('goal-1', 'owner'), link('goal-2', 'owner')]),
      recoverPendingOutcomeNotificationsForGoal,
    });

    const result = await internalEventBus.publish('spaceAgent.updated', {
      sessionId: `space:${SPACE_ID}`,
      spaceId: SPACE_ID,
      agent: agent('active'),
    });

    expect(result.failures).toEqual([]);
    expect(recoverPendingOutcomeNotificationsForGoal).toHaveBeenCalledWith('goal-2');
  });

  test('stops redelivering after unsubscribe', async () => {
    const internalEventBus = createDaemonInternalEventBus();
    const recoverPendingOutcomeNotificationsForGoal = mock(async (_goalId: string) => {});
    const unsubscribe = subscribeAgentActivationOutcomeRedelivery({
      internalEventBus,
      listAgentGoalLinks: mock(() => [link('goal-1', 'owner')]),
      recoverPendingOutcomeNotificationsForGoal,
    });

    unsubscribe();
    await internalEventBus.publish('spaceAgent.updated', {
      sessionId: `space:${SPACE_ID}`,
      spaceId: SPACE_ID,
      agent: agent('active'),
    });

    expect(recoverPendingOutcomeNotificationsForGoal).not.toHaveBeenCalled();
  });
});
