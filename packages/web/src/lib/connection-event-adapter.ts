import type { ConnectionEventEffects } from './connection-event-pipeline';
import { connectionState, reconnectAttemptCount } from './state';
import { spaceAgentStore } from './space-agent-store';
import { startAutoFlush, stopAutoFlush } from './outbound-queue';
import { startVoiceAudioOutboxFlush, stopVoiceAudioOutboxFlush } from './voice/voice-audio-outbox';
import {
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
} from './voice/voice-transcript-outbox';

type ConnectionEventOwner = Pick<
  ConnectionEventEffects,
  'closeTransport' | 'notifyConnected' | 'getReconnectAttempts'
>;

export function createDefaultConnectionEventEffects(
  owner: ConnectionEventOwner
): ConnectionEventEffects {
  return {
    setState: (state) => {
      connectionState.value = state;
    },
    setReconnectAttempts: (attempts) => {
      reconnectAttemptCount.value = attempts;
    },
    startActions: startAutoFlush,
    startAudio: startVoiceAudioOutboxFlush,
    startTranscripts: startVoiceTranscriptOutboxFlush,
    stopActions: stopAutoFlush,
    stopAudio: stopVoiceAudioOutboxFlush,
    stopTranscripts: stopVoiceTranscriptOutboxFlush,
    closeTransport: () => {
      owner.closeTransport();
    },
    redirectExpiredSession: () => {
      if (
        typeof window !== 'undefined' &&
        !window.location.search.includes('reason=session_expired')
      ) {
        window.location.href = '/settings?tab=providers&reason=session_expired';
      }
    },
    notifyConnected: () => owner.notifyConnected(),
    recoverAgents: () => spaceAgentStore.recover(),
    getReconnectAttempts: () => owner.getReconnectAttempts(),
  };
}
