import type { ConnectionResumeEffects } from './connection-resume-pipeline';
import { appState } from './state';
import { globalStore } from './global-store';
import { refreshAllSessionStores } from './session-store';
import { spaceStore } from './space-store';
import { spaceAgentStore } from './space-agent-store';

type ConnectionResumeOwner = Pick<ConnectionResumeEffects, 'checkHealth' | 'joinChannel'>;

export function createDefaultConnectionResumeEffects(
  owner: ConnectionResumeOwner
): ConnectionResumeEffects {
  return {
    checkHealth: () => owner.checkHealth(),
    joinChannel: (channel) => owner.joinChannel(channel),
    getActiveSpaceId: () => spaceStore.spaceId.value,
    refreshSessions: refreshAllSessionStores,
    refreshApp: () => appState.refreshAll(),
    refreshGlobal: () => globalStore.refresh(),
    refreshSpace: () => spaceStore.refresh(),
    recoverAgents: () => spaceAgentStore.recover(),
  };
}
