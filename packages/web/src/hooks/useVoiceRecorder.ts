/**
 * useVoiceRecorder — per-composer adapter over the process-wide
 * voiceRecorderStore.
 *
 * The capture logic lives in ../lib/voice/voice-recorder-store.ts (a
 * signals-backed singleton). Because multiple composers can be mounted at once
 * — an agent overlay keeps the base ChatContainer alive, and a Space task pane
 * and its agent overlay can even share one sessionId — the singleton tracks
 * ownership by COMPOSER INSTANCE: each hook instance mints a stable owner
 * token, exposes the recording only while this instance owns it, and scopes
 * cancel/release so one composer can never stop or discard another's
 * recording.
 */

import { useEffect, useRef } from 'preact/hooks';
import { voiceRecorderStore } from '../lib/voice/voice-recorder-store.ts';

export { isVoiceRecordingSupported } from '../lib/voice/voice-recorder-store.ts';
export type { VoiceRecording } from '../lib/voice/voice-recorder-store.ts';

export function useVoiceRecorder(sessionId: string) {
  // Stable per-instance owner token (survives re-renders, unique per mount).
  const ownerIdRef = useRef(`voice-owner-${Math.random().toString(36).slice(2)}`);
  const ownerId = ownerIdRef.current;
  const owns = () => voiceRecorderStore.recordingOwnerId.value === ownerId;

  // Reading these signals during render subscribes through @preact/signals —
  // same reactivity contract as the previous useState-based hook.
  const view = {
    get isRecording() {
      return voiceRecorderStore.isRecording.value && owns();
    },
    get isStarting() {
      return voiceRecorderStore.isStarting.value && owns();
    },
    get durationLimitHit() {
      return voiceRecorderStore.durationLimitHit.value && owns();
    },
    start: () => voiceRecorderStore.start(ownerId, sessionId),
    stop: voiceRecorderStore.stop,
    /** Cancels only this instance's recording; a no-op for anyone else's. */
    cancel: () => (owns() ? voiceRecorderStore.cancel() : Promise.resolve()),
    getLevel: voiceRecorderStore.getLevel,
  };

  // Composer unmount discards a recording owned by THIS instance — identical
  // to the pre-store behavior. Recordings owned by other concurrently-mounted
  // composers are left alone.
  useEffect(() => {
    return () => {
      if (owns()) {
        void voiceRecorderStore.release();
      }
    };
    // ownerId is ref-backed and stable; sessionId changes must NOT re-run the
    // cleanup (a mid-recording re-target keeps the recording until unmount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return view;
}
