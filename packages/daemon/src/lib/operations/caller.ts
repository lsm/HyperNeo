import type { OperationCaller } from './registry.ts';

export type CallerScope = Pick<OperationCaller, 'spaceId' | 'role' | 'agentId' | 'agentName'>;

export type CallerScopeResolver = (sessionId: string) => CallerScope | null;

export type CallerIdentity = Omit<OperationCaller, 'source' | 'principal'>;

export const LOCAL_RPC_PRINCIPAL = 'local';

export function isLocalUser(caller: Pick<OperationCaller, 'source' | 'principal'>): boolean {
  return caller.source === 'rpc' && caller.principal === LOCAL_RPC_PRINCIPAL;
}

export function requireLocalUser(
  caller: OperationCaller
): { value: OperationCaller } | { reason: { ok: false; reason: string } } {
  return isLocalUser(caller)
    ? { value: caller }
    : { reason: { ok: false, reason: 'This action needs the user.' } };
}

export const PLAIN_SESSION_SCOPE: CallerScopeResolver = () => ({ role: 'universal_read' });

export function resolveCallerIdentity(
  resolveScope: CallerScopeResolver,
  sessionId: string
): CallerIdentity {
  return { sessionId, ...resolveScope(sessionId) };
}
