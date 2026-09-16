import type { OperationDefinition } from '../../operations/registry.ts';
import { createWorkflowOperations } from '../../workflows/operations.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerWorkflowOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createWorkflowOperations({
    listWorkflowSummaries: (spaceId) => context.spaceWorkflowManager.listWorkflowSummaries(spaceId),
    getWorkflow: (workflowId) => context.spaceWorkflowManager.getWorkflow(workflowId),
    getWorkflowByHandle: (spaceId, handle) =>
      context.spaceWorkflowManager.getWorkflowByHandle(spaceId, handle),
  });
}
