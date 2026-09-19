import type { ScopeContribution } from './contribution.ts';

export type SessionScopeResolver = (sessionId: string) => ScopeContribution | undefined;

export const NO_SESSION_SCOPE: SessionScopeResolver = () => undefined;
