import type { SpaceLongHorizonAgent, SpaceLongHorizonAgentGoal } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('agent-activation-outcome-redelivery');

export type AgentActivationSkipReason = 'not_active' | 'no_owned_goals';

export type AgentGoalLinkReader = (agentId: string) => SpaceLongHorizonAgentGoal[];

export function ownedGoalIdsFromLinks(links: SpaceLongHorizonAgentGoal[]): string[] {
  const owned = new Set<string>();
  for (const link of links) {
    if (link.relationship === 'owner' && link.goalId) owned.add(link.goalId);
  }
  return [...owned];
}

export function gateAgentActive(
  agent: SpaceLongHorizonAgent | undefined
): { value: SpaceLongHorizonAgent } | { reason: AgentActivationSkipReason } {
  if (!agent?.id || agent.status !== 'active') return { reason: 'not_active' };
  return { value: agent };
}

export function gateOwnedGoalIds(
  listAgentGoalLinks: AgentGoalLinkReader,
  agent: SpaceLongHorizonAgent
): { value: string[] } | { reason: AgentActivationSkipReason } {
  const owned = ownedGoalIdsFromLinks(listAgentGoalLinks(agent.id));
  if (owned.length < 1) return { reason: 'no_owned_goals' };
  return { value: owned };
}

export function createAgentActivationRedeliveryDecider(dependencies: {
  listAgentGoalLinks: AgentGoalLinkReader;
}) {
  return (
    superpipe({ listAgentGoalLinks: dependencies.listAgentGoalLinks })(
      'agent-activation-outcome-redelivery'
    ) as PipelineAPI
  )
    .input(['agent'])
    .pipe(gateAgentActive, 'agent', 'result:redelivery')
    .pipe(gateOwnedGoalIds, ['listAgentGoalLinks', 'redelivery'], 'result:redelivery')
    .end('redelivery') as (
    agent: SpaceLongHorizonAgent | undefined
  ) => string[] | AgentActivationSkipReason;
}

export interface AgentActivationOutcomeRedeliveryDeps {
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  listAgentGoalLinks: AgentGoalLinkReader;
  recoverPendingOutcomeNotificationsForGoal: (goalId: string) => Promise<void>;
}

export function subscribeAgentActivationOutcomeRedelivery(
  deps: AgentActivationOutcomeRedeliveryDeps
): () => void {
  const decideRedelivery = createAgentActivationRedeliveryDecider({
    listAgentGoalLinks: deps.listAgentGoalLinks,
  });
  return deps.internalEventBus.subscribe(
    'spaceAgent.updated',
    (event) => {
      const goalIds = decideRedelivery(event.agent);
      if (!Array.isArray(goalIds)) return;
      for (const goalId of goalIds) {
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
