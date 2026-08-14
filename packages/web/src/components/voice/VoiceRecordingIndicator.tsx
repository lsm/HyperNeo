/**
 * VoiceRecordingIndicator — global "recording elsewhere" affordance.
 *
 * The recorder is a process-wide singleton (#2484/#2485): a recording keeps
 * running when its composer unmounts (session switch), waiting for a composer
 * of the same session to adopt it. While the user is viewing a DIFFERENT
 * session, that recording is invisible — this chip makes it discoverable and
 * offers a one-click jump back to the recording's session (where the composer
 * adopts it and the waveform re-attaches).
 *
 * Renders nothing unless a live recording exists for a session other than the
 * one currently displayed.
 */

import { voiceRecorderStore } from '../../lib/voice/voice-recorder-store.ts';
import { currentSessionIdSignal } from '../../lib/signals.ts';
import { navigateToSession } from '../../lib/router.ts';

export function VoiceRecordingIndicator() {
  const isRecording =
    voiceRecorderStore.isRecording.value || voiceRecorderStore.durationLimitHit.value;
  const recordingSessionId = voiceRecorderStore.recordingSessionId.value;
  const currentSessionId = currentSessionIdSignal.value;

  // Show only for a live recording belonging to some OTHER session (or with
  // no session displayed at all).
  if (
    !isRecording ||
    !recordingSessionId ||
    (currentSessionId !== null && currentSessionId === recordingSessionId)
  ) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => navigateToSession(recordingSessionId)}
      class="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-40 flex items-center gap-2 rounded-full
        bg-gray-900/90 backdrop-blur border border-red-500/40 pl-3 pr-4 py-2 shadow-lg
        text-sm text-gray-100 hover:bg-gray-800/90 transition-colors"
      aria-label="Voice recording in progress in another session — click to return"
      data-testid="voice-recording-elsewhere"
    >
      <span class="relative flex h-2.5 w-2.5">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
      </span>
      <span class="max-w-40 truncate">Recording in another session</span>
      <span class="text-red-300 font-medium">Return</span>
    </button>
  );
}
