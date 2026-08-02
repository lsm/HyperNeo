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

export function withVoiceCredentialLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // Fail fast if the request deadline already elapsed while queued behind
  // other mutations, so the RPC does not outlive its AbortController.
  if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  const run = voiceCredentialChain.then(
    async () => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return fn();
    },
    async () => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return fn();
    }
  );
  // Also abort the wait if the signal fires while queued.
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      })
    : null;
  const result = abortPromise ? Promise.race([run, abortPromise]) : run;
  // Swallow errors on the chain tail so one failure does not poison subsequent
  // mutations; the caller still receives the original rejection via `result`.
  voiceCredentialChain = run.catch(() => {});
  return result;
}
