import type { Session, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { Logger } from '../../logger.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { TaskCoreSchema } from '../../operations/task-get.ts';
import { resolveIsDefaultAgent, type DefaultAgentLookup } from '../agents/default-agent-policy.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import {
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicyContext,
} from '../runtime/space-mcp-session-policy.ts';
import {
  normalizePendingCompletion,
  rejectPendingCompletion,
  dispatchPendingCompletion,
  readPendingCompletionResult,
  type PendingCompletionInput,
  type PendingCompletionDependencies,
} from './pending-completion.ts';

const log = new Logger('OwnedPendingCompletion');
type Gate<T> = { value: T } | { reason: Error };
type CompletionActor = { source: OperationCaller['source']; session?: Session; spaceId?: string };

export interface OwnedPendingCompletionDependencies {
  getSession: (sessionId: string) => Session | null;
  getTask: (taskId: string) => SpaceTask | null | Promise<SpaceTask | null>;
  coordinatorLookup: DefaultAgentLookup;
  policyContext?: SpaceMcpSessionPolicyContext;
  getTaskManager: (
    spaceId: string
  ) => Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus' | 'updateTask'>;
  dispatchApproval: (
    spaceId: string,
    taskId: string,
    source: 'human',
    reason: string | null
  ) => Promise<unknown>;
  warn: (taskId: string, detail: string) => void;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  audit: (session: Session, previousTask: SpaceTask, input: PendingCompletionInput) => void;
}

export function resolveCompletionActor(
  caller: OperationCaller,
  getSession: OwnedPendingCompletionDependencies['getSession'],
  coordinatorLookup: DefaultAgentLookup,
  policyContext: SpaceMcpSessionPolicyContext
): Gate<CompletionActor> {
  if (caller.source !== 'mcp') return { value: { source: caller.source } };
  const session = caller.sessionId ? getSession(caller.sessionId) : null;
  const denied = {
    reason: new Error(
      'Pending completion decisions require the owning Space coordinator or task-agent session'
    ),
  };
  if (!session) return denied;
  const policy = resolveSpaceMcpSessionPolicy(session, policyContext);
  const spaceId =
    policy.spaceId ??
    (session.type === 'space_chat' ? session.id.match(/^space:chat:(.+)$/)?.[1] : undefined);
  if (!spaceId) return denied;
  const canonicalChat = session.type === 'space_chat' && session.id === `space:chat:${spaceId}`;
  const allowed =
    policy.role === 'legacy_task_agent' ||
    (canonicalChat && coordinatorLookup.getCoordinator(spaceId) !== null) ||
    (policy.role === 'long_term_agent' &&
      resolveIsDefaultAgent(
        spaceId,
        session.metadata.promptProvenance?.agentId,
        coordinatorLookup
      ));
  return allowed ? { value: { source: 'mcp', session, spaceId } } : denied;
}

export function requireCompletionTarget(
  task: SpaceTask | null,
  input: PendingCompletionInput,
  actor: CompletionActor
): Gate<SpaceTask> {
  if (!task) return { reason: new Error(`Task not found: ${input.taskId}`) };
  if (!task.spaceId)
    return { reason: new Error('Pending completion decisions require a Space-owned task') };
  if (actor.source === 'mcp' && task.spaceId !== actor.spaceId)
    return { reason: new Error(`Task ${input.taskId} does not belong to this space.`) };
  if (task.pendingCheckpointType !== 'task_completion')
    return {
      reason: new Error(
        `Task ${input.taskId} is not awaiting submit_for_approval review (pendingCheckpointType=${task.pendingCheckpointType ?? 'null'}).`
      ),
    };
  return task.status === 'review'
    ? { value: task }
    : {
        reason: new Error(
          `Task ${input.taskId} is not in 'review' status (current: ${task.status}).`
        ),
      };
}

export async function loadCompletionTarget(
  input: PendingCompletionInput,
  actor: CompletionActor,
  getTask: OwnedPendingCompletionDependencies['getTask']
): Promise<Gate<SpaceTask>> {
  return requireCompletionTarget(await getTask(input.taskId), input, actor);
}

