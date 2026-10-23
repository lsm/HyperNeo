import {
  NEO_WORK_GOAL_MERGE,
  NEO_WORK_GOAL_PR_EVENTS,
  NEO_WORK_GOAL_PR_SUBSCRIBE,
} from '@hyperneo/prompts';
import type { NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
import { withWorkGoal } from '../../driver-work.ts';

export function withCodingWorkGoal(
  instruction: string,
  goal: NeoWorkGoal | null,
  eventsDelivered = true
): string {
  return withWorkGoal(
    instruction,
    goal,
    /merg/i.test(goal?.doneWhen ?? '')
      ? [
          NEO_WORK_GOAL_MERGE,
          eventsDelivered ? NEO_WORK_GOAL_PR_EVENTS : NEO_WORK_GOAL_PR_SUBSCRIBE,
        ]
      : []
  );
}
