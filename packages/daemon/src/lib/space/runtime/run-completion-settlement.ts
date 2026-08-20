import type { NodeExecution, SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import type { PostApprovalRouteResult } from './post-approval-router';

export type PostApprovalDispatchMode = PostApprovalRouteResult['mode'];

export interface CompletionSummaryInput {
  summaryFromArtifact: string | null;
  computedSummary: string | null;
  existingResult: string | null;
  reportedSummary: string | null;
}

export interface CompletionSummaryResolution {
  nextTaskResult: string | null;
  nextReportedSummary: string | null;
}

export function resolveCompletionSummaries(
  input: CompletionSummaryInput
): CompletionSummaryResolution {
  const freshSummary = input.summaryFromArtifact ?? input.computedSummary ?? null;
  return {
    nextTaskResult: freshSummary ?? input.existingResult ?? input.reportedSummary ?? null,
    nextReportedSummary: freshSummary ?? input.reportedSummary ?? null,
  };
}

export function isTaskAlreadyResolved(status: SpaceTaskStatus): boolean {
  return (
    status === 'done' ||
    status === 'review' ||
    status === 'cancelled' ||
    status === 'approved' ||
    status === 'blocked'
  );
}

export function mapFinalTaskStatus(
  dispatchMode: PostApprovalDispatchMode,
  currentStatus: SpaceTaskStatus
): SpaceTaskStatus {
  if (dispatchMode === 'no-route') return 'done';
  if (dispatchMode === 'skipped') return currentStatus;
  return 'approved';
}

export function resolveSpawnedPostApprovalSession(
  mode: PostApprovalDispatchMode,
  postApprovalSessionId: string | undefined
): string | undefined {
  return mode === 'spawn' || mode === 'already-routed' ? postApprovalSessionId : undefined;
}

export function isSettlementTerminal(status: SpaceTaskStatus): boolean {
  return (
    status === 'done' || status === 'cancelled' || status === 'blocked' || status === 'approved'
  );
}

export function resolveQuiesceSourceNodeId(
  task: Pick<SpaceTask, 'postApprovalSourceNodeId' | 'pendingCompletionSubmittedByNodeId'>,
  endNodeId: string | undefined
): string | null {
  return (
    task.postApprovalSourceNodeId ?? task.pendingCompletionSubmittedByNodeId ?? endNodeId ?? null
  );
}

export function selectSiblingsToQuiesce(
  executions: readonly NodeExecution[],
  spawnedPostApprovalSessionId: string | undefined,
  sourceNodeId: string | null | undefined
): NodeExecution[] {
  return executions.filter(
    (execution) =>
      execution.status === 'in_progress' &&
      execution.agentSessionId &&
      execution.agentSessionId !== spawnedPostApprovalSessionId &&
      (!sourceNodeId || execution.workflowNodeId !== sourceNodeId)
  );
}
