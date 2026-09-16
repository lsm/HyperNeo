import type { OperationDefinition } from '../operations/registry.ts';
import { type CreateGoalDependencies, createCreateGoalOperation } from './create-goal-operation.ts';
import { createGetGoalOperation, type GetGoalDependencies } from './get-goal-operation.ts';
import {
  createPauseGoalOperation,
  createResumeGoalOperation,
  createTriggerGoalTaskOperation,
  type GoalStateDependencies,
} from './goal-state-operations.ts';
import {
  createListGoalEventsOperation,
  type ListGoalEventsDependencies,
} from './list-goal-events-operation.ts';
import {
  createListGoalTasksOperation,
  type ListGoalTasksDependencies,
} from './list-goal-tasks-operation.ts';
import { createListGoalsOperation, type ListGoalsDependencies } from './list-goals-operation.ts';
import {
  createReviewGoalOutcomeOperation,
  type ReviewGoalOutcomeDependencies,
} from './review-goal-outcome-operation.ts';
import { createUpdateGoalOperation, type UpdateGoalDependencies } from './update-goal-operation.ts';

export type GoalOperationDependencies = ListGoalsDependencies &
  GetGoalDependencies &
  ListGoalTasksDependencies &
  ListGoalEventsDependencies &
  CreateGoalDependencies &
  UpdateGoalDependencies &
  GoalStateDependencies &
  ReviewGoalOutcomeDependencies;

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
