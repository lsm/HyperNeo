import type { GlobalSystemSnapshot, SettingsState } from '@hyperneo/shared';
import { GLOBAL_SYSTEM_SNAPSHOT_REQUEST, STATE_CHANNELS } from '@hyperneo/shared';
import { connectionManager } from '../connection-manager.ts';
import { applyLanguage } from './index.ts';

export async function followLanguageSetting(): Promise<void> {
  const hub = await connectionManager.getHub();
  hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, (state) =>
    applyLanguage(state.settings?.language)
  );
  const snapshot = await hub.request<GlobalSystemSnapshot>(
    STATE_CHANNELS.GLOBAL_SNAPSHOT,
    GLOBAL_SYSTEM_SNAPSHOT_REQUEST
  );
  applyLanguage(snapshot?.settings?.settings?.language);
}
