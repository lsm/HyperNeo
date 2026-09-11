import type { SpaceAgentTemplate } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('template-events');

type TemplateEventBus = InternalEventBus<DaemonInternalEventMap> | undefined;

export async function publishTemplateCreated(
  internalEventBus: TemplateEventBus,
  spaceId: string,
  template: SpaceAgentTemplate
): Promise<void> {
  if (!internalEventBus) return;
  await internalEventBus
    .publish('spaceAgentTemplate.created', {
      sessionId: `space:${spaceId}`,
      spaceId,
      template,
    })
    .catch((err) => {
      log.warn('Failed to emit spaceAgentTemplate.created:', err);
    });
}

export async function publishTemplateUpdated(
  internalEventBus: TemplateEventBus,
  spaceId: string,
  template: SpaceAgentTemplate
): Promise<void> {
  if (!internalEventBus) return;
  await internalEventBus
    .publish('spaceAgentTemplate.updated', {
      sessionId: `space:${spaceId}`,
      spaceId,
      template,
    })
    .catch((err) => {
      log.warn('Failed to emit spaceAgentTemplate.updated:', err);
    });
}

export async function publishTemplateDeleted(
  internalEventBus: TemplateEventBus,
  spaceId: string,
  key: string
): Promise<void> {
  if (!internalEventBus) return;
  await internalEventBus
    .publish('spaceAgentTemplate.deleted', { sessionId: `space:${spaceId}`, spaceId, key })
    .catch((err) => {
      log.warn('Failed to emit spaceAgentTemplate.deleted:', err);
    });
}
