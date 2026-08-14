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
 * chip sits at z-[55]: above the z-50 agent overlay (whose portal appends to
 * document.body after the app root and therefore paints later at equal z),
 * but below blocking modals rendered later in body order at z-50+ so a modal's
 * confirmation flow cannot be bypassed through the chip.
 */

import { voiceRecorderStore } from '../../lib/voice/voice-recorder-store.ts';
import {
  currentSessionIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  spaceOverlayPendingAgentNameSignal,
  spaceOverlaySessionIdSignal,
} from '../../lib/signals.ts';
import {
  closeOverlayHistory,
  navigateToSession,
  navigateToSpaceSession,
} from '../../lib/router.ts';

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
  // A PENDING overlay (workflow peer not yet spawned) covers the base session
  // too, while its session id signal is still null.
  const overlaySessionId = spaceOverlaySessionIdSignal.value;
  const overlayPending = spaceOverlayPendingAgentNameSignal.value !== null;
  const displayedSessionId =
    overlaySessionId ?? (overlayPending ? null : spaceSessionId) ?? primarySessionId;

  // Show only for a live recording belonging to some OTHER session (or with
  // no session displayed at all).
  if (
    !isRecording ||
    !recordingSessionId ||
    (displayedSessionId !== null && displayedSessionId === recordingSessionId)
  ) {
    return null;
  }

  const overlayOpen = overlaySessionId !== null || overlayPending;
  const returnToRecording = () => {
    // Drop any open/pending overlay first: it covers the whole viewport, so
    // navigating alone would only select the recording session BEHIND it.
    if (overlayOpen) closeOverlayHistory();
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
      class="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-[55] flex items-center gap-2 rounded-full
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
