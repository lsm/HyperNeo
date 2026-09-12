import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type { OperationCaller } from '../../operations/registry.ts';
import { createPrMergedGate } from '../tools/end-node-handlers.ts';
import type { CompleteTaskDependencies } from './complete-task.ts';

export interface CompletionGateRuntimeDependencies {
  resolveWorkflowForTask: (task: SpaceTask) => SpaceWorkflow | null;
  isCoderOwnedMergeWorkflow: (workflow: SpaceWorkflow | null) => boolean;
  resolvePrUrl: (task: SpaceTask) => string;
  getPrState: (prUrl: string) => Promise<string>;
  hasDispatchedPostApprovalRoute: (taskId: string, sessionId: string) => boolean;
}

export function createCompletionGateBindings(
  deps: CompletionGateRuntimeDependencies
): Pick<CompleteTaskDependencies, 'requiresPostApprovalOwner' | 'completionGate'> {
  const prMergedGate = createPrMergedGate({
    requirePrUrl: true,
    resolvePrUrl: deps.resolvePrUrl,
    getPrState: deps.getPrState,
  });
  return {
    requiresPostApprovalOwner: (task: SpaceTask, caller: OperationCaller) =>
      caller.source === 'mcp' && !!caller.sessionId
        ? deps.hasDispatchedPostApprovalRoute(task.id, caller.sessionId)
        : false,
    completionGate: (task: SpaceTask) =>
      deps.isCoderOwnedMergeWorkflow(deps.resolveWorkflowForTask(task))
        ? prMergedGate(task)
        : Promise.resolve({ ok: true as const }),
  };
}
