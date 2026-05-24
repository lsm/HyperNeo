import { isUUID } from '@neokai/shared';

/**
 * Minimal interface for task short-ID lookup. Satisfied by TaskRepository.
 */
export type TaskRepoForResolve = {
  getTaskByShortId(roomId: string, shortId: string): { id: string } | null;
};

/**
 * Minimal interface for goal short-ID lookup. Satisfied by GoalRepository.
 */
export type GoalRepoForResolve = {
  getGoalByShortId(roomId: string, shortId: string): { id: string } | null;
};

/**
 * Resolves a task identifier (UUID or short ID) to a UUID.
 * - If `input` is already a UUID, it is returned as-is (no DB lookup).
 * - Otherwise, performs a short ID lookup via `taskRepo.getTaskByShortId`.
 * @throws {Error} with message 'Task not found' when the short ID cannot be resolved.
 */
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

/**
 * Resolves a goal identifier (UUID or short ID) to a UUID.
 * - If `input` is already a UUID, it is returned as-is (no DB lookup).
 * - Otherwise, performs a short ID lookup via `goalRepo.getGoalByShortId`.
 * @throws {Error} with message 'Goal not found' when the short ID cannot be resolved.
 */
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
