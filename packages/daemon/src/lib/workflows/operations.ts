import type { OperationDefinition } from '../operations/registry.ts';
import {
  createWorkflowReadOperations,
  type WorkflowReadDependencies,
} from './workflow-read-operations.ts';

export type WorkflowOperationDependencies = WorkflowReadDependencies;

export function createWorkflowOperations(
  deps: WorkflowOperationDependencies
): OperationDefinition[] {
  return createWorkflowReadOperations(deps);
}
