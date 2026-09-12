import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { createPrMergedGate } from '../tools/end-node-handlers.ts';
import type { CompleteTaskDependencies } from './complete-task.ts';

export function createCompletionGateBindings(deps: {
  resolveWorkflowForTask: (task: SpaceTask) => SpaceWorkflow | null;
  isCoderOwnedMergeWorkflow: (workflow: SpaceWorkflow | null) => boolean;
  resolvePrUrl: (task: SpaceTask) => string;
  getPrState: (prUrl: string) => Promise<string>;
  workflowDeclaresPostApprovalRoute: (taskId: string) => boolean;
}): Pick<CompleteTaskDependencies, 'requiresPostApprovalOwner' | 'completionGate'> {
  const prMergedGate = createPrMergedGate({
    requirePrUrl: true,
    resolvePrUrl: deps.resolvePrUrl,
    getPrState: deps.getPrState,
  });
  return {
    requiresPostApprovalOwner: (task: SpaceTask) => deps.workflowDeclaresPostApprovalRoute(task.id),
    completionGate: async (task: SpaceTask) =>
      deps.isCoderOwnedMergeWorkflow(deps.resolveWorkflowForTask(task))
        ? prMergedGate(task)
        : { ok: true as const },
  };
}
