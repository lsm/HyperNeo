import type { OperationCaller, OperationCallerRole } from '../operations/registry.ts';

export type WorkflowScopeRejection = 'space_not_resolved' | 'caller_not_admitted';

export const WORKFLOW_READ_ROLES: readonly OperationCallerRole[] = [
  'ad_hoc_member',
  'long_term_agent',
  'universal_read',
  'workflow_worker',
];

export function admitWorkflowScope(
  caller: OperationCaller,
  requestedSpaceId: string | undefined,
  roles: readonly OperationCallerRole[]
): { value: string } | { reason: WorkflowScopeRejection } {
  if (caller.source !== 'mcp') {
    return requestedSpaceId ? { value: requestedSpaceId } : { reason: 'space_not_resolved' };
  }
  if (!caller.role || !roles.includes(caller.role)) return { reason: 'caller_not_admitted' };
  if (!caller.spaceId) return { reason: 'space_not_resolved' };
  if (requestedSpaceId && requestedSpaceId !== caller.spaceId) {
    return { reason: 'caller_not_admitted' };
  }
  return { value: caller.spaceId };
}
