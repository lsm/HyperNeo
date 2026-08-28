let mutationQueue: Promise<unknown> = Promise.resolve();

export function withProviderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}
