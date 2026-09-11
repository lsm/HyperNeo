import type { SpaceAgent, SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('unified-agent-events');

type UnifiedAgentEventBus = InternalEventBus<DaemonInternalEventMap> | undefined;

export async function publishUnifiedAgentCreated(
  internalEventBus: UnifiedAgentEventBus,
  agent: SpaceLongHorizonAgent,
  sessionId: string = `space:${agent.spaceId}`
): Promise<void> {
  if (!internalEventBus) return;
  await internalEventBus
    .publish('spaceAgent.created', {
      sessionId,
      spaceId: agent.spaceId,
      agent,
    })
    .catch((err) => {
      log.warn('Failed to emit spaceAgent.created:', err);
    });
}

export async function publishUnifiedAgentUpdated(
  internalEventBus: UnifiedAgentEventBus,
  agent: SpaceLongHorizonAgent,
  sessionId: string = `space:${agent.spaceId}`
): Promise<void> {
  if (!internalEventBus) return;
  await internalEventBus
    .publish('spaceAgent.updated', {
      sessionId,
      spaceId: agent.spaceId,
      agent,
    })
    .catch((err) => {
      log.warn('Failed to emit spaceAgent.updated:', err);
    });
}

export async function publishUnifiedAgentDeleted(
  internalEventBus: UnifiedAgentEventBus,
  spaceId: string,
  agentId: string,
  sessionId: string = `space:${spaceId}`
): Promise<void> {
  if (!internalEventBus) return;
  await internalEventBus
    .publish('spaceAgent.deleted', { sessionId, spaceId, agentId })
    .catch((err) => {
      log.warn('Failed to emit spaceAgent.deleted:', err);
    });
}

export interface OwnedAgentLookup {
  getOwnedById(id: string): SpaceAgent | null;
}

export async function publishSpaceAgentV2Mirror(
  internalEventBus: UnifiedAgentEventBus,
  ownedAgents: OwnedAgentLookup | undefined,
  spaceId: string,
  agentId: string,
  kind: 'created' | 'updated' | 'deleted'
): Promise<void> {
  if (!internalEventBus || !ownedAgents) return;
  const sessionId = `space:${spaceId}`;
  if (kind === 'deleted') {
    await internalEventBus
      .publish('spaceAgentV2.deleted', { sessionId, spaceId, agentId })
      .catch((err) => {
        log.warn('Failed to mirror spaceAgentV2.deleted:', err);
      });
    return;
  }
  const agent = ownedAgents.getOwnedById(agentId);
  if (!agent) return;
  await internalEventBus
    .publish(`spaceAgentV2.${kind}`, { sessionId, spaceId, agent })
    .catch((err) => {
      log.warn(`Failed to mirror spaceAgentV2.${kind}:`, err);
    });
}
