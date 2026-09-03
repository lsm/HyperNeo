import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
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
