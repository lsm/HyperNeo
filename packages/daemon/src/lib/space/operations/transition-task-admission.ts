import type { Session, SpaceTask } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { transitionStandaloneTask } from '../../../storage/tasks/transition-task.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import { TaskCoreSchema } from '../../operations/task-get.ts';
import type { StandaloneTaskStatus } from '../../tasks/standalone-lifecycle.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { admitSpaceTaskCaller, resolveSpaceTaskOwner } from './task-metadata.ts';

export const SpaceTransitionTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    status: TaskCoreSchema.shape.status,
    result: z.string().optional(),
  })
  .strict();
export type SpaceTransitionTaskInput = z.infer<typeof SpaceTransitionTaskInputSchema>;
type In = SpaceTransitionTaskInput;
type Rejection = 'unsupported_status' | 'invalid_transition' | 'result_requires_done';
type Result = TaskCore | Rejection | null;
export type Gate<T, R> = { value: T } | { reason: R };
export type OwnedTask = { spaceId: string; task: SpaceTask };
export type SpaceTransitionAdmissionDependencies = SpaceMcpSessionPolicyContext & {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask'>;
  notifyStandalone: () => void;
};
type Deps = SpaceTransitionAdmissionDependencies;

export function resolveOwner(input: In, deps: Deps): Gate<string, Result> {
  const owner = resolveSpaceTaskOwner(deps.db, input.taskId);
  if (owner === null) return { reason: null };
  if (owner.kind !== 'standalone') return { value: owner.spaceId };
  const standalone = {
    taskId: input.taskId,
    status: input.status as StandaloneTaskStatus,
    result: input.result,
  };
  return { reason: transitionStandaloneTask(deps.db, standalone, deps.notifyStandalone) };
}
export function admitCaller(
  spaceId: string,
  caller: OperationCaller,
  deps: Deps
): Gate<string, null> {
  const admitted = admitSpaceTaskCaller({ kind: 'space', spaceId }, caller, deps);
  return 'reason' in admitted ? { reason: null } : { value: spaceId };
}
export async function loadTask(
  spaceId: string,
  input: In,
  deps: Deps
): Promise<Gate<OwnedTask, null>> {
  const task = await deps.getTaskManager(spaceId).getTask(input.taskId);
  return task ? { value: { spaceId, task } } : { reason: null };
}
export function rejectActiveDirectAttempt(
  owned: OwnedTask,
  deps: Deps
): Gate<OwnedTask, 'unsupported_status'> {
  const attempt = new DirectTaskExecutionRepository(deps.db).getActive(owned.task.id);
  return attempt ? { reason: 'unsupported_status' } : { value: owned };
}
