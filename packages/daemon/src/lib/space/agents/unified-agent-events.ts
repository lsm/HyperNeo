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
  const payload = { sessionId, spaceId: agent.spaceId, agent };
  await Promise.all([
    internalEventBus.publish('spaceAgent.created', payload).catch((err) => {
      log.warn('Failed to emit spaceAgent.created:', err);
    }),
    internalEventBus.publish('spaceLongHorizonAgent.created', payload).catch((err) => {
      log.warn('Failed to emit spaceLongHorizonAgent.created:', err);
    }),
  ]);
}

export async function publishUnifiedAgentUpdated(
  internalEventBus: UnifiedAgentEventBus,
  agent: SpaceLongHorizonAgent,
  sessionId: string = `space:${agent.spaceId}`
): Promise<void> {
  if (!internalEventBus) return;
  const payload = { sessionId, spaceId: agent.spaceId, agent };
  await Promise.all([
    internalEventBus.publish('spaceAgent.updated', payload).catch((err) => {
      log.warn('Failed to emit spaceAgent.updated:', err);
    }),
    internalEventBus.publish('spaceLongHorizonAgent.updated', payload).catch((err) => {
      log.warn('Failed to emit spaceLongHorizonAgent.updated:', err);
    }),
  ]);
}

export async function publishUnifiedAgentDeleted(
  internalEventBus: UnifiedAgentEventBus,
  spaceId: string,
  agentId: string,
  sessionId: string = `space:${spaceId}`
): Promise<void> {
  if (!internalEventBus) return;
  const payload = { sessionId, spaceId, agentId };
  await Promise.all([
    internalEventBus.publish('spaceAgent.deleted', payload).catch((err) => {
      log.warn('Failed to emit spaceAgent.deleted:', err);
    }),
    internalEventBus.publish('spaceLongHorizonAgent.deleted', payload).catch((err) => {
      log.warn('Failed to emit spaceLongHorizonAgent.deleted:', err);
    }),
  ]);
}
