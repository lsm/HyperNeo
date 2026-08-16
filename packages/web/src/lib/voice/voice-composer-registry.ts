/**
 * Registry of mounted voice composers, keyed by owner token.
 *
 * The recorder store identifies a recording's owner by its composer's opaque
 * owner token (see useVoiceRecorder); the global "recording elsewhere" chip
 * needs facts the store cannot know — WHERE each mounted composer lives and
 * whether it may adopt. Two surfaces can display the SAME session at once (a
 * Space task pane and the agent overlay opened over it), so session equality
 * alone cannot tell whether the recording's waveform is visible where the
 * user is looking. Each mounted composer registers its surface here (via the
 * VoiceSurfaceContext its surface provides), and the indicator consults the
 * registry to (a) attribute an OWNED recording to the surface its owner is
 * mounted in, and (b) hide an ORPHANED recording only when a composer on
 * this surface actually displays its session and is allowed to adopt it — a
 * mid-transcription composer deliberately refuses adoption, and treating it
 * as "will show the recording" would hide the only Return affordance.
 *
 * Plain Map, not signals: ownership transitions (the only moments visibility
 * can change) already flow through `recordingOwnerId`, whose signal
 * re-renders every observer and re-reads this map after each registration.
 */

import { signal } from '@preact/signals';

/**
 * Session the global chip wants the returned-to task thread to select as its
 * recipient. A task-scoped recording can belong to a NON-default agent target;
 * SpaceTaskPane preselects the first/visible target on mount, so without this
 * the returning composer may bind to a different session and fail to adopt.
 * Set by the chip before it navigates to a task, consumed (and cleared) by
 * SpaceTaskPane once it has preselected the matching target.
 */
export const voiceReturnTaskTargetSessionSignal = signal<string | null>(null);

export interface VoiceComposerInfo {
  /** Rendering surface the composer is mounted in (VoiceSurfaceContext). */
  surfaceId: string;
  /** Session the composer is bound to. */
  sessionId: string;
  /** False only while mid-transcription, when adoption is deliberately refused. */
  canAdopt: boolean;
}

const composersByOwner = new Map<string, VoiceComposerInfo>();

/** Called by useVoiceRecorder on mount and on surface/session/adopt changes. */
export function registerVoiceComposer(ownerId: string, info: VoiceComposerInfo): void {
  composersByOwner.set(ownerId, info);
}

/** Called by useVoiceRecorder on unmount — ownership is released separately. */
export function unregisterVoiceComposer(ownerId: string): void {
  composersByOwner.delete(ownerId);
}

/**
 * The surface the given owner token is mounted in, or null when there is no
 * such owner (no live owner, or one whose composer already unmounted).
 */
export function voiceComposerSurfaceOf(ownerId: string | null): string | null {
  if (ownerId === null) return null;
  return composersByOwner.get(ownerId)?.surfaceId ?? null;
}

/**
 * Whether a composer on `surfaceId` displays `sessionId` and may adopt an
 * orphaned recording for it. Approximates "this surface WILL show the
 * recording": the hook re-attempts adoption whenever ownership frees up, so
 * an allowed same-session composer picks the recording up.
 */
export function hasAdoptableComposerOnSurface(surfaceId: string, sessionId: string): boolean {
  for (const info of composersByOwner.values()) {
    if (info.surfaceId === surfaceId && info.sessionId === sessionId && info.canAdopt) {
      return true;
    }
  }
  return false;
}
