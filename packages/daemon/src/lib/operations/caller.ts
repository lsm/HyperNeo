import type { OperationCaller } from './registry.ts';

export type CallerScope = Pick<OperationCaller, 'spaceId' | 'role' | 'agentId' | 'agentName'>;

export type CallerScopeResolver = (sessionId: string) => CallerScope | null;

export type CallerIdentity = Omit<OperationCaller, 'source'>;

export const NO_CALLER_SCOPE: CallerScopeResolver = () => null;

export function resolveCallerIdentity(
  resolveScope: CallerScopeResolver,
  sessionId: string
): CallerIdentity {
  return { sessionId, ...(resolveScope(sessionId) ?? {}) };
}

export function resolveTransportCallerIdentity(
  resolveScope: CallerScopeResolver,
  sessionId: string | undefined
): CallerIdentity {
  const scope = sessionId ? resolveScope(sessionId) : null;
  return scope ? { sessionId, ...scope } : {};
}
