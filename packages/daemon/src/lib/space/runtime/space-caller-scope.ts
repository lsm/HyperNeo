import type { Session } from '@hyperneo/shared';
import type { CallerScope, CallerScopeResolver } from '../../operations/caller.ts';
import {
  resolveSpaceMcpSessionPolicy,
  resolveWorkflowExecution,
  type SpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicyContext,
} from './space-mcp-session-policy.ts';

export interface SpaceCallerScopeDependencies extends SpaceMcpSessionPolicyContext {
  readonly getSession: (sessionId: string) => Session | null;
}

function chatSpaceId(session: Session): string | undefined {
  return session.type === 'space_chat' ? session.id.match(/^space:chat:(.+)$/)?.[1] : undefined;
}

export function resolveSessionSpaceId(
  session: Session | null,
  context: SpaceMcpSessionPolicyContext,
  policy: SpaceMcpSessionPolicy | null = session
    ? resolveSpaceMcpSessionPolicy(session, context)
    : null
): string | undefined {
  if (!session || !policy) return undefined;
  return policy.spaceId ?? chatSpaceId(session);
}

function definedScope(scope: CallerScope): CallerScope {
  return Object.fromEntries(
    Object.entries(scope).filter(([, value]) => value !== undefined)
  ) as CallerScope;
}

export function resolveSessionCallerScope(
  session: Session,
  context: SpaceMcpSessionPolicyContext
): CallerScope {
  const policy = resolveSpaceMcpSessionPolicy(session, context);
  const spaceId = resolveSessionSpaceId(session, context, policy);
  const provenance = session.metadata.promptProvenance;
  if (policy.role === 'workflow_worker') {
    const execution = resolveWorkflowExecution(session, context.nodeExecutionRepo);
    return definedScope({
      role: policy.role,
      spaceId,
      agentId: execution?.agentId ?? undefined,
      agentName: execution?.agentName,
    });
  }
  if (policy.role === 'long_term_agent' && provenance?.agentId) {
    const agent = context.longHorizonAgentRepo.getById(provenance.agentId);
    return definedScope({
      role: policy.role,
      spaceId,
      agentId: provenance.agentId,
      agentName: agent?.handle ?? provenance.agentName,
    });
  }
  return definedScope({
    role: policy.role,
    spaceId,
    agentId: provenance?.agentId,
    agentName: provenance?.agentName,
  });
}

export function createSpaceCallerScopeResolver(
  deps: SpaceCallerScopeDependencies
): CallerScopeResolver {
  return (sessionId) => {
    const session = deps.getSession(sessionId);
    return session ? resolveSessionCallerScope(session, deps) : null;
  };
}