function bindOwnedCompletion(
  previous: SpaceTask,
  getTaskManager: OwnedPendingCompletionDependencies['getTaskManager'],
  dispatchApproval: OwnedPendingCompletionDependencies['dispatchApproval'],
  warn: OwnedPendingCompletionDependencies['warn']
): PendingCompletionDependencies {
  const manager = getTaskManager(previous.spaceId);
  return {
    getTask: (id) => manager.getTask(id),
    dispatchApproval: (id, reason) => dispatchApproval(previous.spaceId, id, 'human', reason),
    reopenTask: (id) => manager.setTaskStatus(id, 'in_progress'),
    updateTask: (id, fields) => manager.updateTask(id, fields),
    warn,
  };
}

async function notifyOwnedCompletion(
  actor: CompletionActor,
  previous: SpaceTask,
  input: PendingCompletionInput,
  task: SpaceTask,
  emitTaskUpdated: OwnedPendingCompletionDependencies['emitTaskUpdated'],
  audit: OwnedPendingCompletionDependencies['audit']
): Promise<void> {
  await emitTaskUpdated(task.spaceId, task).catch((error: unknown) =>
    log.warn('Failed to emit space.task.updated:', error)
  );
  if (actor.source === 'mcp' && actor.session) {
    try {
      audit(actor.session, previous, input);
    } catch {}
  }
}

export function createOwnedPendingCompletionOperation(
  dependencies: OwnedPendingCompletionDependencies
) {
  const resolve = (
    superpipe({ ...dependencies, policyContext: dependencies.policyContext ?? {} })(
      'resolve-owned-pending-completion'
    ) as PipelineAPI
  )
    .input(['input', 'caller'])
    .pipe(
      resolveCompletionActor,
      ['caller', 'getSession', 'coordinatorLookup', 'policyContext'],
      'result:task'
    )
    .pipe((actor: CompletionActor) => actor, 'task', 'actor')
    .pipe(loadCompletionTarget, ['input', 'actor', 'getTask'], 'result:task')
    .pipe((task: SpaceTask) => task, 'task', 'previous')
    .pipe(
      bindOwnedCompletion,
      ['previous', 'getTaskManager', 'dispatchApproval', 'warn'],
      ['getTask', 'dispatchApproval', 'reopenTask', 'updateTask', 'warn']
    )
    .pipe(normalizePendingCompletion, 'input', 'decision')
    .pipe(rejectPendingCompletion, ['decision', 'reopenTask', 'updateTask'], 'rejection')
    .pipe(dispatchPendingCompletion, [
      'decision',
      'dispatchApproval',
      'getTask',
      'updateTask',
      'warn',
    ])
    .pipe(readPendingCompletionResult, ['getTask', 'decision', 'rejection'], 'result:task')
    .pipe(notifyOwnedCompletion, ['actor', 'previous', 'input', 'task', 'emitTaskUpdated', 'audit'])
    .endAsync('task') as (
    input: PendingCompletionInput,
    caller: OperationCaller
  ) => Promise<SpaceTask | Error>;
  return defineOperation({
    name: 'task.resolvePendingCompletion',
    description:
      'Approve or reject a Space task awaiting completion review. MCP requires the owning Space coordinator/default agent or legacy task-agent session. Both transports use human approval semantics. Standalone tasks are unsupported. Approval may return postApprovalBlockedReason when post-approval work could not dispatch.',
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        approved: z.boolean(),
        reason: z.string().nullable().optional(),
      })
      .strict(),
    resultSchema: TaskCoreSchema.extend({
      pendingCheckpointType: z.literal('task_completion').nullable(),
      approvalSource: z.enum(['human', 'agent', 'auto_policy']).nullable(),
      approvalReason: z.string().nullable(),
      approvedAt: z.number().nullable(),
      postApprovalBlockedReason: z.string().nullable().optional(),
    }),
    execute: async (input, caller) => {
      const result = await resolve(input, caller);
      if (result instanceof Error) throw result;
      return result;
    },
  });
}
