import type { SpaceTask } from '@hyperneo/shared';

export function requireDependencyExecutionBlock(previous: SpaceTask | null, updated: SpaceTask) {
  return previous?.status === 'in_progress' &&
    previous.workflowRunId &&
    updated.status === 'blocked' &&
    updated.blockReason === 'dependency_added'
    ? { value: updated }
    : { reason: { task: updated, handledByRuntime: false } };
}
