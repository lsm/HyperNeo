import type { OperationDefinition } from '../operations/registry.ts';
import { createGetGoalOperation } from './get-goal-operation.ts';
import type { GoalCallerContext } from './goal-operation-scope.ts';
import { createListGoalsOperation } from './list-goals-operation.ts';
import type { SpaceGoalService } from './service.ts';

export interface GoalOperationDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'getGoal' | 'listGoals'>;
}

export function createGoalOperations(deps: GoalOperationDependencies): OperationDefinition[] {
  return [createListGoalsOperation(deps), createGetGoalOperation(deps)];
}
