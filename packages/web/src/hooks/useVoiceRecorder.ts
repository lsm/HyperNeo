/**
 * useVoiceRecorder — session-scoped adapter over the process-wide
 * voiceRecorderStore.
 *
 * The capture logic lives in ../lib/voice/voice-recorder-store.ts (a
 * signals-backed singleton). Because multiple composers can be mounted at once
 * (an agent overlay keeps the base ChatContainer alive), the singleton tracks
 * which session owns the current recording: this hook's view only exposes the
 * recording while it belongs to THIS composer's session. Other composers see
 * an idle recorder — they can neither stop/transcribe someone else's recording
 * nor release it on their own unmount.
 */

import { useEffect } from 'preact/hooks';
import { voiceRecorderStore } from '../lib/voice/voice-recorder-store.ts';

export { isVoiceRecordingSupported } from '../lib/voice/voice-recorder-store.ts';
export type { VoiceRecording } from '../lib/voice/voice-recorder-store.ts';

export function useVoiceRecorder(sessionId: string) {
  // Reading these signals during render subscribes through @preact/signals —
  // same reactivity contract as the previous useState-based hook.
  const view = {
    get isRecording() {
      return (
        voiceRecorderStore.isRecording.value &&
        voiceRecorderStore.recordingSessionId.value === sessionId
      );
    },
    get isStarting() {
      return (
        voiceRecorderStore.isStarting.value &&
        voiceRecorderStore.recordingSessionId.value === sessionId
      );
    },
    get durationLimitHit() {
      return (
        voiceRecorderStore.durationLimitHit.value &&
        voiceRecorderStore.recordingSessionId.value === sessionId
      );
    },
    start: () => voiceRecorderStore.start(sessionId),
    stop: voiceRecorderStore.stop,
    cancel: voiceRecorderStore.cancel,
    getLevel: voiceRecorderStore.getLevel,
  };

  // Composer unmount discards a recording owned by THIS composer's session —
  // identical to the pre-store behavior. A recording owned by another session
  // (e.g. the base chat while an overlay closes) is left alone.
  useEffect(() => {
    return () => {
      if (voiceRecorderStore.recordingSessionId.value === sessionId) {
        void voiceRecorderStore.release();
      }
    };
  }, [sessionId]);

  return view;
}
