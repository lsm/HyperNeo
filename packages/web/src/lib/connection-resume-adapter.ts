import type { ConnectionResumeEffects } from './connection-resume-pipeline';
import { appState } from './state';
import { globalStore } from './global-store';
import { refreshAllSessionStores } from './session-store';
import { shellExtensions } from './web-extensions';

type ConnectionResumeOwner = Pick<ConnectionResumeEffects, 'checkHealth' | 'joinChannel'>;

export function createDefaultConnectionResumeEffects(
  owner: ConnectionResumeOwner
): ConnectionResumeEffects {
  return {
    checkHealth: () => owner.checkHealth(),
    joinChannel: (channel) => owner.joinChannel(channel),
    extensionChannels: () =>
      shellExtensions().flatMap((extension) => extension.activeChannel() ?? []),
    refreshSessions: refreshAllSessionStores,
    refreshApp: () => appState.refreshAll(),
    refreshGlobal: () => globalStore.refresh(),
    refreshExtensions: async () => {
      await Promise.all(shellExtensions().map((extension) => extension.refresh()));
    },
  };
}
