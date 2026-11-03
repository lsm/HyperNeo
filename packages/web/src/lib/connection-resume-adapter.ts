import type { ConnectionResumeEffects } from './connection-resume-pipeline';
import { appState } from './state';
import { globalStore } from './global-store';
import { refreshAllSessionStores } from './session-store';
import { webExtension } from './web-extensions';

type ConnectionResumeOwner = Pick<ConnectionResumeEffects, 'checkHealth' | 'joinChannel'>;

export function createDefaultConnectionResumeEffects(
  owner: ConnectionResumeOwner
): ConnectionResumeEffects {
  return {
    checkHealth: () => owner.checkHealth(),
    joinChannel: (channel) => owner.joinChannel(channel),
    getActiveSpaceId: () => webExtension('space')?.store.spaceId.value ?? null,
    refreshSessions: refreshAllSessionStores,
    refreshApp: () => appState.refreshAll(),
    refreshGlobal: () => globalStore.refresh(),
    refreshSpace: async () => webExtension('space')?.store.refresh(),
  };
}
