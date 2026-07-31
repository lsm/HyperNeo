/**
 * Serializes voice-credential state read/write across handlers.
 *
 * A key/endpoint replacement updates two stores non-atomically: the settings
 * row (endpoint scope) and the credential store (the secret). Without
 * serialization, an in-flight `voice.transcribe` can observe a half-applied
 * mutation — e.g. the new endpoint scope already persisted while the previous
 * provider's key is still the one in the store — and send that old credential
 * to the newly configured server. Both the settings mutation (persist + store)
 * and the transcription credential read (scope + key) acquire this lock so they
 * never overlap.
 */
let voiceCredentialChain: Promise<unknown> = Promise.resolve();

export function withVoiceCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = voiceCredentialChain.then(fn, fn);
  // Swallow errors on the chain tail so one failure does not poison subsequent
  // mutations; the caller still receives the original rejection via `run`.
  voiceCredentialChain = run.catch(() => {});
  return run;
}
