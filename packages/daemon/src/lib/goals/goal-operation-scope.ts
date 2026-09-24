import type { Session, SpaceGoal } from '@hyperneo/shared';
import { z } from 'zod';
import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type {
  OperationCaller,
  OperationCallerRole,
  OperationPolicy,
} from '../operations/registry.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import type { SpaceGoalMutationContext } from './service.ts';

export const GOAL_REJECTION_REASONS = [
  'space_unresolved',
  'space_mismatch',
  'session_not_admitted',
  'goal_not_found',
  'owner_not_found',
  'owner_denied',
  'review_input_invalid',
  'review_denied',
  'notification_not_found',
] as const;

export type GoalRejectionReason = (typeof GOAL_REJECTION_REASONS)[number];

export type GoalAccess = 'read' | 'mutate' | 'owner';

const GOAL_ACCESS_ROLE_LISTS: Record<GoalAccess, readonly OperationCallerRole[]> = {
  read: ['long_term_agent'],
  mutate: ['long_term_agent'],
  owner: ['long_term_agent'],
};

export const GOAL_READ_POLICY = {
  safetyClass: 'read',
  roles: GOAL_ACCESS_ROLE_LISTS.read,
} as const satisfies OperationPolicy;

export const GOAL_WRITE_POLICY = {
  safetyClass: 'mutate',
  roles: GOAL_ACCESS_ROLE_LISTS.mutate,
} as const satisfies OperationPolicy;

export const GOAL_OWNER_POLICY = {
  safetyClass: 'mutate',
  roles: GOAL_ACCESS_ROLE_LISTS.owner,
} as const satisfies OperationPolicy;

export const GoalRejectionSchema = z.object({
  accepted: z.literal(false),
  reason: z.enum(GOAL_REJECTION_REASONS),
  message: z.string(),
});

export type GoalRejection = z.infer<typeof GoalRejectionSchema>;

export const GoalSpaceScopeShape = {
  spaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Space to act in. Required for human callers; agent callers are scoped by session.'),
};

export interface GoalCallerContext extends SpaceMcpSessionPolicyContext {
  readonly getSession: (sessionId: string) => Session | null;
  readonly auditLogRepo?: Pick<McpAuditLogRepository, 'createEntry'>;
}

export function goalMutationContext(caller: OperationCaller): SpaceGoalMutationContext {
  return {
    source: caller.source === 'mcp' ? 'space_agent_tool' : 'rpc',
    sourceSessionId: caller.sessionId ?? null,
  };
}

export function recordGoalAudit(
  deps: GoalCallerContext,
  caller: OperationCaller,
  spaceId: string,
  toolName: string,
  paramsSummary: Record<string, unknown>,
  taskId?: string
): void {
  if (!deps.auditLogRepo) return;
  try {
    deps.auditLogRepo.createEntry({
      agentName: caller.agentName,
      sessionId: caller.sessionId,
      toolName,
      paramsSummary: JSON.stringify(paramsSummary),
      spaceId,
      taskId,
    });
  } catch {}
}

export function goalDenial(
  reason: GoalRejectionReason,
  message: string
): { reason: GoalRejection } {
  return { reason: { accepted: false, reason, message } };
}

export function admitGoalSession(
  caller: OperationCaller,
  spaceId: string,
  deps: GoalCallerContext
): { value: true } | { reason: GoalRejection } {
  if (caller.source !== 'mcp') return { value: true };
  const session = caller.sessionId ? deps.getSession(caller.sessionId) : null;
  return session?.status === 'active' && resolveSessionSpaceId(session, deps) === spaceId
    ? { value: true }
    : goalDenial(
        'session_not_admitted',
        'Goal writes require an active session in the owning Space.'
      );
}

export function resolveGoalSpaceId(
  caller: OperationCaller,
  requestedSpaceId: string | undefined
): { value: string } | { reason: GoalRejection } {
  if (caller.source !== 'mcp') {
    return requestedSpaceId
      ? { value: requestedSpaceId }
      : goalDenial('space_unresolved', 'spaceId is required for this caller.');
  }
  if (!caller.spaceId) {
    return goalDenial('space_unresolved', 'The calling session is not scoped to a Space.');
  }
  return requestedSpaceId === undefined || requestedSpaceId === caller.spaceId
    ? { value: caller.spaceId }
    : goalDenial('space_mismatch', 'spaceId does not match the Space of the calling session.');
}

export function admitGoalSpace(
  caller: OperationCaller,
  requestedSpaceId: string | undefined,
  access: GoalAccess,
  deps: GoalCallerContext
): { value: string } | { reason: GoalRejection } {
  const space = resolveGoalSpaceId(caller, requestedSpaceId);
  if ('reason' in space || access === 'read') return space;
  const session = admitGoalSession(caller, space.value, deps);
  return 'reason' in session ? session : space;
}

export function admitGoalAccess(
  caller: OperationCaller,
  input: { goalId: string; spaceId?: string },
  access: GoalAccess,
  deps: GoalCallerContext,
  getGoal: (goalId: string) => SpaceGoal | null
): { value: SpaceGoal } | { reason: GoalRejection } {
  let scopeSpaceId = input.spaceId;
  if (caller.source === 'mcp') {
    const space = resolveGoalSpaceId(caller, input.spaceId);
    if ('reason' in space) return space;
    scopeSpaceId = space.value;
  }
  const goal = getGoal(input.goalId);
  if (!goal || (scopeSpaceId !== undefined && goal.spaceId !== scopeSpaceId)) {
    return goalDenial('goal_not_found', `Goal not found: ${input.goalId}`);
  }
  if (access === 'read') return { value: goal };
  const session = admitGoalSession(caller, goal.spaceId, deps);
  return 'reason' in session ? session : { value: goal };
}
