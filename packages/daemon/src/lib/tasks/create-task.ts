import type { Session, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { createStandaloneTask } from '../../storage/tasks/create-task.ts';
import { Logger } from '../logger.ts';
import type { OperationCaller } from '../operations/registry.ts';
import {
  createCreateTaskOperation,
  type CreatedTask,
  type CreateTaskRejection,
} from './create-operation.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import {
  resolveCreatedBy,
  resolveCreateTaskTarget,
  type SpaceCreateTaskInput,
  SpaceCreateTaskInputSchema,
} from './create-task-target.ts';
import { requireActiveMetadataCallerSession, resolveMetadataSessionSpace } from './metadata.ts';

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
type TargetGate = { value: Opt } | { reason: CreateTaskRejection };
type OwnershipGate = { value: string } | { reason: CreatedTask };
type CreateFn = (
  input: In,
  sessionId: Opt,
  caller: Caller
) => Promise<CreatedTask | CreateTaskRejection>;

function resolveCallerSession(caller: Caller, deps: Deps): Sess {
  return caller.source === 'mcp' && caller.sessionId ? deps.getSession(caller.sessionId) : null;
}
function resolveCreateTarget(input: In, caller: Caller, session: Sess, deps: Deps): TargetGate {
  const target = resolveCreateTaskTarget(input, caller, resolveMetadataSessionSpace(session, deps));
  return 'reason' in target
    ? { reason: { accepted: false, reason: target.reason } }
    : { value: target.value.spaceId };
}
function createStandaloneWhenUnowned(
  spaceId: Opt,
  input: In,
  caller: Caller,
  deps: Deps
): OwnershipGate {
  if (spaceId !== undefined) return { value: spaceId };
  const task = createStandaloneTask(deps.db, input, caller.sessionId, deps.notifyStandalone);
  return { reason: { ...task, standalone: true } };
}
function requireActiveCaller(spaceId: string, caller: Caller, session: Sess): TargetGate {
  const active = requireActiveMetadataCallerSession({ kind: 'space', spaceId }, caller, session);
  return 'reason' in active
    ? { reason: { accepted: false, reason: active.reason } }
    : { value: spaceId };
}
async function requireSpace(spaceId: string, deps: Deps): Promise<TargetGate> {
  return (await deps.getSpace(spaceId))
    ? { value: spaceId }
    : { reason: { accepted: false, reason: `Space not found: ${spaceId}` } };
}
async function requireUsableWorkspace(spaceId: string, input: In, deps: Deps): Promise<TargetGate> {
  if (input.workspacePath !== undefined) return { value: spaceId };
  const error = await deps.validateDefaultTaskWorkspace(spaceId);
  return error ? { reason: { accepted: false, reason: error } } : { value: spaceId };
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
    .pipe(resolveCreateTarget, ['input', 'caller', 'session', 'deps'], 'result:task')
    .pipe(createStandaloneWhenUnowned, ['task', 'input', 'caller', 'deps'], 'result:task')
    .pipe(requireActiveCaller, ['task', 'caller', 'session'], 'result:task')
    .pipe(requireSpace, ['task', 'deps'], 'result:task')
    .pipe(requireUsableWorkspace, ['task', 'input', 'deps'], 'result:task')
    .pipe(createSpaceTask, ['task', 'input', 'caller', 'session', 'deps'], 'task')
    .pipe(publishCreated, ['task', 'deps'], 'task')
    .endAsync('task') as CreateFn;
  return createCreateTaskOperation(createTask, {
    inputSchema: SpaceCreateTaskInputSchema,
    description:
      'Create a task. Pass spaceId to create it in that Space; a session already scoped to a Space creates there by default and cannot target another Space, which returns { accepted: false, reason }. With no spaceId and no Space of its own the caller gets an independent task, reported as standalone: true on the result. dependsOn, draft, preferredWorkflowId and workspacePath apply only to Space tasks; when workspacePath is omitted the Space needs a usable default workspace. An agent caller needs an active session. A missing Space, an unusable default workspace or an inactive caller session returns { accepted: false, reason }. Returns core task data, or a rejection.',
  });
}
