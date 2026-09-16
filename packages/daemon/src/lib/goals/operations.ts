import type { OperationDefinition } from '../operations/registry.ts';
import { createGetGoalOperation, type GetGoalDependencies } from './get-goal-operation.ts';
import {
  createListGoalEventsOperation,
  type ListGoalEventsDependencies,
} from './list-goal-events-operation.ts';
import {
  createListGoalTasksOperation,
  type ListGoalTasksDependencies,
} from './list-goal-tasks-operation.ts';
import { createListGoalsOperation, type ListGoalsDependencies } from './list-goals-operation.ts';

export type GoalOperationDependencies = ListGoalsDependencies &
  GetGoalDependencies &
  ListGoalTasksDependencies &
  ListGoalEventsDependencies;

export function createGoalOperations(deps: GoalOperationDependencies): OperationDefinition[] {
  return [
    createListGoalsOperation(deps),
    createGetGoalOperation(deps),
    createListGoalTasksOperation(deps),
    createListGoalEventsOperation(deps),
  ];
}
