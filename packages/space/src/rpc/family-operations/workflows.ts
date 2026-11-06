import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import { createWorkflowOperations } from '../../../../daemon/src/lib/workflows/operations.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerWorkflowOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createWorkflowOperations({
    getSession: (sessionId) => context.deps.db.getSession(sessionId),
    taskRepo: context.spaceTaskRepo,
    nodeExecutionRepo: context.nodeExecutionRepo,
    longHorizonAgentRepo: context.longHorizonAgentRepo,
    hasDirectWorkerProvenance: context.hasDirectWorkerProvenance,
    resolveDirectWorker: context.resolveDirectWorker,
    listWorkflowSummaries: (spaceId) => context.spaceWorkflowManager.listWorkflowSummaries(spaceId),
    getWorkflow: (workflowId) => context.spaceWorkflowManager.getWorkflow(workflowId),
    getWorkflowByHandle: (spaceId, handle) =>
      context.spaceWorkflowManager.getWorkflowByHandle(spaceId, handle),
    getRun: (runId) => context.spaceWorkflowRunRepo.getRun(runId),
    updateRunDescription: (runId, description) =>
      context.spaceWorkflowRunRepo.updateRun(runId, { description }),
    listRunExecutions: (runId) => context.nodeExecutionRepo.listByWorkflowRun(runId),
    cancelWorkflowRun: (spaceId, runId) =>
      context.spaceRuntimeService.getSharedRuntime().cancelWorkflowRun(spaceId, runId),
    startWorkflowRun: (spaceId, workflowId, title, description) =>
      context.spaceRuntimeService
        .getSharedRuntime()
        .startWorkflowRun(spaceId, workflowId, title, description),
  });
}
