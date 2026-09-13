import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionResolutionDeps } from './deps.ts';
import { ensureSession } from './ensure-session.ts';
import type { EnsureSessionOutcome, SessionTargetAgent } from './target.ts';

export function resolveAgentDeliveryTargetStage(
  spaceId: string,
  agentId: string
): SessionTargetAgent {
  return { kind: 'agent', spaceId, agentId };
}

export function ensureAgentDeliverySessionStage(
  target: SessionTargetAgent,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  return ensureSession(target, deps);
}

export async function provisionAndRefetchAgentDeliverySessionStage<Session>(
  outcome: EnsureSessionOutcome,
  target: SessionTargetAgent,
  deps: SessionResolutionDeps,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<{ session: Session | null }> {
  if (outcome.kind === 'unresolved') return { session: null };
  if (
    !outcome.created &&
    (await deps.ensureLongTermAgent(target.spaceId, target.agentId)) === null
  ) {
    return { session: null };
  }
  return { session: await getSession(outcome.sessionId) };
}

const runResolveAgentDeliverySession = (
  superpipe()('resolve-agent-delivery-session') as PipelineAPI
)
  .input(['spaceId', 'agentId', 'deps', 'getSession'])
  .pipe(resolveAgentDeliveryTargetStage, ['spaceId', 'agentId'], 'target')
  .pipe(ensureAgentDeliverySessionStage, ['target', 'deps'], 'outcome')
  .pipe(
    provisionAndRefetchAgentDeliverySessionStage,
    ['outcome', 'target', 'deps', 'getSession'],
    '{...}'
  )
  .endAsync('session') as (...args: unknown[]) => Promise<unknown | null>;

export async function resolveAgentDeliverySession<Session>(
  spaceId: string,
  agentId: string,
  deps: SessionResolutionDeps,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<Session | null> {
  return (await runResolveAgentDeliverySession(
    spaceId,
    agentId,
    deps,
    getSession
  )) as Session | null;
}
