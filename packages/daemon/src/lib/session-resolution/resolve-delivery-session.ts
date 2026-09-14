import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionResolutionDeps } from './deps.ts';
import { ensureSession } from './ensure-session.ts';
import type { EnsureSessionOutcome, SessionTarget } from './target.ts';

export function selectDeliveryTargetStage(
  spaceId: string,
  replyToSessionId: string | null | undefined
): Exclude<SessionTarget, { kind: 'worker' }> {
  if (replyToSessionId === null || replyToSessionId === undefined) {
    throw new Error(
      `No reply route for session delivery in space ${spaceId}; the sender must supply a session`
    );
  }
  return { kind: 'session', sessionId: replyToSessionId };
}

export function resolveDeliveryTargetStage(
  target: SessionTarget,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  return ensureSession(target, deps);
}

export async function refetchDeliverySessionStage<Session>(
  outcome: EnsureSessionOutcome,
  target: Exclude<SessionTarget, { kind: 'worker' }>,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<{ resolvedSessionId: string; resolvedSession: Session }> {
  if (outcome.kind === 'unresolved') {
    const sessionId = target.kind === 'session' ? target.sessionId : target.agentId;
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

const runResolveDeliverySession = (superpipe()('resolve-delivery-session') as PipelineAPI)
  .input(['spaceId', 'replyToSessionId', 'deps', 'getSession'])
  .pipe(selectDeliveryTargetStage, ['spaceId', 'replyToSessionId'], 'target')
  .pipe(resolveDeliveryTargetStage, ['target', 'deps'], 'outcome')
  .pipe(
    refetchDeliverySessionStage,
    ['outcome', 'target', 'getSession'],
    ['resolvedSessionId', 'resolvedSession']
  )
  .endAsync('{resolvedSessionId, resolvedSession}') as (...args: unknown[]) => Promise<{
  resolvedSessionId: string;
  resolvedSession: unknown;
}>;

export async function resolveDeliverySession<Session>(
  spaceId: string,
  replyToSessionId: string | null | undefined,
  deps: SessionResolutionDeps,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<{ sessionId: string; session: Session }> {
  const { resolvedSessionId, resolvedSession } = await runResolveDeliverySession(
    spaceId,
    replyToSessionId,
    deps,
    getSession
  );
  return { sessionId: resolvedSessionId, session: resolvedSession as Session };
}
