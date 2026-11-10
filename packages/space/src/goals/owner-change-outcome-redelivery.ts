import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../daemon/src/lib/internal-event-bus.ts';
import { Logger } from '../../../daemon/src/lib/logger.ts';

const log = new Logger('goal-owner-change-outcome-redelivery');

export interface GoalOwnerChangeOutcomeRedeliveryDeps {
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  recoverPendingOutcomeNotificationsForGoal: (goalId: string) => Promise<void>;
}

export function subscribeGoalOwnerChangeOutcomeRedelivery(
  deps: GoalOwnerChangeOutcomeRedeliveryDeps
): () => void {
  return deps.internalEventBus.subscribe(
    'spaceGoal.ownerChanged',
    (event) => {
      if (!event.goalId) return;
      void deps.recoverPendingOutcomeNotificationsForGoal(event.goalId).catch((err: unknown) => {
        log.warn(
          `Outcome wake redelivery after goal owner change failed for goal "${event.goalId}": ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },
    { subscriberName: 'goal-owner-change-outcome-redelivery' }
  );
}
