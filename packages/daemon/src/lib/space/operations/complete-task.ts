import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { TaskCoreSchema } from '../../operations/task-get.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';

const inputSchema = z.object({ taskId: z.string().min(1), result: z.string().optional() }).strict();
type Input = z.infer<typeof inputSchema>;

type CompletionResult = { accepted: true; task: SpaceTask } | { accepted: false; reason: string };

function admitCompletion(
  db: Database,
  input: Input,
  caller: OperationCaller
): { value: SpaceTask } | { reason: CompletionResult } {
  const unavailable = {
    reason: { accepted: false as const, reason: 'task_completion_unavailable' },
  };
  const denied = { reason: { accepted: false as const, reason: 'task_completion_denied' } };
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || task.archivedAt || task.status !== 'approved') return unavailable;
  if (caller.source === 'mcp') {
    const session = caller.sessionId
      ? new SessionRepository(db).getSession(caller.sessionId)
      : null;
    if (
      !session ||
      session.type !== 'worker' ||
      session.context?.taskId !== task.id ||
      session.context?.spaceId !== task.spaceId
    )
      return denied;
  }
  return { value: task };
}

async function completeApprovedTask(
  task: SpaceTask,
  input: Input,
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'setTaskStatus'>,
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>
): Promise<CompletionResult> {
  const updated = await getTaskManager(task.spaceId).setTaskStatus(task.id, 'done', {
    result: input.result,
    onCascadedTasks: async (cascaded) => {
      for (const cascadedTask of cascaded) await emitTaskUpdated(task.spaceId, cascadedTask);
    },
  });
  await emitTaskUpdated(task.spaceId, updated);
  return { accepted: true, task: updated };
}

export interface CompleteTaskDependencies {
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'setTaskStatus'>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
}

export function createCompleteTaskOperation(
  getDatabase: () => Database,
  dependencies: CompleteTaskDependencies
) {
  const complete = (superpipe({ getDatabase, ...dependencies })('complete-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitCompletion, ['db', 'input', 'caller'], 'result:outcome')
    .pipe(
      completeApprovedTask,
      ['outcome', 'input', 'getTaskManager', 'emitTaskUpdated'],
      'outcome'
    )
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<CompletionResult>;
  return defineOperation({
    name: 'task.complete',
    description:
      'Synchronously transition a Space task from `approved` to `done`, with an optional result, and return the updated task. RPC and internal callers are admitted directly; an MCP caller must be the task’s own worker session (session.context.taskId/spaceId match). Rejects task_completion_unavailable when the task is missing, not Space-owned, archived, or not currently `approved` (retry after state changes), and task_completion_denied when the calling MCP session is not that worker session (do not retry). This binding does not yet enforce post-approval session ownership (`task.postApprovalSessionId` / `requiresPostApprovalOwner`); it also does not apply workflow completion gates (the coder-owned-merge PR gate) or the legacy `goal_update` field. Callers wanting the `mark_complete` tool’s artifact-summary result fallback must pass `result` themselves.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), task: TaskCoreSchema }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => complete(input, caller),
  });
}
