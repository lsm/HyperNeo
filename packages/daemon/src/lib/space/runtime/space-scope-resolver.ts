import type { Session, Space } from '@hyperneo/shared';
import type { ScopeContribution } from '../../briefings/contribution.ts';
import type { SessionScopeResolver } from '../../briefings/scope-resolver.ts';
import { resolveSessionSpaceId } from './space-caller-scope.ts';
import {
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicyContext,
} from './space-mcp-session-policy.ts';
import { spaceScopeContribution, spaceScopeRole } from './space-scope-contribution.ts';

export interface SpaceScopeDependencies extends SpaceMcpSessionPolicyContext {
  readonly getSession: (sessionId: string) => Session | null;
  readonly getSpace: (spaceId: string) => Space | null;
}

function agentDisplayName(session: Session, deps: SpaceScopeDependencies): string | null {
  const provenance = session.metadata?.promptProvenance;
  if (!provenance?.agentId) return null;
  return deps.longHorizonAgentRepo.getById(provenance.agentId)?.displayName ?? null;
}

export function resolveSessionSpaceScope(
  session: Session,
  deps: SpaceScopeDependencies
): ScopeContribution | undefined {
  const policy = resolveSpaceMcpSessionPolicy(session, deps);
  const role = spaceScopeRole(policy.role);
  if (!role) return undefined;
  const spaceId = resolveSessionSpaceId(session, deps, policy) ?? session.context?.spaceId;
  if (!spaceId) return undefined;
  const space = deps.getSpace(spaceId);
  if (!space) return undefined;
  return spaceScopeContribution({
    spaceId: space.id,
    spaceName: space.name,
    role,
    agentDisplayName: role === 'long_term_agent' ? agentDisplayName(session, deps) : null,
    spaceInstructions: space.instructions,
  });
}

export function createSpaceScopeResolver(deps: SpaceScopeDependencies): SessionScopeResolver {
  return (sessionId) => {
    const session = deps.getSession(sessionId);
    return session ? resolveSessionSpaceScope(session, deps) : undefined;
  };
}
