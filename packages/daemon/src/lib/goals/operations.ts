import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import { createCreateGoalOperation } from './create-goal-operation.ts';
import { createGetGoalOperation } from './get-goal-operation.ts';
import type { GoalCallerContext } from './goal-operation-scope.ts';
import {
  createPauseGoalOperation,
  createResumeGoalOperation,
  createTriggerGoalTaskOperation,
} from './goal-state-operations.ts';
import { createListGoalEventsOperation } from './list-goal-events-operation.ts';
import { createListGoalTasksOperation } from './list-goal-tasks-operation.ts';
import { createListGoalsOperation } from './list-goals-operation.ts';
import { createReviewGoalOutcomeOperation } from './review-goal-outcome-operation.ts';
import type { SpaceGoalService } from './service.ts';
import { createUpdateGoalOperation } from './update-goal-operation.ts';

export interface GoalOperationDependencies extends GoalCallerContext {
  readonly goalService: SpaceGoalService;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'listByGoal'>;
}

export function createGoalOperations(deps: GoalOperationDependencies): OperationDefinition[] {
  return [
    createListGoalsOperation(deps),
    createGetGoalOperation(deps),
    createListGoalTasksOperation(deps),
    createListGoalEventsOperation(deps),
    createCreateGoalOperation(deps),
    createUpdateGoalOperation(deps),
    createPauseGoalOperation(deps),
    createResumeGoalOperation(deps),
    createTriggerGoalTaskOperation(deps),
    createReviewGoalOutcomeOperation(deps),
  ];
}
