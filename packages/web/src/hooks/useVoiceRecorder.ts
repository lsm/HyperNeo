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
  /** Identifies the rendering surface (window into the app) a composer is mounted in. */
  surfaceId: string;
  /** The Space this surface belongs to, or null for the primary chat surface. */
  spaceId: string | null;
  /**
   * The Space task this surface scopes to (task thread pane, task-context
   * agent overlay), or null. Recordings started here are stamped with the
   * task so the global chip reopens the TASK thread — whose composer delivers
   * through `space.task.sendMessage` with task/agent/node context — instead
   * of a plain Space session chat.
   */
  taskId?: string | null;
}

/**
 * Provided by each surface that hosts composers: MainContent ('primary') and
 * the Space agent overlay. Lets a composer report WHERE it is mounted — the
 * global recording chip needs this because two surfaces can display the same
 * session at once, so session equality alone cannot tell whether the
 * recording's waveform is visible where the user is looking.
 */
export const VoiceSurfaceContext = createContext<VoiceSurfaceInfo>({
  surfaceId: 'primary',
  spaceId: null,
  taskId: null,
});

export function useVoiceRecorder(sessionId: string, options?: { autoAdopt?: boolean }) {
  // Stable per-instance owner token (survives re-renders, unique per mount).
  const ownerIdRef = useRef(`voice-owner-${Math.random().toString(36).slice(2)}`);
  const ownerId = ownerIdRef.current;
  const owns = () => voiceRecorderStore.recordingOwnerId.value === ownerId;
  // Mid-transcription composers pass false: the in-flight request's error
  // path cancels "its" recording, which would destroy an unrelated capture
  // adopted in that window.
  const autoAdopt = options?.autoAdopt !== false;
  const surface = useContext(VoiceSurfaceContext);

  // Register this composer FIRST (effects run in definition order, so this
  // precedes the adoption effect below): whenever ownership lands on this
  // instance, the registry already maps its token to this surface and the
  // global chip can attribute the recording correctly. canAdopt re-registers
  // when transcription starts/ends — the chip must not treat a temporarily
  // adoption-refusing composer as "will show the recording".
  const surfaceId = surface.surfaceId;
  const surfaceSpaceId = surface.spaceId;
  const surfaceTaskId = surface.taskId ?? null;
  useEffect(() => {
    registerVoiceComposer(ownerId, { surfaceId, sessionId, canAdopt: autoAdopt });
    return () => unregisterVoiceComposer(ownerId);
  }, [ownerId, surfaceId, sessionId, autoAdopt]);

  // Session changes (mount + retarget) drive both the retarget guard and
  // adoption; ownership transitions re-trigger adoption so a recording freed
  // by its owner's unmount is picked up by an already-mounted same-session
  // composer. Plain-prop reads don't rerun a signal effect, so this is a
  // useEffect keyed to sessionId plus the ownership signal subscription below.
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== sessionId) {
      // Retargeted to a DIFFERENT session: relinquish ownership of the
      // recording held for the old session (orphaning it for that session's
      // next composer) instead of delivering the old session's audio through
      // the new session's send path.
      voiceRecorderStore.orphan(ownerId);
    }
    prevSessionIdRef.current = sessionId;
    // Adopt: a recording for THIS session with no live owner becomes ours.
    // adopt() refuses owned recordings, so concurrently-mounted composers are
    // never disturbed. Deferred while mid-transcription for the same reason
    // as the reactive adoption below.
    if (autoAdopt) voiceRecorderStore.adopt(ownerId, sessionId);
  }, [ownerId, sessionId, autoAdopt]);

  // Re-attempt adoption whenever ownership frees up (the ownerId signal
  // transitions to orphaned while this composer stays bound to its session).
  // Skipped while this composer is mid-transcription (autoAdopt=false): the
  // in-flight request's error path cancels "its" recording, and adopting an
  // unrelated new capture in that window would let that cancel destroy it.
  useSignalEffect(() => {
    void voiceRecorderStore.recordingOwnerId.value;
    if (autoAdopt) voiceRecorderStore.adopt(ownerId, sessionId);
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
    /**
     * The session this recording actually belongs to while this instance owns
     * it — consumers use it to keep a pinned delivery target synchronized
     * with ADOPTED recordings (whose session this composer never started).
     */
    get recordingSessionId() {
      return owns() ? voiceRecorderStore.recordingSessionId.value : null;
    },
    /** Wall-clock start of the owned recording (for accurate remaining-time UI). */
    get recordingStartedAt() {
      return owns() ? voiceRecorderStore.recordingStartedAt.value : null;
    },
    /**
     * The caret/selection the owner captured at recording start, for consumers
     * restoring the insertion point across an adoption handoff.
     */
    get recordingCursor() {
      return owns() ? voiceRecorderStore.recordingCursor.value : null;
    },
    /** Start a recording owned by this composer; `cursor` is the composer's
     *  caret/selection at recording start (restored on adoption). The
     *  recording is stamped with this surface's Space (and task) so the
     *  global chip can later route back through the recording's OWNING
     *  surface — reopening the task thread for task-scoped recordings. */
    start: (cursor?: { start: number; end: number } | null) =>
      voiceRecorderStore.start(ownerId, sessionId, cursor, surfaceSpaceId, surfaceTaskId),
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
