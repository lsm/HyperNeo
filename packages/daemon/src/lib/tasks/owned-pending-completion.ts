import type { Session, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { Logger } from '../logger.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from './get-operation.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import {
  FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicyContext,
  type SpaceMcpSessionRole,
} from '../space/runtime/space-mcp-session-policy.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import {
  decideAutonomyAdmission,
  HUMAN_ONLY_AUTONOMY_LEVEL,
  resolveEffectiveAutonomyLevel,
} from '../space/tools/tool-admission-gates.ts';
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
type CompletionActor = {
  source: OperationCaller['source'];
  session?: Session;
  spaceId?: string;
  role?: SpaceMcpSessionRole;
  agentId?: string | null;
};

export interface OwnedPendingCompletionDependencies {
  getSession: (sessionId: string) => Session | null;
  getTask: (taskId: string) => SpaceTask | null | Promise<SpaceTask | null>;
  policyContext?: SpaceMcpSessionPolicyContext;
  getSpaceAutonomyLevel?: (spaceId: string) => number | Promise<number>;
  getTaskManager: (
    spaceId: string
  ) => Pick<SpaceTaskManager, 'getTask' | 'reopenPendingCompletion' | 'updateTask'>;
  dispatchApproval: (
    spaceId: string,
    taskId: string,
    source: 'human' | 'agent',
    reason: string | null,
    guard: { expectedPendingCompletionGeneration: number }
  ) => Promise<unknown>;
  warn: (taskId: string, detail: string) => void;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  audit: (session: Session, previousTask: SpaceTask, input: PendingCompletionInput) => void;
}

export function resolveCompletionActor(
  caller: OperationCaller,
  getSession: OwnedPendingCompletionDependencies['getSession'],
  policyContext: SpaceMcpSessionPolicyContext
): Gate<CompletionActor> {
  if (caller.source !== 'mcp') return { value: { source: caller.source } };
  const session = caller.sessionId ? getSession(caller.sessionId) : null;
  const denied = {
    reason: new Error(
      'Pending completion decisions require a Space agent session in the owning space or a task-agent session'
    ),
  };
  if (!session) return denied;
  const policy = resolveSpaceMcpSessionPolicy(session, policyContext);
  const spaceId = resolveSessionSpaceId(session, policyContext, policy);
  if (!spaceId) return denied;
  const allowed = policy.role === 'legacy_task_agent' || policy.role === 'long_term_agent';
  if (!allowed) return denied;
  const agentId =
    policy.role === 'long_term_agent' ? (session.metadata.promptProvenance?.agentId ?? null) : null;
  return { value: { source: 'mcp', session, spaceId, role: policy.role, agentId } };
}

export async function requireCompletionAutonomy(
  actor: CompletionActor,
  policyContext: SpaceMcpSessionPolicyContext,
  getSpaceAutonomyLevel: OwnedPendingCompletionDependencies['getSpaceAutonomyLevel']
): Promise<Gate<CompletionActor>> {
  if (actor.source !== 'mcp' || actor.role === 'legacy_task_agent' || !actor.spaceId) {
    return { value: actor };
  }
  const spaceLevel = getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(actor.spaceId) : 1;
  const agent = actor.agentId
    ? (policyContext.longHorizonAgentRepo?.getById(actor.agentId) ?? null)
    : null;
  if (!agent || agent.status !== 'active') {
    return {
      reason: new Error(
        'Pending completion decisions require an active Space agent identity; the provenance agent is missing or inactive.'
      ),
    };
  }
  const agentLevel = agent.autonomyLevel ?? null;
  const effective = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
  const admission = decideAutonomyAdmission({
    toolName: 'task.resolvePendingCompletion',
    level: effective.level,
    required: HUMAN_ONLY_AUTONOMY_LEVEL,
    agentLevel,
    spaceLevel,
  });
  return admission.action === 'allow' ? { value: actor } : { reason: new Error(admission.message) };
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
  return task.status === 'review'
    ? { value: task }
    : {
        reason: new Error(
          `Task ${input.taskId} is not in 'review' status (current: ${task.status}).`
        ),
      };
}

