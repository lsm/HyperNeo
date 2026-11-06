import { createSessionEventOperations } from '../../external-events/session-event-operations.ts';
import { SessionExternalEventStore } from '../../external-events/session-external-event-store.ts';
import { MAILBOX_LANE } from '../../mailbox/enqueue.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { SessionEventSubscriptionRepository } from '../../../storage/repositories/session-event-subscription-repository.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerSessionEventOperations(
  context: Pick<FamilyOperationContext, 'deps' | 'sessionSpace'>
): OperationDefinition[] {
  if (context.sessionSpace) return [];
  const { db, jobQueue, watchSessionRepo } = context.deps;
  return createSessionEventOperations({
    subscriptions: new SessionEventSubscriptionRepository(db.getDatabase()),
    events: new SessionExternalEventStore(db.getDatabase()),
    getSession: (sessionId) => db.getSession(sessionId),
    deliveryJob: (messageUuid) => jobQueue.getLatestByPayload(MAILBOX_LANE, { messageUuid }),
    sendStatus: (sessionId, messageUuid) =>
      db.getSDKMessageRepo().getDeliveryContent(sessionId, messageUuid)?.sendStatus ?? null,
    watchSessionRepo,
  });
}
