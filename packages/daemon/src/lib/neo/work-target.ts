import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkTarget } from '../../storage/repositories/neo-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';

type ExecutionSession = { readonly id: string; readonly status: string };
type Rejection = {
  accepted: false;
  reason:
    | 'invalid_work_id'
    | 'work_not_found'
    | 'invalid_target_reference'
    | 'target_session_not_found'
    | 'target_session_not_active'
    | 'invalid_target_binding'
    | 'target_is_coordinator';
};
type Gate<T> = { value: T } | { reason: Rejection };
type Resolution = { accepted: true; workId: string; targetSessionId: string | null } | Rejection;
export interface NeoWorkTargetDependencies {
  readTarget(workId: string): NeoWorkTarget | null;
  readSession(sessionId: string): ExecutionSession | null;
  readBinding(sessionId: string): NeoBinding | null;
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
  return session.status === 'active'
    ? { value: target }
    : { reason: { accepted: false, reason: 'target_session_not_active' } };
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
      (target: NeoWorkTarget, { session }: { session: ExecutionSession | null }) =>
        requireNeoWorkTargetSession(target, session),
      ['target', 'session'],
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
        requireNeoWorkTargetBinding(target, binding),
      ['target', 'binding'],
      'result:target'
    )
    .pipe(presentNeoWorkTarget, 'target', 'target')
    .end('target') as (workId: string) => Resolution;
}
