import superpipe, { type PipelineAPI } from 'superpipe';
import { coordinatorSessionId } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SessionResolutionDeps } from './deps.ts';
import { ensureSession } from './ensure-session.ts';
import type { EnsureSessionOutcome, SessionTarget, SessionTargetAgent } from './target.ts';

export function selectSpaceAgentTargetStage(
  spaceId: string,
  replyToSessionId: string | null | undefined
): { target: SessionTarget; coordinatorTarget: SessionTargetAgent } {
  const coordinatorTarget = { kind: 'agent' as const, spaceId, agentId: 'coordinator' };
  return {
    target:
      replyToSessionId === null || replyToSessionId === undefined
        ? coordinatorTarget
        : { kind: 'session', sessionId: replyToSessionId },
    coordinatorTarget,
  };
}

export function resolveSpaceAgentTargetStage(
  target: SessionTarget,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  return ensureSession(target, deps);
}

export function fallbackToCoordinatorStage(
  outcome: EnsureSessionOutcome,
  coordinatorTarget: SessionTargetAgent,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  return outcome.kind === 'unresolved' && outcome.reason === 'not_found'
    ? ensureSession(coordinatorTarget, deps)
    : Promise.resolve(outcome);
}

export async function refetchSpaceAgentSessionStage<Session>(
  outcome: EnsureSessionOutcome,
  spaceId: string,
  replyToSessionId: string | null | undefined,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<{ resolvedSessionId: string; resolvedSession: Session }> {
  if (outcome.kind === 'unresolved') {
    const sessionId = replyToSessionId ?? coordinatorSessionId(spaceId);
    throw new Error(
      `Session not found for Space Agent reply routing: ${sessionId}; ${outcome.reason}`
    );
  }
  const session = await getSession(outcome.sessionId);
  if (session === null) {
    throw new Error(`Session not found for Space Agent reply routing: ${outcome.sessionId}`);
  }
  return { resolvedSessionId: outcome.sessionId, resolvedSession: session };
}

const runResolveSpaceAgentSession = (superpipe()('resolve-space-agent-session') as PipelineAPI)
  .input(['spaceId', 'replyToSessionId', 'deps', 'getSession'])
  .pipe(
    selectSpaceAgentTargetStage,
    ['spaceId', 'replyToSessionId'],
    ['target', 'coordinatorTarget']
  )
  .pipe(resolveSpaceAgentTargetStage, ['target', 'deps'], 'outcome')
  .pipe(fallbackToCoordinatorStage, ['outcome', 'coordinatorTarget', 'deps'], 'outcome')
  .pipe(
    refetchSpaceAgentSessionStage,
    ['outcome', 'spaceId', 'replyToSessionId', 'getSession'],
    ['resolvedSessionId', 'resolvedSession']
  )
  .endAsync(['resolvedSessionId', 'resolvedSession']) as (...args: unknown[]) => Promise<{
  resolvedSessionId: string;
  resolvedSession: unknown;
}>;

export async function resolveSpaceAgentSession<Session>(
  spaceId: string,
  replyToSessionId: string | null | undefined,
  deps: SessionResolutionDeps,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<{ sessionId: string; session: Session }> {
  const { resolvedSessionId, resolvedSession } = await runResolveSpaceAgentSession(
    spaceId,
    replyToSessionId,
    deps,
    getSession
  );
  return { sessionId: resolvedSessionId, session: resolvedSession as Session };
}
