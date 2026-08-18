import type { MessageHub, NodeExecutionStatus } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';

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

  if (process.env.NODE_ENV !== 'production') {
    messageHub.onRequest('nodeExecution.create', async (data) => {
      const params = data as {
        workflowRunId: string;
        workflowNodeId: string;
        agentName: string;
        status?: NodeExecutionStatus;
      };

      if (!params.workflowRunId) throw new Error('workflowRunId is required');
      if (!params.workflowNodeId) throw new Error('workflowNodeId is required');
      if (!params.agentName) throw new Error('agentName is required');

      const run = workflowRunRepo.getRun(params.workflowRunId);
      if (!run) throw new Error(`WorkflowRun not found: ${params.workflowRunId}`);

      const execution = nodeExecutionRepo.createOrIgnore({
        workflowRunId: params.workflowRunId,
        workflowNodeId: params.workflowNodeId,
        agentName: params.agentName,
        status: params.status ?? 'in_progress',
      });

      if (params.status && execution.status !== params.status) {
        const updated = nodeExecutionRepo.update(execution.id, { status: params.status });
        if (updated) return { execution: updated };
      }

      return { execution };
    });

    messageHub.onRequest('nodeExecution.update', async (data) => {
      const params = data as {
        id: string;
        spaceId: string;
        status?: NodeExecutionStatus;
        result?: string | null;
        agentSessionId?: string | null;
      };

      if (!params.id) throw new Error('id is required');
      if (!params.spaceId) throw new Error('spaceId is required');
      if (
        params.status === undefined &&
        params.result === undefined &&
        params.agentSessionId === undefined
      ) {
        throw new Error('At least one update field is required');
      }

      const current = nodeExecutionRepo.getById(params.id);
      if (!current) throw new Error(`NodeExecution not found: ${params.id}`);

      const run = workflowRunRepo.getRun(current.workflowRunId);
      if (!run || run.spaceId !== params.spaceId) {
        throw new Error(`WorkflowRun not found: ${current.workflowRunId}`);
      }

      const updated = nodeExecutionRepo.update(params.id, {
        status: params.status,
        result: params.result,
        agentSessionId: params.agentSessionId,
      });
      if (!updated) throw new Error(`Failed to update NodeExecution: ${params.id}`);

      return { execution: updated };
    });
  }
}
