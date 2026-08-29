import { useContext } from 'preact/hooks';
import { voiceRecorderStore } from '../../lib/voice/voice-recorder-store.ts';
import {
  hasAdoptableComposerOnSurface,
  voiceComposerSurfaceOf,
  voiceReturnTaskTargetSessionSignal,
} from '../../lib/voice/voice-composer-registry.ts';
import { VoiceSurfaceContext } from '../../hooks/useVoiceRecorder.ts';
import {
  currentSessionIdSignal,
  currentSpaceSessionIdSignal,
  spaceOverlayPendingAgentNameSignal,
  spaceOverlaySessionIdSignal,
} from '../../lib/signals.ts';
import {
  clearOverlaySignals,
  closeOverlayHistory,
  createSessionPath,
  createSpaceSessionPath,
  createSpaceTaskPath,
  getCurrentPath,
  navigateToSession,
  navigateToSpaceSession,
  navigateToSpaceTask,
} from '../../lib/router.ts';

export function VoiceRecordingIndicator({ inOverlay = false }: { inOverlay?: boolean }) {
  const surface = useContext(VoiceSurfaceContext);
  const isRecording =
    voiceRecorderStore.isRecording.value ||
    voiceRecorderStore.durationLimitHit.value ||
    voiceRecorderStore.isStarting.value;
  const recordingSessionId = voiceRecorderStore.recordingSessionId.value;
  const recordingSpaceId = voiceRecorderStore.recordingSpaceId.value;
  const recordingTaskId = voiceRecorderStore.recordingTaskId.value;
  const primarySessionId = currentSessionIdSignal.value;
  const spaceSessionId = currentSpaceSessionIdSignal.value;
  const overlaySessionId = spaceOverlaySessionIdSignal.value;
  const overlayPending = spaceOverlayPendingAgentNameSignal.value !== null;
  const overlayOpen = overlaySessionId !== null || overlayPending;
  if (!inOverlay && overlayOpen) return null;

  const displayedSessionId =
    overlaySessionId ?? (overlayPending ? null : spaceSessionId) ?? primarySessionId;

  const ownerSurface = voiceComposerSurfaceOf(voiceRecorderStore.recordingOwnerId.value);
  const recordingVisibleHere =
    ownerSurface !== null
      ? ownerSurface === surface.surfaceId
      : displayedSessionId !== null &&
        displayedSessionId === recordingSessionId &&
        hasAdoptableComposerOnSurface(surface.surfaceId, recordingSessionId);

  if (!isRecording || !recordingSessionId || recordingVisibleHere) return null;

  const recordingBehindThisOverlay = inOverlay && overlaySessionId === recordingSessionId;

  const returnToRecording = () => {
    if (recordingBehindThisOverlay) {
      closeOverlayHistory();
      return;
    }
    const targetPath =
      recordingTaskId !== null && recordingSpaceId !== null
        ? createSpaceTaskPath(recordingSpaceId, recordingTaskId, 'thread')
        : recordingSpaceId !== null
          ? createSpaceSessionPath(recordingSpaceId, recordingSessionId)
          : createSessionPath(recordingSessionId);
    if (overlayOpen) {
      if (getCurrentPath() === targetPath) {
        closeOverlayHistory();
      } else {
        clearOverlaySignals();
      }
    }
    const replace = overlayOpen;
    if (recordingTaskId !== null && recordingSpaceId !== null) {
      voiceReturnTaskTargetSessionSignal.value = recordingSessionId;
      navigateToSpaceTask(recordingSpaceId, recordingTaskId, 'thread', replace);
    } else if (recordingSpaceId !== null) {
      navigateToSpaceSession(recordingSpaceId, recordingSessionId, replace);
    } else {
      navigateToSession(recordingSessionId, replace);
    }
  };

  return (
    <button
      type="button"
      onClick={returnToRecording}
      class={`fixed bottom-20 right-4 sm:bottom-6 sm:right-6 ${inOverlay ? 'z-[55]' : 'z-40'} flex items-center gap-2 rounded-full bg-surface/90 backdrop-blur border border-danger/40 pl-3 pr-4 py-2 shadow-lg text-sm text-fg hover:bg-surface-raised/90 transition-colors`}
      aria-label={
        recordingBehindThisOverlay
          ? 'Voice recording in progress in this session — click to return'
          : 'Voice recording in progress in another session — click to return'
      }
      data-testid="voice-recording-elsewhere"
    >
      <span class="relative flex h-2.5 w-2.5">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-danger" />
      </span>
      <span class="max-w-40 truncate">
        {recordingBehindThisOverlay ? 'Recording in this session' : 'Recording in another session'}
      </span>
      <span class="text-danger-soft font-medium">Return</span>
    </button>
  );
}
