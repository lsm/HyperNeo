import type { CreateWorkflowRunParams, SpaceWorkflowRun } from '@hyperneo/shared';
import type { SpaceWorkflowManager } from '../../../src/lib/workflows/workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';

export function createPinnedWorkflowRun(
  workflowRunRepo: SpaceWorkflowRunRepository,
  workflowManager: SpaceWorkflowManager,
  params: CreateWorkflowRunParams
): SpaceWorkflowRun {
  const rawWorkflow = workflowManager.getWorkflow(params.workflowId);
  if (!rawWorkflow) throw new Error(`Test workflow not found: ${params.workflowId}`);
  return workflowRunRepo.createPinnedRun({ ...params, rawWorkflow });
}
