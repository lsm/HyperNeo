import { createContext } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { voiceRecorderStore } from '../lib/voice/voice-recorder-store.ts';
import {
  registerVoiceComposer,
  unregisterVoiceComposer,
} from '../lib/voice/voice-composer-registry.ts';

export { isVoiceRecordingSupported } from '../lib/voice/voice-recorder-store.ts';
export type { VoiceRecording } from '../lib/voice/voice-recorder-store.ts';

export interface VoiceSurfaceInfo {
  surfaceId: string;
  spaceId: string | null;
  taskId?: string | null;
}

export const VoiceSurfaceContext = createContext<VoiceSurfaceInfo>({
  surfaceId: 'primary',
  spaceId: null,
  taskId: null,
});

export function useVoiceRecorder(sessionId: string, options?: { autoAdopt?: boolean }) {
  const ownerIdRef = useRef(`voice-owner-${Math.random().toString(36).slice(2)}`);
  const ownerId = ownerIdRef.current;
  const owns = () => voiceRecorderStore.recordingOwnerId.value === ownerId;
  const autoAdopt = options?.autoAdopt !== false;
  const surface = useContext(VoiceSurfaceContext);

  const surfaceId = surface.surfaceId;
  const surfaceSpaceId = surface.spaceId;
  const surfaceTaskId = surface.taskId ?? null;
  useEffect(() => {
    registerVoiceComposer(ownerId, { surfaceId, sessionId, canAdopt: autoAdopt });
    return () => unregisterVoiceComposer(ownerId);
  }, [ownerId, surfaceId, sessionId, autoAdopt]);

  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== sessionId) {
      voiceRecorderStore.orphan(ownerId);
    }
    prevSessionIdRef.current = sessionId;
    if (autoAdopt) voiceRecorderStore.adopt(ownerId, sessionId);
  }, [ownerId, sessionId, autoAdopt]);

  useSignalEffect(() => {
    void voiceRecorderStore.recordingOwnerId.value;
    if (autoAdopt) voiceRecorderStore.adopt(ownerId, sessionId);
  });

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
    get recordingSessionId() {
      return owns() ? voiceRecorderStore.recordingSessionId.value : null;
    },
    get recordingStartedAt() {
      return owns() ? voiceRecorderStore.recordingStartedAt.value : null;
    },
    get recordingCursor() {
      return owns() ? voiceRecorderStore.recordingCursor.value : null;
    },
    start: (cursor?: { start: number; end: number } | null) =>
      voiceRecorderStore.start(ownerId, sessionId, cursor, surfaceSpaceId, surfaceTaskId),
    stop: voiceRecorderStore.stop,
    cancel: () => (owns() ? voiceRecorderStore.cancel() : Promise.resolve()),
    getLevel: voiceRecorderStore.getLevel,
  };

  useEffect(() => {
    return () => {
      voiceRecorderStore.orphan(ownerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return view;
}
