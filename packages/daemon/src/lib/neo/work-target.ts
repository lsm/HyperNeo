import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkTarget } from '../../storage/repositories/neo-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type NeoAgentWorkOwner,
  requireNeoAgentWorkBinding,
  requireNeoAgentWorkReference,
  requireNeoAgentWorkSession,
} from './agent-work-target.ts';

export type ExecutionSession = {
  readonly id: string;
  readonly status: string;
  readonly scopeOwned?: number;
  readonly neoBound?: number;
};
export type NeoWorkTargetRejection = {
  accepted: false;
  reason:
    | 'invalid_work_id'
    | 'work_not_found'
    | 'invalid_target_reference'
    | 'target_session_not_found'
    | 'target_session_not_active'
    | 'target_owned_context'
    | 'invalid_agent_reference'
    | 'target_agent_unavailable'
    | 'ambiguous_target_agent'
    | 'target_agent_not_active'
    | 'target_space_not_active'
    | 'invalid_target_binding'
    | 'target_is_coordinator';
};
type Rejection = NeoWorkTargetRejection;
type Gate<T> = { value: T } | { reason: Rejection };
type Resolution = { accepted: true; workId: string; targetSessionId: string | null } | Rejection;
export interface NeoWorkTargetDependencies {
  readTarget(workId: string): NeoWorkTarget | null;
  readSession(sessionId: string): ExecutionSession | null;
  readBinding(sessionId: string): NeoBinding | null;
  readAgentOwner?(agent: NonNullable<NeoWorkTarget['agent']>): NeoAgentWorkOwner | null;
}

export function admitNeoWorkTargetId(workId: string): Gate<string> {
  return workId.trim()
    ? { value: workId }
    : { reason: { accepted: false, reason: 'invalid_work_id' } };
}

export function requireStoredNeoWorkTarget(
  workId: string,
  record: NeoWorkTarget | null
): Gate<NeoWorkTarget> {
  if (!record || record.id !== workId)
    return { reason: { accepted: false, reason: 'work_not_found' } };
  return record.targetSessionId === null ||
    (typeof record.targetSessionId === 'string' && !!record.targetSessionId.trim())
    ? { value: record }
    : { reason: { accepted: false, reason: 'invalid_target_reference' } };
}

export function requireNeoWorkTargetSession(
  target: NeoWorkTarget,
  session: ExecutionSession | null
): Gate<NeoWorkTarget> {
  if (target.targetSessionId === null) return { value: target };
  if (!session || session.id !== target.targetSessionId)
    return { reason: { accepted: false, reason: 'target_session_not_found' } };
  if (session.status !== 'active')
    return { reason: { accepted: false, reason: 'target_session_not_active' } };
  return session.scopeOwned || session.neoBound
    ? { reason: { accepted: false, reason: 'target_owned_context' } }
    : { value: target };
}

export function requireNeoWorkTargetBinding(
  target: NeoWorkTarget,
  binding: NeoBinding | null
): Gate<NeoWorkTarget> {
  if (target.targetSessionId === null || binding === null) return { value: target };
  if (binding.sessionId !== target.targetSessionId)
    return { reason: { accepted: false, reason: 'invalid_target_binding' } };
  return binding.kind === 'worker'
    ? { value: target }
    : { reason: { accepted: false, reason: 'target_is_coordinator' } };
}

export function presentNeoWorkTarget(target: NeoWorkTarget): Resolution {
  return { accepted: true, workId: target.id, targetSessionId: target.targetSessionId };
}

export function createNeoWorkTargetResolver(deps: NeoWorkTargetDependencies) {
  return (superpipe({})('neo-work-target') as PipelineAPI)
    .input(['workId'])
    .pipe(admitNeoWorkTargetId, 'workId', 'result:target')
    .pipe((id: string) => ({ record: deps.readTarget(id) ?? null }), 'target', 'stored')
    .pipe(
      (id: string, { record }: { record: NeoWorkTarget | null }) =>
        requireStoredNeoWorkTarget(id, record),
      ['target', 'stored'],
      'result:target'
    )
    .pipe(requireNeoAgentWorkReference, 'target', 'result:target')
    .pipe(
      (target: NeoWorkTarget) => ({
        session:
          target.targetSessionId === null
            ? null
            : (deps.readSession(target.targetSessionId) ?? null),
      }),
      'target',
      'session'
    )
    .pipe(
      (target: NeoWorkTarget) => ({
        owner: target.agent ? (deps.readAgentOwner?.(target.agent) ?? null) : null,
      }),
      'target',
      'agentOwner'
    )
    .pipe(
      (
        target: NeoWorkTarget,
        { session }: { session: ExecutionSession | null },
        { owner }: { owner: NeoAgentWorkOwner | null }
      ) =>
        target.agent
          ? requireNeoAgentWorkSession(target, session, owner)
          : requireNeoWorkTargetSession(target, session),
      ['target', 'session', 'agentOwner'],
      'result:target'
    )
    .pipe(
      (target: NeoWorkTarget) => ({
        binding:
          target.targetSessionId === null
            ? null
            : (deps.readBinding(target.targetSessionId) ?? null),
      }),
      'target',
      'binding'
    )
    .pipe(
      (target: NeoWorkTarget, { binding }: { binding: NeoBinding | null }) =>
        target.agent
          ? requireNeoAgentWorkBinding(target, binding)
          : requireNeoWorkTargetBinding(target, binding),
      ['target', 'binding'],
      'result:target'
    )
    .pipe(presentNeoWorkTarget, 'target', 'target')
    .end('target') as (workId: string) => Resolution;
}
