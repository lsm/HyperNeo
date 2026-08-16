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
 * Two instances exist, one per rendering surface: MainContent renders the
 * base instance (which stands down while an overlay is open), and the agent
 * overlay renders one INSIDE its focus-trapped panel so keyboard users can
 * Tab to it. Visibility is surface-aware: the chip hides only when the
 * recording's OWNING composer is mounted on this surface — or, while
 * orphaned, when this surface displays the recording's session — because an
 * overlay can display the same session as the covered, still-owning base
 * composer, and session equality alone cannot tell the two apart.
 *
 * Return navigation routes through the recording's OWNING surface (captured
 * at recording start, `recordingSpaceId`), never the currently-displayed
 * Space: a primary-chat recording must land on the chat route even when the
 * user clicks Return from inside some Space.
 *
 * Stacking: the base instance sits at z-40 — above page chrome (z-30) but
 * below z-50 blocking modals, whose confirmation flow must not be bypassed
 * through the chip. The in-overlay instance lives inside the overlay's z-50
 * stacking context, so it is above the panel yet still below modals portaled
 * later into the body.
 */

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
  // Include STARTUP: a pending getUserMedia/AudioContext setup survives its
  // composer's unmount (permission prompts can block it indefinitely), and
  // dropping the chip for that window would leave the originating recording
  // UI undiscoverable until startup finishes.
  const isRecording =
    voiceRecorderStore.isRecording.value ||
    voiceRecorderStore.durationLimitHit.value ||
    voiceRecorderStore.isStarting.value;
  const recordingSessionId = voiceRecorderStore.recordingSessionId.value;
  const recordingSpaceId = voiceRecorderStore.recordingSpaceId.value;
  const recordingTaskId = voiceRecorderStore.recordingTaskId.value;
  // Displayed session across both routing surfaces. A Space session view
  // leaves currentSessionIdSignal null and keys its ChatContainer by the
  // space-session id instead.
  const primarySessionId = currentSessionIdSignal.value;
  const spaceSessionId = currentSpaceSessionIdSignal.value;
  // An open agent overlay displays ITS session: the base Space session signal
  // still holds the underlying session, but the overlay is what the user sees.
  // A PENDING overlay (workflow peer not yet spawned) covers the base session
  // too, while its session id signal is still null.
  const overlaySessionId = spaceOverlaySessionIdSignal.value;
  const overlayPending = spaceOverlayPendingAgentNameSignal.value !== null;
  const overlayOpen = overlaySessionId !== null || overlayPending;
  // The base instance stands down while an overlay is open: the overlay
  // renders its own instance inside its panel, and a second chip underneath
  // would only duplicate the a11y tree.
  if (!inOverlay && overlayOpen) return null;

  const displayedSessionId =
    overlaySessionId ?? (overlayPending ? null : spaceSessionId) ?? primarySessionId;

  // The recording is visible HERE when its owning composer is mounted on this
  // surface; an ORPHANED recording is visible here only when a composer on
  // this surface displays its session AND may adopt it — a mid-transcription
  // composer deliberately refuses adoption, and session equality alone would
  // suppress the only Return affordance while the capture continues unseen.
  // An owner unregistered (e.g. between unmount and adoption) reads as "not
  // here" — the safe default keeps the recording discoverable.
  const ownerSurface = voiceComposerSurfaceOf(voiceRecorderStore.recordingOwnerId.value);
  const recordingVisibleHere =
    ownerSurface !== null
      ? ownerSurface === surface.surfaceId
      : displayedSessionId !== null &&
        displayedSessionId === recordingSessionId &&
        hasAdoptableComposerOnSurface(surface.surfaceId, recordingSessionId);

  if (!isRecording || !recordingSessionId || recordingVisibleHere) return null;

  // The overlay displays the recording's own session but its composer does
  // not own the capture — the covered base composer does. Closing the overlay
  // re-reveals that waveform; no navigation (so the async history.back() of a
  // normal close cannot race a route push).
  const recordingBehindThisOverlay = inOverlay && overlaySessionId === recordingSessionId;

  const returnToRecording = () => {
    if (recordingBehindThisOverlay) {
      closeOverlayHistory();
      return;
    }
    // A task-scoped recording returns to the TASK thread — its composer
    // delivers through space.task.sendMessage with task/agent/node context —
    // never to a plain Space session chat, whose adopting composer would send
    // the transcript down ordinary session messaging. The comparison path
    // must use the SAME 'thread' view as navigateToSpaceTask below, or a
    // same-path overlay entry (whose URL already ends in /thread) would be
    // missed by the equality check and never popped.
    const targetPath =
      recordingTaskId !== null && recordingSpaceId !== null
        ? createSpaceTaskPath(recordingSpaceId, recordingTaskId, 'thread')
        : recordingSpaceId !== null
          ? createSpaceSessionPath(recordingSpaceId, recordingSessionId)
          : createSessionPath(recordingSessionId);
    if (overlayOpen) {
      if (getCurrentPath() === targetPath) {
        // Destination URL already matches (an overlay keeps the base URL) and
        // the navigate fast-path performs no history write for a same-path
        // target, so replace=true could not consume the overlay's duplicate
        // entry — pop it with back() instead. Safe here because no push
        // follows: the async traversal cannot race a navigation.
        closeOverlayHistory();
      } else {
        // Clear the overlay SYNCHRONOUSLY: closeOverlayHistory()'s
        // window.history.back() resolves asynchronously, and a route pushed
        // in the same tick races that pending popstate onto a stale entry.
        // The still-top overlay entry is then consumed by the replace below.
        clearOverlaySignals();
      }
    }
    // When an overlay was open, its history entry is still on top — REPLACE
    // it with the target route (consuming it) instead of pushing above it.
    const replace = overlayOpen;
    if (recordingTaskId !== null && recordingSpaceId !== null) {
      // Ask the task thread to preselect the target whose session owns the
      // recording: SpaceTaskPane defaults to the first/visible agent, and a
      // non-default recipient must be restored or the composer cannot adopt.
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
      class={`fixed bottom-20 right-4 sm:bottom-6 sm:right-6 ${inOverlay ? 'z-[55]' : 'z-40'} flex items-center gap-2 rounded-full
        bg-gray-900/90 backdrop-blur border border-red-500/40 pl-3 pr-4 py-2 shadow-lg
        text-sm text-gray-100 hover:bg-gray-800/90 transition-colors`}
      aria-label={
        recordingBehindThisOverlay
          ? 'Voice recording in progress in this session — click to return'
          : 'Voice recording in progress in another session — click to return'
      }
      data-testid="voice-recording-elsewhere"
    >
      <span class="relative flex h-2.5 w-2.5">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
      </span>
      <span class="max-w-40 truncate">
        {recordingBehindThisOverlay ? 'Recording in this session' : 'Recording in another session'}
      </span>
      <span class="text-red-300 font-medium">Return</span>
    </button>
  );
}
