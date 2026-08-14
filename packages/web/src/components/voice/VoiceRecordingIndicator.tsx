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
 * one currently displayed. The displayed session accounts for BOTH routing
 * surfaces: the primary chat (`currentSessionIdSignal`) and Space session
 * views (`currentSpaceSessionIdSignal` + its owning space), and the return
 * navigation targets whichever surface is active (any open Space surface
 * keeps spaceId populated — overview, task, goals, sessions pages alike). The
 * chip sits at z-[60], above the z-50 agent overlay portal: equal-z portals
 * append to document.body after the app root and paint later, so an equal z
 * would leave the overlay intercepting clicks — and an overlay hiding the
 * base session's recording is precisely an "elsewhere" case the chip must
 * stay usable for.
 */

import { voiceRecorderStore } from '../../lib/voice/voice-recorder-store.ts';
import {
  currentSessionIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  spaceOverlaySessionIdSignal,
} from '../../lib/signals.ts';
import { navigateToSession, navigateToSpaceSession } from '../../lib/router.ts';

export function VoiceRecordingIndicator() {
  const isRecording =
    voiceRecorderStore.isRecording.value || voiceRecorderStore.durationLimitHit.value;
  const recordingSessionId = voiceRecorderStore.recordingSessionId.value;
  // Displayed session across both routing surfaces. A Space session view
  // leaves currentSessionIdSignal null and keys its ChatContainer by the
  // space-session id instead.
  const primarySessionId = currentSessionIdSignal.value;
  const spaceSessionId = currentSpaceSessionIdSignal.value;
  const spaceId = currentSpaceIdSignal.value;
  // An open agent overlay displays ITS session: the base Space session signal
  // still holds the underlying session, but the overlay is what the user sees.
  const overlaySessionId = spaceOverlaySessionIdSignal.value;
  const displayedSessionId = overlaySessionId ?? spaceSessionId ?? primarySessionId;

  // Show only for a live recording belonging to some OTHER session (or with
  // no session displayed at all).
  if (
    !isRecording ||
    !recordingSessionId ||
    (displayedSessionId !== null && displayedSessionId === recordingSessionId)
  ) {
    return null;
  }

  const returnToRecording = () => {
    // Stay within any open Space SURFACE (overview/task/session pages all keep
    // spaceId populated even when the session signal is cleared) — routing to
    // the generic chat view would exit the Space entirely.
    if (spaceId !== null) {
      navigateToSpaceSession(spaceId, recordingSessionId);
    } else {
      navigateToSession(recordingSessionId);
    }
  };

  return (
    <button
      type="button"
      onClick={returnToRecording}
      class="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-[60] flex items-center gap-2 rounded-full
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
