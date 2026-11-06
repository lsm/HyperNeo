import { useContext } from 'preact/hooks';
import { voiceRecorderStore } from '../../lib/voice/voice-recorder-store.ts';
import {
  hasAdoptableComposerOnSurface,
  voiceComposerSurfaceOf,
} from '../../lib/voice/voice-composer-registry.ts';
import { VoiceSurfaceContext } from '../../hooks/useVoiceRecorder.ts';
import { currentSessionIdSignal } from '../../lib/signals.ts';
import { createSessionPath, getCurrentPath, navigateToSession } from '../../lib/router.ts';
import { extensionNav } from '../../lib/web-extensions.ts';

export function VoiceRecordingIndicator({ inOverlay = false }: { inOverlay?: boolean }) {
  const surface = useContext(VoiceSurfaceContext);
  const isRecording =
    voiceRecorderStore.isRecording.value ||
    voiceRecorderStore.durationLimitHit.value ||
    voiceRecorderStore.isStarting.value;
  const recordingSessionId = voiceRecorderStore.recordingSessionId.value;
  const recordingScopeId = voiceRecorderStore.recordingScopeId.value;
  const recordingTaskId = voiceRecorderStore.recordingTaskId.value;
  const primarySessionId = currentSessionIdSignal.value;
  const focus = extensionNav().flatMap((nav) => nav.sessionFocus() ?? [])[0];
  const overlaySessionId = focus?.overlaySessionId ?? null;
  const overlayOpen = focus?.overlayOpen ?? false;
  if (!inOverlay && overlayOpen) return null;

  const displayedSessionId = focus?.sessionId ?? primarySessionId;

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
      focus?.closeOverlay();
      return;
    }
    const extensionReturn =
      recordingScopeId === null
        ? undefined
        : extensionNav().flatMap(
            (nav) =>
              nav.recordingReturn(recordingScopeId, recordingSessionId, recordingTaskId) ?? []
          )[0];
    const targetPath = extensionReturn?.path ?? createSessionPath(recordingSessionId);
    if (overlayOpen) {
      if (getCurrentPath() === targetPath) {
        focus?.closeOverlay();
      } else {
        focus?.clearOverlay();
      }
    }
    const replace = overlayOpen;
    if (extensionReturn) extensionReturn.open(replace);
    else navigateToSession(recordingSessionId, replace);
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
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-danger opacity-75" />
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-danger" />
      </span>
      <span class="max-w-40 truncate">
        {recordingBehindThisOverlay ? 'Recording in this session' : 'Recording in another session'}
      </span>
      <span class="text-danger-soft font-medium">Return</span>
    </button>
  );
}