export async function restageOrphanedCheckpoint(
  task: SpaceTask,
  getTaskManager: OwnedPendingCompletionDependencies['getTaskManager']
): Promise<SpaceTask> {
  if (task.pendingCheckpointType === 'task_completion') return task;
  const manager = getTaskManager(task.spaceId);
  await manager.updateTask(
    task.id,
    {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedAt: task.pendingCompletionSubmittedAt ?? Date.now(),
    },
    {
      guardWrite: (current) =>
        current.status === 'review' && current.pendingCheckpointType === null
          ? undefined
          : `Task ${task.id} left the orphaned review state before it could be restaged`,
    }
  );
  return (await manager.getTask(task.id)) ?? task;
}

export async function loadCompletionTarget(
  input: PendingCompletionInput,
  actor: CompletionActor,
  getTask: OwnedPendingCompletionDependencies['getTask']
): Promise<Gate<SpaceTask>> {
  return requireCompletionTarget(await getTask(input.taskId), input, actor);
}

function resolveCompletionApprovalSource(actor: CompletionActor): 'human' | 'agent' {
  return actor.source === 'mcp' ? 'agent' : 'human';
}

function bindOwnedCompletion(
  previous: SpaceTask,
  actor: CompletionActor,
  getTaskManager: OwnedPendingCompletionDependencies['getTaskManager'],
  dispatchApproval: OwnedPendingCompletionDependencies['dispatchApproval'],
  warn: OwnedPendingCompletionDependencies['warn']
): PendingCompletionDependencies {
  const manager = getTaskManager(previous.spaceId);
  const guard = { expectedPendingCompletionGeneration: previous.pendingCompletionGeneration ?? 0 };
  const source = resolveCompletionApprovalSource(actor);
  return {
    getTask: (id) => manager.getTask(id),
    dispatchApproval: (id, reason) => dispatchApproval(previous.spaceId, id, source, reason, guard),
    reopenTask: (id, reason) => manager.reopenPendingCompletion(id, reason, guard),
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
    superpipe({
      ...dependencies,
      policyContext: dependencies.policyContext ?? {
        longHorizonAgentRepo: FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
      },
    })('resolve-owned-pending-completion') as PipelineAPI
  )
    .input(['input', 'caller'])
    .pipe(resolveCompletionActor, ['caller', 'getSession', 'policyContext'], 'result:task')
    .pipe((actor: CompletionActor) => actor, 'task', 'actor')
    .pipe(
      requireCompletionAutonomy,
      ['actor', 'policyContext', 'getSpaceAutonomyLevel'],
      'result:task'
    )
    .pipe((actor: CompletionActor) => actor, 'task', 'actor')
    .pipe(loadCompletionTarget, ['input', 'actor', 'getTask'], 'result:task')
    .pipe(restageOrphanedCheckpoint, ['task', 'getTaskManager'], 'previous')
    .pipe(
      bindOwnedCompletion,
      ['previous', 'actor', 'getTaskManager', 'dispatchApproval', 'warn'],
      [
        'getTask:readOwnedTask',
        'dispatchApproval:dispatchOwnedApproval',
        'reopenTask',
        'updateTask',
      ]
    )
    .pipe(normalizePendingCompletion, 'input', 'decision')
    .pipe(rejectPendingCompletion, ['decision', 'reopenTask', 'updateTask'], 'rejection')
    .pipe(dispatchPendingCompletion, [
      'decision',
      'dispatchOwnedApproval',
      'readOwnedTask',
      'updateTask',
      'warn',
    ])
    .pipe(readPendingCompletionResult, ['readOwnedTask', 'decision', 'rejection'], 'result:task')
    .pipe(notifyOwnedCompletion, ['actor', 'previous', 'input', 'task', 'emitTaskUpdated', 'audit'])
    .endAsync('task') as (
    input: PendingCompletionInput,
    caller: OperationCaller
  ) => Promise<SpaceTask | Error>;
  return defineOperation({
    name: 'task.resolvePendingCompletion',
    description:
      'Approve or reject a Space task awaiting completion review. MCP requires a Space agent session in the owning space or a legacy task-agent session. Both transports carry the same human approval weight, and a long-term agent caller needs the human-only autonomy level to be admitted while a legacy task-agent session is exempt from that gate, but the decision is recorded for who made it: approvalSource is agent for an MCP caller and human for an RPC or internal one. Standalone tasks are unsupported. Approval may return postApprovalBlockedReason when post-approval work could not dispatch.',
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        approved: z.boolean(),
        reason: z.string().nullable().optional(),
      })
      .strict(),
    resultSchema: TaskWithSpaceFieldsSchema.extend({
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
