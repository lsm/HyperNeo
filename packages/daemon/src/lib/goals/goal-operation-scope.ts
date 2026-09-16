import type { Session, SpaceGoal } from '@hyperneo/shared';
import { z } from 'zod';
import type {
  OperationCaller,
  OperationCallerRole,
  OperationPolicy,
} from '../operations/registry.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

export const GOAL_REJECTION_REASONS = [
  'space_unresolved',
  'space_mismatch',
  'role_denied',
  'session_not_admitted',
  'goal_not_found',
] as const;

export type GoalRejectionReason = (typeof GOAL_REJECTION_REASONS)[number];

export type GoalAccess = 'read' | 'mutate' | 'owner';

const GOAL_ACCESS_ROLE_LISTS: Record<GoalAccess, readonly OperationCallerRole[]> = {
  read: ['ad_hoc_member', 'long_term_agent', 'universal_read'],
  mutate: ['ad_hoc_member', 'long_term_agent'],
  owner: ['long_term_agent'],
};

const GOAL_ACCESS_ROLES: Record<GoalAccess, ReadonlySet<OperationCallerRole>> = {
  read: new Set(GOAL_ACCESS_ROLE_LISTS.read),
  mutate: new Set(GOAL_ACCESS_ROLE_LISTS.mutate),
  owner: new Set(GOAL_ACCESS_ROLE_LISTS.owner),
};

export const GOAL_READ_POLICY = {
  safetyClass: 'read',
  roles: GOAL_ACCESS_ROLE_LISTS.read,
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
}

function denied(reason: GoalRejectionReason, message: string): { reason: GoalRejection } {
  return { reason: { accepted: false, reason, message } };
}

export function admitGoalRole(
  caller: OperationCaller,
  access: GoalAccess
): { value: true } | { reason: GoalRejection } {
  if (caller.source !== 'mcp') return { value: true };
  return caller.role !== undefined && GOAL_ACCESS_ROLES[access].has(caller.role)
    ? { value: true }
    : denied('role_denied', `Role "${caller.role ?? 'unknown'}" may not ${access} goals.`);
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
    : denied('session_not_admitted', 'Goal writes require an active session in the owning Space.');
}

export function resolveGoalSpaceId(
  caller: OperationCaller,
  requestedSpaceId: string | undefined
): { value: string } | { reason: GoalRejection } {
  if (caller.source !== 'mcp') {
    return requestedSpaceId
      ? { value: requestedSpaceId }
      : denied('space_unresolved', 'spaceId is required for this caller.');
  }
  if (!caller.spaceId) {
    return denied('space_unresolved', 'The calling session is not scoped to a Space.');
  }
  return requestedSpaceId === undefined || requestedSpaceId === caller.spaceId
    ? { value: caller.spaceId }
    : denied('space_mismatch', 'spaceId does not match the Space of the calling session.');
}

export function admitGoalSpace(
  caller: OperationCaller,
  requestedSpaceId: string | undefined,
  access: GoalAccess,
  deps: GoalCallerContext
): { value: string } | { reason: GoalRejection } {
  const role = admitGoalRole(caller, access);
  if ('reason' in role) return role;
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
  const role = admitGoalRole(caller, access);
  if ('reason' in role) return role;
  let scopeSpaceId = input.spaceId;
  if (caller.source === 'mcp') {
    const space = resolveGoalSpaceId(caller, input.spaceId);
    if ('reason' in space) return space;
    scopeSpaceId = space.value;
  }
  const goal = getGoal(input.goalId);
  if (!goal || (scopeSpaceId !== undefined && goal.spaceId !== scopeSpaceId)) {
    return denied('goal_not_found', `Goal not found: ${input.goalId}`);
  }
  if (access === 'read') return { value: goal };
  const session = admitGoalSession(caller, goal.spaceId, deps);
  return 'reason' in session ? session : { value: goal };
}
