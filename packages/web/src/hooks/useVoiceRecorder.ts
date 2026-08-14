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
 * cancel so one composer can never discard another's recording.
 *
 * A recording SURVIVES its composer's unmount: the unmount orphans the
 * recording (capture continues; ownership clears) and the next composer
 * mounted for the same session adopts it — so switching sessions and coming
 * back mid-recording keeps the mic running and the waveform re-attaches.
 */

import { useEffect, useRef } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { voiceRecorderStore } from '../lib/voice/voice-recorder-store.ts';

export { isVoiceRecordingSupported } from '../lib/voice/voice-recorder-store.ts';
export type { VoiceRecording } from '../lib/voice/voice-recorder-store.ts';

export function useVoiceRecorder(sessionId: string) {
  // Stable per-instance owner token (survives re-renders, unique per mount).
  const ownerIdRef = useRef(`voice-owner-${Math.random().toString(36).slice(2)}`);
  const ownerId = ownerIdRef.current;
  const owns = () => voiceRecorderStore.recordingOwnerId.value === ownerId;

  // Adopt on mount AND whenever ownership frees up while this composer is
  // bound to the recording's session: if a recording for THIS session was
  // orphaned (its owner unmounted mid-recording), this composer takes it
  // over. adopt() refuses recordings that still have a live owner, so a
  // concurrently-mounted composer is never disturbed.
  useSignalEffect(() => {
    // Subscribe to ownership changes; adopt only when there is no owner.
    void voiceRecorderStore.recordingOwnerId.value;
    voiceRecorderStore.adopt(ownerId, sessionId);
  });

  // A composer re-targeted to a DIFFERENT session relinquishes ownership of
  // the recording it hold for its old session (orphaning it for the next
  // composer of that session) instead of delivering the old session's audio
  // through the new session's send path.
  const prevSessionIdRef = useRef(sessionId);
  useSignalEffect(() => {
    void voiceRecorderStore.recordingSessionId.value;
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      voiceRecorderStore.orphan(ownerId);
    }
  });

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

  // Composer unmount hands the recording to whoever opens this session next —
  // capture stays live (orphaned), the cap timers still bound it, and the
  // pending audio remains recoverable. Scoped to THIS instance: unmounting a
  // composer that never owned the recording changes nothing.
  useEffect(() => {
    return () => {
      voiceRecorderStore.orphan(ownerId);
    };
    // ownerId is ref-backed and stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return view;
}
