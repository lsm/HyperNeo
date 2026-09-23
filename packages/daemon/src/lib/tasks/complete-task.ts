import type { SpaceApprovalSource, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import { Logger } from '../logger.ts';
import { normalizeMeaningfulTaskResult } from './result-utils.ts';

const log = new Logger('CompleteTask');
const warnEmit = (error: unknown) => log.warn('Failed to emit space.task.updated:', error);

type Input = { taskId: string; result?: string };

export type CompletionResult =
  | { accepted: true; task: SpaceTask }
  | { accepted: false; reason: string; detail?: string };
export type TaskCompletion = (input: Input, caller: OperationCaller) => Promise<CompletionResult>;

const reject = (reason: string, detail?: string) => ({
  reason: { accepted: false as const, reason, ...(detail === undefined ? {} : { detail }) },
});

async function admitCompletion(
  db: Database,
  input: Input,
  caller: OperationCaller,
  deps: CompleteTaskDependencies
): Promise<{ value: SpaceTask } | { reason: CompletionResult }> {
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || task.archivedAt || task.status !== 'approved')
    return reject('task_completion_unavailable');
  if (caller.source === 'mcp') {
    const session = caller.sessionId
      ? new SessionRepository(db).getSession(caller.sessionId)
      : null;
    if (
      !session ||
      session.status !== 'active' ||
      session.type !== 'worker' ||
      session.context?.taskId !== task.id ||
      session.context?.spaceId !== task.spaceId
    )
      return reject('task_completion_denied');
  }
  if (task.postApprovalSessionId && caller.sessionId !== task.postApprovalSessionId)
    return reject('task_completion_denied');
  if (!task.postApprovalSessionId && (await deps.requiresPostApprovalOwner?.(task, caller)))
    return reject('task_completion_unavailable');
  return { value: task };
}

async function admitCompletionGate(
  task: SpaceTask,
  caller: OperationCaller,
  deps: CompleteTaskDependencies
): Promise<{ value: SpaceTask } | { reason: CompletionResult }> {
  if (!deps.completionGate) return { value: task };
  const gate = await deps.completionGate(task, caller);
  return gate.ok ? { value: task } : reject('task_completion_unavailable', gate.error);
}

export interface CompleteTaskDependencies {
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'setTaskStatus'>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  requiresPostApprovalOwner?: (
    task: SpaceTask,
    caller: OperationCaller
  ) => boolean | Promise<boolean>;
  completionGate?: (
    task: SpaceTask,
    caller: OperationCaller
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  resolveResultArtifactSummary?: (task: SpaceTask) => string | null;
}

function resolveArtifactSummary(task: SpaceTask, deps: CompleteTaskDependencies): string | null {
  return normalizeMeaningfulTaskResult(deps.resolveResultArtifactSummary?.(task) ?? null);
}

function resolveReportedSummary(
  task: SpaceTask,
  artifactSummary: string | null
): string | undefined {
  return artifactSummary ?? normalizeMeaningfulTaskResult(task.reportedSummary) ?? undefined;
}

function resolveApprovalSource(task: SpaceTask, caller: OperationCaller): SpaceApprovalSource {
  return task.approvalSource ?? (caller.source === 'mcp' ? 'agent' : 'human');
}

async function completeApprovedTask(
  task: SpaceTask,
  input: Input,
  deps: CompleteTaskDependencies,
  artifactSummary: string | null,
  reportedSummary: string | undefined,
  approvalSource: SpaceApprovalSource
): Promise<CompletionResult> {
  const existingResult = normalizeMeaningfulTaskResult(task.result);
  const result =
    input.result ?? artifactSummary ?? existingResult ?? reportedSummary ?? 'Task completed.';
  const updated = await deps.getTaskManager(task.spaceId).setTaskStatus(task.id, 'done', {
    result,
    reportedSummary,
    approvalSource,
    expectedStatus: task.status,
    expectedPostApprovalSessionId: task.postApprovalSessionId ?? null,
    onCascadedTasks: async (cascaded) => {
      for (const cascadedTask of cascaded)
        await deps.emitTaskUpdated(task.spaceId, cascadedTask).catch(warnEmit);
    },
  });
  await deps.emitTaskUpdated(task.spaceId, updated).catch(warnEmit);
  return { accepted: true, task: updated };
}

export function createTaskCompletion(
  getDatabase: () => Database,
  dependencies: CompleteTaskDependencies
): TaskCompletion {
  return (superpipe({ getDatabase, deps: dependencies })('complete-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitCompletion, ['db', 'input', 'caller', 'deps'], 'result:outcome')
    .pipe(admitCompletionGate, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(resolveArtifactSummary, ['outcome', 'deps'], 'artifactSummary')
    .pipe(resolveReportedSummary, ['outcome', 'artifactSummary'], 'reportedSummary')
    .pipe(resolveApprovalSource, ['outcome', 'caller'], 'approvalSource')
    .pipe(
      completeApprovedTask,
      ['outcome', 'input', 'deps', 'artifactSummary', 'reportedSummary', 'approvalSource'],
      'outcome'
    )
    .endAsync('outcome') as TaskCompletion;
}
