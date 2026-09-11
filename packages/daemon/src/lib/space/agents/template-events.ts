import type { SpaceAgentTemplate } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('template-events');

type TemplateEventBus = InternalEventBus<DaemonInternalEventMap> | undefined;

async function emit(
  bus: TemplateEventBus,
  event: 'spaceAgentTemplate.created' | 'spaceAgentTemplate.updated',
  spaceId: string,
  template: SpaceAgentTemplate
): Promise<void> {
  if (!bus) return;
  await bus.publish(event, { sessionId: `space:${spaceId}`, spaceId, template }).catch((err) => {
    log.warn(`Failed to emit ${event}:`, err);
  });
}

export function publishTemplateCreated(
  bus: TemplateEventBus,
  spaceId: string,
  template: SpaceAgentTemplate
): Promise<void> {
  return emit(bus, 'spaceAgentTemplate.created', spaceId, template);
}

export function publishTemplateUpdated(
  bus: TemplateEventBus,
  spaceId: string,
  template: SpaceAgentTemplate
): Promise<void> {
  return emit(bus, 'spaceAgentTemplate.updated', spaceId, template);
}

export async function publishTemplateDeleted(
  bus: TemplateEventBus,
  spaceId: string,
  key: string
): Promise<void> {
  if (!bus) return;
  await bus
    .publish('spaceAgentTemplate.deleted', { sessionId: `space:${spaceId}`, spaceId, key })
    .catch((err) => {
      log.warn('Failed to emit spaceAgentTemplate.deleted:', err);
    });
}
