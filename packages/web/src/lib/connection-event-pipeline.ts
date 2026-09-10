import superpipe, { type PipelineAPI } from 'superpipe';
import type { ConnectionState } from './state';
import { isAuthError } from './user-error';

export type ConnectionEventRoute = 'resume-connected' | 'auth-error' | 'normal';

export interface ConnectionEventEffects {
  setState(state: ConnectionState): void;
  setReconnectAttempts(attempts: number): void;
  startActions(): void;
  startAudio(): void;
  startTranscripts(): void;
  stopActions(): void;
  stopAudio(): void;
  stopTranscripts(): void;
  closeTransport(): void;
  redirectExpiredSession(): void;
  notifyConnected(): void;
  recoverAgents(): void | Promise<void>;
  getReconnectAttempts(): number | undefined;
}

export function routeConnectionEvent(
  state: ConnectionState,
  error: Error | undefined,
  isResuming: boolean
): ConnectionEventRoute {
  if (state === 'connected' && isResuming) return 'resume-connected';
  if (state === 'error' && error && isAuthError(error)) return 'auth-error';
  return 'normal';
}

export function applyConnectionState(
  effects: ConnectionEventEffects,
  state: ConnectionState,
  route: ConnectionEventRoute
): void {
  if (route === 'resume-connected') return;
  effects.setState(state);
  if (route !== 'auth-error') return;
  effects.stopActions();
  effects.stopAudio();
  effects.stopTranscripts();
  effects.closeTransport();
  effects.redirectExpiredSession();
}

export function applyConnectedEffects(
  effects: ConnectionEventEffects,
  state: ConnectionState,
  route: ConnectionEventRoute
): void {
  if (route === 'resume-connected') {
    effects.notifyConnected();
    return;
  }
  if (route !== 'normal' || state !== 'connected') return;
  effects.setReconnectAttempts(0);
  effects.startActions();
  effects.startAudio();
  effects.startTranscripts();
  effects.notifyConnected();
  void effects.recoverAgents();
}

export function applyReconnectAttempts(
  effects: ConnectionEventEffects,
  state: ConnectionState,
  route: ConnectionEventRoute
): void {
  if (route !== 'normal' || (state !== 'connecting' && state !== 'reconnecting')) return;
  const attempts = effects.getReconnectAttempts();
  if (attempts !== undefined) effects.setReconnectAttempts(attempts);
}

export const runConnectionEvent = (superpipe({})('connection-event') as PipelineAPI)
  .input(['effects', 'state', 'error', 'isResuming'])
  .pipe(routeConnectionEvent, ['state', 'error', 'isResuming'], 'route')
  .pipe(applyConnectionState, ['effects', 'state', 'route'])
  .pipe(applyConnectedEffects, ['effects', 'state', 'route'])
  .pipe(applyReconnectAttempts, ['effects', 'state', 'route'])
  .end('route') as (
  effects: ConnectionEventEffects,
  state: ConnectionState,
  error: Error | undefined,
  isResuming: boolean
) => ConnectionEventRoute;
