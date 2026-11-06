import type { SpaceGoal } from '@hyperneo/shared';
import type { SpaceGoalServiceDeps } from './service.ts';

export function runAtomic<T>(deps: SpaceGoalServiceDeps, fn: () => T): T {
  if (!deps.db) return fn();
  const reactive = deps.reactiveDb;
  reactive?.beginTransaction();
  try {
    const result = deps.db.transaction(fn)();
    reactive?.commitTransaction();
    return result;
  } catch (err) {
    reactive?.abortTransaction();
    throw err;
  }
}

export function requireGoal(deps: SpaceGoalServiceDeps, goalId: string): SpaceGoal {
  const goal = deps.goalRepo.getById(goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  return goal;
}

export function requireActiveSpaceForTaskCreation(
  deps: SpaceGoalServiceDeps,
  goal: SpaceGoal
): void {
  const space = deps.spaceRepo.getSpace(goal.spaceId);
  if (!space) throw new Error(`Space not found: ${goal.spaceId}`);
  if (space.status !== 'active' || space.paused || space.stopped) {
    throw new Error('Cannot create goal task in a non-active space');
  }
}
