import { STATE_CHANNELS } from '@hyperneo/shared';
import type { GlobalSettings, SettingsState } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';

export function useNeoVoiceSettings() {
  const [voice, setVoice] = useState<GlobalSettings['voice']>();
  const connected = connectionState.value === 'connected';
  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub || !connected) return;
    let active = true;
    let updated = false;
    const unsubscribe = hub.onEvent<SettingsState>(STATE_CHANNELS.GLOBAL_SETTINGS, (state) => {
      updated = true;
      if (active) setVoice(state.settings?.voice);
    });
    void hub
      .request<{ settings: SettingsState }>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {})
      .then((snapshot) => {
        if (active && !updated) setVoice(snapshot.settings?.settings?.voice);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [connected]);
  if (!voice?.enabled || !voice.model?.trim() || !voice.endpoint?.trim()) return false;
  try {
    return ['http:', 'https:'].includes(new URL(voice.endpoint).protocol);
  } catch {
    return false;
  }
}
