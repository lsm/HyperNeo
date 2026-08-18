import type { SpaceWorkflow } from '@hyperneo/shared';

export interface WorkflowSelectionContext {
  spaceId: string;
  availableWorkflows: SpaceWorkflow[];
  workflowId?: string;
}

export function selectWorkflow(context: WorkflowSelectionContext): SpaceWorkflow | null {
  const { availableWorkflows, workflowId } = context;

  if (!workflowId) {
    return null;
  }

  return availableWorkflows.find((w) => w.id === workflowId) ?? null;
}
