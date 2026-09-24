import type { Session } from '@hyperneo/shared';
import type { OperationCaller, OperationCallerRole } from '../operations/registry.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

export type WorkflowScopeRejection = 'space_not_resolved' | 'caller_not_admitted';

export const WORKFLOW_READ_ROLES: readonly OperationCallerRole[] = [
  'long_term_agent',
  'workflow_worker',
];

export const WORKFLOW_MUTATE_ROLES: readonly OperationCallerRole[] = ['long_term_agent'];

export interface WorkflowSessionAdmission extends SpaceMcpSessionPolicyContext {
  getSession: (sessionId: string) => Session | null;
}

export function admitWorkflowScope(
  caller: OperationCaller,
  requestedSpaceId: string | undefined
): { value: string } | { reason: WorkflowScopeRejection } {
  if (caller.source !== 'mcp') {
    const spaceId = requestedSpaceId ?? caller.spaceId;
    return spaceId ? { value: spaceId } : { reason: 'space_not_resolved' };
  }
  if (!caller.spaceId) return { reason: 'space_not_resolved' };
  if (requestedSpaceId && requestedSpaceId !== caller.spaceId) {
    return { reason: 'caller_not_admitted' };
  }
  return { value: caller.spaceId };
}

export function admitActiveWorkflowSession(
  spaceId: string,
  caller: OperationCaller,
  admission: WorkflowSessionAdmission
): { value: string } | { reason: WorkflowScopeRejection } {
  if (caller.source !== 'mcp') return { value: spaceId };
  const session = caller.sessionId ? admission.getSession(caller.sessionId) : null;
  return session?.status === 'active' && resolveSessionSpaceId(session, admission) === spaceId
    ? { value: spaceId }
    : { reason: 'caller_not_admitted' };
}
