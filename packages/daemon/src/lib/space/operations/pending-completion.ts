import { PendingCompletionSupersededError } from './pending-completion-guard.ts';
import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { mapPostApprovalDispatchWarning } from '../runtime/post-approval-router.ts';

type Awaitable<T> = T | Promise<T>;

export interface PendingCompletionInput {
  taskId: string;
  approved: boolean;
  reason?: string | null;
}

type PendingCompletionDecision = Omit<PendingCompletionInput, 'reason'> & { reason: string | null };

export type PendingCompletionReopenResult = SpaceTask | { task: SpaceTask; reasonPersisted: true };

export interface PendingCompletionDependencies {
  getTask: (taskId: string) => Awaitable<SpaceTask | null>;
  dispatchApproval: (taskId: string, reason: string | null) => Promise<unknown>;
  reopenTask: (taskId: string, reason: string | null) => Promise<PendingCompletionReopenResult>;
  updateTask: (
    taskId: string,
    fields: { approvalReason?: string | null; postApprovalBlockedReason?: string }
  ) => Promise<SpaceTask>;
  warn: (taskId: string, detail: string) => void;
}

export function normalizePendingCompletion(
  input: PendingCompletionInput
): PendingCompletionDecision {
  return { ...input, reason: input.reason ?? null };
}

export async function rejectPendingCompletion(
  decision: PendingCompletionDecision,
  reopenTask: PendingCompletionDependencies['reopenTask'],
  updateTask: PendingCompletionDependencies['updateTask']
): Promise<{ value: PendingCompletionDecision } | { reason: SpaceTask }> {
  if (decision.approved) return { value: decision };
  const reopened = await reopenTask(decision.taskId, decision.reason);
  if ('reasonPersisted' in reopened) return { reason: reopened.task };
  return { reason: await updateTask(decision.taskId, { approvalReason: decision.reason }) };
}

export function hasCommittedPendingApproval(task: SpaceTask | null): boolean {
  return task?.status === 'approved';
}

export async function dispatchPendingCompletion(
  decision: PendingCompletionDecision,
  dispatchApproval: PendingCompletionDependencies['dispatchApproval'],
  getTask: PendingCompletionDependencies['getTask'],
  updateTask: PendingCompletionDependencies['updateTask'],
  warn: PendingCompletionDependencies['warn']
): Promise<void> {
  if (!decision.approved) return;
  try {
    await dispatchApproval(decision.taskId, decision.reason);
  } catch (error) {
    if (error instanceof PendingCompletionSupersededError) throw error;
    const afterCommit = await getTask(decision.taskId);
    if (!hasCommittedPendingApproval(afterCommit)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    warn(decision.taskId, detail);
    await updateTask(decision.taskId, {
      postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
    });
  }
}

export async function readPendingCompletionResult(
  getTask: PendingCompletionDependencies['getTask'],
  decision: PendingCompletionDecision,
  rejection?: Awaited<ReturnType<typeof rejectPendingCompletion>>
): Promise<{ value: SpaceTask }> {
  if (rejection && 'reason' in rejection) return { value: rejection.reason };
  const task = await getTask(decision.taskId);
  if (!task) throw new Error(`Task not found: ${decision.taskId}`);
  return { value: task };
}

export function createPendingCompletionOperation(dependencies: PendingCompletionDependencies) {
  return (superpipe({ ...dependencies })('resolve-pending-completion') as PipelineAPI)
    .input('input')
    .pipe(normalizePendingCompletion, 'input', 'decision')
    .pipe(rejectPendingCompletion, ['decision', 'reopenTask', 'updateTask'], 'result:task')
    .pipe(dispatchPendingCompletion, [
      'decision',
      'dispatchApproval',
      'getTask',
      'updateTask',
      'warn',
    ])
    .pipe(readPendingCompletionResult, ['getTask', 'decision'], 'result:task')
    .endAsync('task') as (input: PendingCompletionInput) => Promise<SpaceTask>;
}
