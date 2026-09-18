import type { Session } from '@hyperneo/shared';
import type { OperationCaller } from './registry.ts';

export type SpaceCallerRejection = 'space_scope_required' | 'space_mismatch' | 'denied';

export interface SpaceCallerAdmission {
  readonly readOnly: boolean;
  readonly getSession?: (sessionId: string) => Session | null;
  readonly sessionSpaceId?: (session: Session) => string | undefined;
}

export function admitSpaceCaller(
  caller: OperationCaller,
  requestedSpaceId: string | undefined,
  admission: SpaceCallerAdmission
): { value: string } | { reason: SpaceCallerRejection } {
  if (caller.source !== 'mcp') {
    return requestedSpaceId ? { value: requestedSpaceId } : { reason: 'space_scope_required' };
  }
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
