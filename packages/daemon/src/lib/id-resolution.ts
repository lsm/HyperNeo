import { isUUID } from '@hyperneo/shared';

export type TaskRepoForResolve = {
  getTaskByShortId(roomId: string, shortId: string): { id: string } | null;
};

export type GoalRepoForResolve = {
  getGoalByShortId(roomId: string, shortId: string): { id: string } | null;
};

export function resolveTaskId(input: string, roomId: string, taskRepo: TaskRepoForResolve): string {
  if (isUUID(input)) {
    return input;
  }
  const task = taskRepo.getTaskByShortId(roomId, input);
  if (!task) {
    throw new Error(`Task not found: ${input}`);
  }
  return task.id;
}

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
