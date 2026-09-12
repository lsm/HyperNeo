import type { Session, Space, SpaceTask } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { createStandaloneTask } from '../../../storage/tasks/create-task.ts';
import { Logger } from '../../logger.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import { createCreateTaskOperation } from '../../operations/task-create.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import {
  resolveCreatedBy,
  resolveCreateTaskTarget,
  type SpaceCreateTaskInput,
  SpaceCreateTaskInputSchema,
} from './create-task-target.ts';
import { resolveMetadataSessionSpace } from './task-metadata.ts';

const log = new Logger('SpaceCreateTask');
export interface SpaceCreateTaskDependencies extends SpaceMcpSessionPolicyContext {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'createTask'>;
  notifyStandalone: () => void;
  emitTaskCreated: (spaceId: string, task: SpaceTask) => Promise<void>;
  getSpace: (spaceId: string) => Promise<Space | null> | Space | null;
  validateDefaultTaskWorkspace: (spaceId: string) => Promise<string | null>;
}
type Deps = SpaceCreateTaskDependencies;
type In = SpaceCreateTaskInput;
type Caller = OperationCaller;
type Sess = Session | null;
type Opt = string | undefined;
type Gate = { value: string } | { reason: TaskCore };
type CreateFn = (input: In, sessionId: Opt, caller: Caller) => Promise<TaskCore>;

function resolveCallerSession(caller: Caller, deps: Deps): Sess {
  return caller.source === 'mcp' && caller.sessionId ? deps.getSession(caller.sessionId) : null;
}
function requireCreateTarget(input: In, caller: Caller, session: Sess, deps: Deps): Opt {
  const target = resolveCreateTaskTarget(input, caller, resolveMetadataSessionSpace(session, deps));
  if ('reason' in target) throw new Error(target.reason);
  return target.value.spaceId;
}
function createStandaloneWhenUnowned(spaceId: Opt, input: In, caller: Caller, deps: Deps): Gate {
  if (spaceId !== undefined) return { value: spaceId };
  const task = createStandaloneTask(deps.db, input, caller.sessionId, deps.notifyStandalone);
  return { reason: task };
}
async function requireSpace(spaceId: string, deps: Deps): Promise<void> {
  if (!(await deps.getSpace(spaceId))) throw new Error(`Space not found: ${spaceId}`);
}
async function requireUsableWorkspace(spaceId: string, input: In, deps: Deps): Promise<void> {
  if (input.workspacePath === undefined) {
    const error = await deps.validateDefaultTaskWorkspace(spaceId);
    if (error) throw new Error(error);
  }
}
async function createSpaceTask(
  spaceId: string,
  input: In,
  caller: Caller,
  session: Sess,
  deps: Deps
): Promise<SpaceTask> {
  return deps.getTaskManager(spaceId).createTask({
    title: input.title,
    description: input.description ?? '',
    priority: input.priority,
    labels: input.labels,
    dependsOn: input.dependsOn,
    status: input.draft ? 'draft' : undefined,
    preferredWorkflowId: input.preferredWorkflowId,
    workspacePath: input.workspacePath,
    createdBySession: caller.source === 'mcp' ? (caller.sessionId ?? null) : null,
    createdBy: caller.source === 'mcp' ? resolveCreatedBy(session) : null,
  });
}
async function publishCreated(task: SpaceTask, deps: Deps): Promise<SpaceTask> {
  await deps.emitTaskCreated(task.spaceId, task).catch((error: unknown) => log.warn(error));
  return task;
}
export function createSpaceCreateTaskOperation(deps: Deps) {
  const createTask = (superpipe({ deps })('create-space-task') as PipelineAPI)
    .input(['input', 'creatorSessionId', 'caller'])
    .pipe(resolveCallerSession, ['caller', 'deps'], 'session')
    .pipe(requireCreateTarget, ['input', 'caller', 'session', 'deps'], 'spaceId')
    .pipe(createStandaloneWhenUnowned, ['spaceId', 'input', 'caller', 'deps'], 'result:task')
    .pipe(requireSpace, ['task', 'deps'])
    .pipe(requireUsableWorkspace, ['task', 'input', 'deps'])
    .pipe(createSpaceTask, ['task', 'input', 'caller', 'session', 'deps'], 'task')
    .pipe(publishCreated, ['task', 'deps'], 'task')
    .endAsync('task') as CreateFn;
  return createCreateTaskOperation(createTask, {
    inputSchema: SpaceCreateTaskInputSchema,
    description:
      'Create a task. Space-scoped callers create it in their Space (RPC callers pass spaceId); dependsOn, draft, preferredWorkflowId and workspacePath apply only to Space tasks; when workspacePath is omitted the Space needs a usable default workspace. Other callers create an independent task. Returns core task data.',
  });
}
