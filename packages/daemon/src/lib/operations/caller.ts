import type { OperationCaller } from './registry.ts';

export type CallerScope = Pick<OperationCaller, 'spaceId' | 'role' | 'agentId' | 'agentName'>;

export type CallerScopeResolver = (sessionId: string) => CallerScope | null;

export type CallerIdentity = Omit<OperationCaller, 'source' | 'principal'>;

export const LOCAL_RPC_PRINCIPAL = 'local';

export const NO_CALLER_SCOPE: CallerScopeResolver = () => null;

export function resolveCallerIdentity(
  resolveScope: CallerScopeResolver,
  sessionId: string
): CallerIdentity {
  return { sessionId, ...resolveScope(sessionId) };
}
