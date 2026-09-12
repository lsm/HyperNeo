import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { TaskCoreSchema } from '../../operations/task-get.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('CompleteTask');
const warnEmit = (error: unknown) => log.warn('Failed to emit space.task.updated:', error);

const inputSchema = z.object({ taskId: z.string().min(1), result: z.string().optional() }).strict();
type Input = z.infer<typeof inputSchema>;

type CompletionResult =
  | { accepted: true; task: SpaceTask }
  | { accepted: false; reason: string; detail?: string };

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
}

async function completeApprovedTask(
  task: SpaceTask,
  input: Input,
  deps: CompleteTaskDependencies
): Promise<CompletionResult> {
  const updated = await deps.getTaskManager(task.spaceId).setTaskStatus(task.id, 'done', {
    result: input.result,
    expectedPostApprovalSessionId: task.postApprovalSessionId ?? null,
    onCascadedTasks: async (cascaded) => {
      for (const cascadedTask of cascaded)
        await deps.emitTaskUpdated(task.spaceId, cascadedTask).catch(warnEmit);
    },
  });
  await deps.emitTaskUpdated(task.spaceId, updated).catch(warnEmit);
  return { accepted: true, task: updated };
}

export function createCompleteTaskOperation(
  getDatabase: () => Database,
  dependencies: CompleteTaskDependencies
) {
  const complete = (superpipe({ getDatabase, deps: dependencies })('complete-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitCompletion, ['db', 'input', 'caller', 'deps'], 'result:outcome')
    .pipe(admitCompletionGate, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(completeApprovedTask, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<CompletionResult>;
  return defineOperation({
    name: 'task.complete',
    description:
      'Synchronously transition a Space task from `approved` to `done`, with an optional result, and return the updated task. RPC and internal callers are admitted directly; an MCP caller must be the task’s own worker session (session.context.taskId/spaceId match). Once a post-approval session is routed onto the task (`task.postApprovalSessionId`), only that session may complete it — any other caller, including RPC/internal callers without a matching session id, is denied; before routing, a caller-supplied `requiresPostApprovalOwner` dependency can block completion until routing happens. After ownership admits the caller, an optional `completionGate` dependency (bound per task at registration to a workflow completion gate, such as the coder-owned-merge PR-merge check) may still reject with task_completion_unavailable and a `detail` message. Rejects task_completion_unavailable when the task is missing, not Space-owned, archived, not currently `approved`, awaiting a still-unrouted required post-approval session, or blocked by the completion gate (retry after state changes), and task_completion_denied when the calling MCP session is not that worker session or the caller is not the routed post-approval session (do not retry). A task whose status changes between admission and the manager call throws through as execution_failed rather than being reported as task_completion_unavailable. This binding does not yet apply the legacy `goal_update` field. Callers wanting the `mark_complete` tool’s artifact-summary result fallback must pass `result` themselves.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), task: TaskCoreSchema }),
      z.object({ accepted: z.literal(false), reason: z.string(), detail: z.string().optional() }),
    ]),
    execute: async (input, caller) => complete(input, caller),
  });
}
