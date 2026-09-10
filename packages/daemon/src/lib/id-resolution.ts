import { isUUID } from '@hyperneo/shared';

export type GoalRepoForResolve = {
  getGoalByShortId(roomId: string, shortId: string): { id: string } | null;
};

export function resolveGoalId(input: string, roomId: string, goalRepo: GoalRepoForResolve): string {
  if (isUUID(input)) {
    return input;
  }
  const goal = goalRepo.getGoalByShortId(roomId, input);
  if (!goal) {
    throw new Error(`Goal not found: ${input}`);
  }
  return goal.id;
}
