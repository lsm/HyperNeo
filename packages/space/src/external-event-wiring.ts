import type { ReactiveDatabase } from '../../daemon/src/storage/reactive-database.ts';
import { SpaceAgentRepository } from '../../daemon/src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentSubscriptionRepository } from '../../daemon/src/storage/repositories/space-agent-subscription-repository.ts';
import { SpaceSessionEventSubscriptionRepository } from '../../daemon/src/storage/repositories/space-session-event-subscription-repository.ts';
import { SpaceWorkflowEventSubscriptionRepository } from '../../daemon/src/storage/repositories/space-workflow-event-subscription-repository.ts';
import type { Database as BunDatabase } from '../../daemon/src/storage/sqlite-compat.ts';
import { ExternalEventService } from '../../daemon/src/lib/external-events/external-event-service.ts';
import { ExternalEventStore } from './external-events/external-event-store.ts';
import { composeLongHorizonSubscriptionPattern } from '../../daemon/src/lib/external-events/long-horizon-subscription-pattern.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../daemon/src/lib/internal-event-bus.ts';

export function createSpaceExternalEvents(
  db: BunDatabase,
  reactiveDb: ReactiveDatabase,
  bus: InternalEventBus<DaemonInternalEventMap>
) {
  const store = new ExternalEventStore(db, reactiveDb);
  const sessions = new SpaceSessionEventSubscriptionRepository(db);
  const workflows = new SpaceWorkflowEventSubscriptionRepository(db);
  const agents = new SpaceAgentSubscriptionRepository(db, new SpaceAgentRepository(db));
  return {
    store,
    service: new ExternalEventService(store, bus),
    subscribedTopics: (spaceId: string): string[] => [
      ...sessions.listBySpace(spaceId).map((subscription) => subscription.topic),
      ...workflows.listBySpace(spaceId).map((subscription) => subscription.topic),
      ...agents.listActiveSubscriptionsBySpace(spaceId).flatMap((subscription) => {
        try {
          return [composeLongHorizonSubscriptionPattern(subscription.source, subscription.topic)];
        } catch {
          return [];
        }
      }),
    ],
  };
}
