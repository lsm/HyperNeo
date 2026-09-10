import type { MessageHub } from '@hyperneo/shared';
import type { ConnectionManager } from './connection-manager';
import { appState, connectionState, type ConnectionState } from './state';
import { globalStore } from './global-store';
import { sessionStore } from './session-store';
import { currentSessionIdSignal, slashCommandsSignal } from './signals';
import { startAutoFlush, stopAutoFlush } from './outbound-queue';
import { startVoiceAudioOutboxFlush, stopVoiceAudioOutboxFlush } from './voice/voice-audio-outbox';
import {
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
} from './voice/voice-transcript-outbox';

export function createDefaultConnectionLifecycleEffects() {
  return {
    getState: () => connectionState.value,
    setState: (state: ConnectionState) => {
      connectionState.value = state;
    },
    startActions: startAutoFlush,
    stopActions: stopAutoFlush,
    startAudio: startVoiceAudioOutboxFlush,
    stopAudio: stopVoiceAudioOutboxFlush,
    startTranscripts: startVoiceTranscriptOutboxFlush,
    stopTranscripts: stopVoiceTranscriptOutboxFlush,
    exposeHub: (hub: MessageHub, manager: ConnectionManager) => {
      if (typeof window !== 'undefined') {
        window.__messageHub = hub;
        window.appState = appState;
        window.__messageHubReady = false;
        window.connectionManager = manager;
        window.globalStore = globalStore;
        window.sessionStore = sessionStore;
        window.currentSessionIdSignal = currentSessionIdSignal;
        window.slashCommandsSignal = slashCommandsSignal;
      }
    },
    markHubReady: () => {
      if (typeof window !== 'undefined' && window.__messageHub) {
        window.__messageHubReady = true;
      }
    },
  };
}
