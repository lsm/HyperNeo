import { createSessionPath } from './router';

export interface AppRoutingState {
  sessionId: string | null;
  extensionPath: string | null;
  navSection: string;
}

export function deriveAppExpectedPath(state: AppRoutingState): string {
  if (state.sessionId) return createSessionPath(state.sessionId);
  if (state.extensionPath) return state.extensionPath;
  return state.navSection === 'settings' ? '/settings' : '/sessions';
}
