import { GLOBAL_SYSTEM_SNAPSHOT_REQUEST, STATE_CHANNELS } from '@hyperneo/shared';
import type { GlobalSystemSnapshot, SettingsState } from '@hyperneo/shared';
import { useEffect } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { applyLanguage } from '../lib/i18n/index.ts';
import { connectionState } from '../lib/state.ts';

export function useNeoLanguageSetting(): void {
  const connected = connectionState.value === 'connected';
  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub || !connected) return;
    let active = true;
    let updated = false;
    const unsubscribe = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, (state) => {
      updated = true;
      if (active) applyLanguage(state.settings?.language);
    });
    void hub
      .request<GlobalSystemSnapshot>(STATE_CHANNELS.GLOBAL_SNAPSHOT, GLOBAL_SYSTEM_SNAPSHOT_REQUEST)
      .then((snapshot) => {
        if (active && !updated) applyLanguage(snapshot.settings?.settings?.language);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [connected]);
}
