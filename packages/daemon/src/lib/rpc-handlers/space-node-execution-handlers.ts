import type { MessageHub } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';

export function setupNodeExecutionHandlers(
  messageHub: MessageHub,
  nodeExecutionRepo: NodeExecutionRepository,
  workflowRunRepo: SpaceWorkflowRunRepository
): void {
  messageHub.onRequest('nodeExecution.list', async (data) => {
    const params = data as { workflowRunId: string; spaceId: string };

    if (!params.workflowRunId) {
      throw new Error('workflowRunId is required');
    }
    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    const run = workflowRunRepo.getRun(params.workflowRunId);
    if (!run || run.spaceId !== params.spaceId) {
      throw new Error(`WorkflowRun not found: ${params.workflowRunId}`);
    }

    const executions = nodeExecutionRepo.listByWorkflowRun(params.workflowRunId);

    return { executions };
  });
}
