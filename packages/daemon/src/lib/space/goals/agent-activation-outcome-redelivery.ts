import type { SpaceLongHorizonAgentGoal } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('agent-activation-outcome-redelivery');

export interface AgentActivationOutcomeRedeliveryDeps {
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  listAgentGoalLinks: (agentId: string) => SpaceLongHorizonAgentGoal[];
  recoverPendingOutcomeNotificationsForGoal: (goalId: string) => Promise<void>;
}

export function ownedGoalIdsFromLinks(links: SpaceLongHorizonAgentGoal[]): string[] {
  const owned = new Set<string>();
  for (const link of links) {
    if (link.relationship === 'owner' && link.goalId) owned.add(link.goalId);
  }
  return [...owned];
}

export function subscribeAgentActivationOutcomeRedelivery(
  deps: AgentActivationOutcomeRedeliveryDeps
): () => void {
  return deps.internalEventBus.subscribe(
    'spaceAgent.updated',
    (event) => {
      const agent = event.agent;
      if (!agent?.id || agent.status !== 'active') return;
      for (const goalId of ownedGoalIdsFromLinks(deps.listAgentGoalLinks(agent.id))) {
        void deps.recoverPendingOutcomeNotificationsForGoal(goalId).catch((err: unknown) => {
          log.warn(
            `Outcome wake redelivery after agent activation failed for goal "${goalId}": ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    },
    { subscriberName: 'agent-activation-outcome-redelivery' }
  );
}
