let voiceCredentialChain: Promise<unknown> = Promise.resolve();

export function withVoiceCredentialLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      })
    : null;
  const result = abortPromise ? Promise.race([run, abortPromise]) : run;
  voiceCredentialChain = run.catch(() => {});
  return result;
}
