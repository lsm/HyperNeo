import type { OperationDefinition } from '../operations/registry.ts';
import {
  createWorkflowReadOperations,
  type WorkflowReadDependencies,
} from './workflow-read-operations.ts';
import {
  createWorkflowRunOperations,
  type WorkflowRunDependencies,
} from './workflow-run-operations.ts';

export type WorkflowOperationDependencies = WorkflowReadDependencies & WorkflowRunDependencies;

export function createWorkflowOperations(
  deps: WorkflowOperationDependencies
): OperationDefinition[] {
  return [...createWorkflowReadOperations(deps), ...createWorkflowRunOperations(deps)];
}
