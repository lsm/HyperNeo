import type { Session } from '@hyperneo/shared';
import type { OperationCaller, OperationCallerRole } from './registry.ts';

export type SpaceCallerRejection = 'space_scope_required' | 'space_mismatch' | 'denied';

const SPACE_FAMILY_ROLES: ReadonlySet<OperationCallerRole> = new Set([
  'ad_hoc_member',
  'long_term_agent',
]);

export interface SpaceCallerAdmission {
  readonly readOnly: boolean;
  readonly workerAllowed?: boolean;
  readonly getSession?: (sessionId: string) => Session | null;
  readonly sessionSpaceId?: (session: Session) => string | undefined;
}

export function admitSpaceCallerRole(
  role: OperationCallerRole | undefined,
  admission: SpaceCallerAdmission
): boolean {
  if (role === undefined) return false;
  if (SPACE_FAMILY_ROLES.has(role)) return true;
  if (!admission.readOnly) return false;
  return (
    role === 'universal_read' || (admission.workerAllowed === true && role === 'workflow_worker')
  );
}

export function admitSpaceCaller(
  caller: OperationCaller,
  requestedSpaceId: string | undefined,
  admission: SpaceCallerAdmission
): { value: string } | { reason: SpaceCallerRejection } {
  if (caller.source !== 'mcp') {
    return requestedSpaceId ? { value: requestedSpaceId } : { reason: 'space_scope_required' };
  }
  if (!admitSpaceCallerRole(caller.role, admission)) return { reason: 'denied' };
  const spaceId = caller.spaceId;
  if (!spaceId) return { reason: 'space_scope_required' };
  if (requestedSpaceId !== undefined && requestedSpaceId !== spaceId) {
    return { reason: 'space_mismatch' };
  }
  if (admission.readOnly) return { value: spaceId };
  const session = caller.sessionId ? (admission.getSession?.(caller.sessionId) ?? null) : null;
  if (!session || session.status !== 'active') return { reason: 'denied' };
  return admission.sessionSpaceId?.(session) === spaceId
    ? { value: spaceId }
    : { reason: 'denied' };
}
