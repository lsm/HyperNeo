import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import { createGetGoalOperation } from './get-goal-operation.ts';
import type { GoalCallerContext } from './goal-operation-scope.ts';
import { createListGoalEventsOperation } from './list-goal-events-operation.ts';
import { createListGoalTasksOperation } from './list-goal-tasks-operation.ts';
import { createListGoalsOperation } from './list-goals-operation.ts';
import type { SpaceGoalService } from './service.ts';

export interface GoalOperationDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'getGoal' | 'listGoals' | 'listGoalEvents'>;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'listByGoal'>;
}

export function createGoalOperations(deps: GoalOperationDependencies): OperationDefinition[] {
  return [
    createListGoalsOperation(deps),
    createGetGoalOperation(deps),
    createListGoalTasksOperation(deps),
    createListGoalEventsOperation(deps),
  ];
}
