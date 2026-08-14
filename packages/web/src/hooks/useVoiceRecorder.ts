/**
 * useVoiceRecorder — thin adapter over the process-wide voiceRecorderStore.
 *
 * The capture logic lives in ../lib/voice/voice-recorder-store.ts (a
 * signals-backed singleton) so a recording can outlive the keyed composer that
 * started it. This hook preserves the previous per-composer semantics exactly,
 * including discarding an in-flight or active recording on unmount — the
 * follow-up change that keeps recordings alive across session switches only
 * removes the release effect below.
 */

import { useEffect } from 'preact/hooks';
import { voiceRecorderStore } from '../lib/voice/voice-recorder-store.ts';

export { isVoiceRecordingSupported } from '../lib/voice/voice-recorder-store.ts';
export type { VoiceRecording } from '../lib/voice/voice-recorder-store.ts';

// Stable view: reading these getters during render reads `signal.value`, which
// subscribes the component through @preact/signals — same reactivity contract
// as the previous useState-based hook, without recreating an object per render.
const voiceRecorderView = {
  get isRecording() {
    return voiceRecorderStore.isRecording.value;
  },
  get isStarting() {
    return voiceRecorderStore.isStarting.value;
  },
  get durationLimitHit() {
    return voiceRecorderStore.durationLimitHit.value;
  },
  start: voiceRecorderStore.start,
  stop: voiceRecorderStore.stop,
  cancel: voiceRecorderStore.cancel,
  getLevel: voiceRecorderStore.getLevel,
};

export function useVoiceRecorder() {
  // Composer unmount discards any recording this composer had in flight —
  // identical to the pre-store behavior. (PR 4 removes this to let recordings
  // survive session switches.)
  useEffect(() => {
    return () => {
      void voiceRecorderStore.release();
    };
  }, []);

  return voiceRecorderView;
}
