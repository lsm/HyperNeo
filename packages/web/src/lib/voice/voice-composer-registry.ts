/**
 * Registry of mounted voice composers, keyed by owner token.
 *
 * The recorder store identifies a recording's owner by its composer's opaque
 * owner token (see useVoiceRecorder); the global "recording elsewhere" chip
 * needs one more fact the store cannot know — WHICH rendering surface that
 * owner is mounted in. Two surfaces can display the SAME session at once (a
 * Space task pane and the agent overlay opened over it), so session equality
 * alone cannot tell whether the recording's waveform is visible where the
 * user is looking. Each mounted composer registers its surface here (via the
 * VoiceSurfaceContext its surface provides), and the indicator hides the chip
 * only when the owning composer belongs to the surface the chip is rendered
 * in.
 *
 * Plain Map, not signals: ownership transitions (the only moments visibility
 * can change) already flow through `recordingOwnerId`, whose signal
 * re-renders every observer and re-reads this map after each registration.
 */

const surfacesByOwner = new Map<string, string>();

/** Called by useVoiceRecorder on mount (and surface change). */
export function registerVoiceComposer(ownerId: string, surfaceId: string): void {
  surfacesByOwner.set(ownerId, surfaceId);
}

/** Called by useVoiceRecorder on unmount — ownership is released separately. */
export function unregisterVoiceComposer(ownerId: string): void {
  surfacesByOwner.delete(ownerId);
}

/**
 * The surface the given owner token is mounted in, or null when there is no
 * such owner (no live owner, or one whose composer already unmounted).
 */
export function voiceComposerSurfaceOf(ownerId: string | null): string | null {
  if (ownerId === null) return null;
  return surfacesByOwner.get(ownerId) ?? null;
}
