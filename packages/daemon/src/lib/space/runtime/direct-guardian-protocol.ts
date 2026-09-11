import type {
  DirectProcessIdentity,
  DirectProcessLaunch,
} from '../../../storage/repositories/direct-process-ownership-repository.ts';

export type DirectGuardianState =
  | 'waiting'
  | 'launching'
  | 'running'
  | 'stopping_launch'
  | 'stopping'
  | 'terminal';
export type DirectGuardianEvent =
  | { kind: 'go'; authorization: DirectProcessLaunch }
  | { kind: 'parent_closed' }
  | { kind: 'sdk_started' }
  | { kind: 'sdk_exited' }
  | { kind: 'spawn_failed' };
export interface DirectGuardianTransition {
  state: DirectGuardianState;
  action: 'none' | 'spawn' | 'stop' | 'record_exited' | 'record_never_started';
}

export function decideDirectGuardianTransition(
  identity: DirectProcessIdentity,
  state: DirectGuardianState,
  event: DirectGuardianEvent
): DirectGuardianTransition {
  if (state === 'terminal') return { state, action: 'none' };
  if (event.kind === 'go') {
    const proof = event.authorization;
    return state === 'waiting' &&
      proof.state === 'authorized' &&
      proof.id === identity.id &&
      proof.token === identity.token &&
      proof.attemptId === identity.attemptId &&
      proof.sessionId === identity.sessionId &&
      proof.generation === identity.generation
      ? { state: 'launching', action: 'spawn' }
      : { state, action: 'none' };
  }
  if (event.kind === 'parent_closed') {
    if (state === 'waiting') return { state: 'terminal', action: 'record_never_started' };
    if (state === 'launching') return { state: 'stopping_launch', action: 'stop' };
    return state === 'running' ? { state: 'stopping', action: 'stop' } : { state, action: 'none' };
  }
  if (event.kind === 'sdk_started') {
    if (state === 'launching') return { state: 'running', action: 'none' };
    if (state === 'stopping_launch') return { state: 'stopping', action: 'stop' };
  }
  if (event.kind === 'spawn_failed' && (state === 'launching' || state === 'stopping_launch'))
    return { state: 'terminal', action: 'record_never_started' };
  if (event.kind === 'sdk_exited' && state !== 'waiting')
    return { state: 'terminal', action: 'record_exited' };
  return { state, action: 'none' };
}
