/**
 * Polyfill for queueMicrotask.
 *
 * Uses the native queueMicrotask if available, otherwise falls back to
 * Promise.resolve().then() with error handling.
 *
 * @param cb - The callback to execute in the microtask queue
 */
export function microTask(cb: () => void): void {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(cb);
  } else {
    Promise.resolve()
      .then(cb)
      .catch((e) =>
        setTimeout(() => {
          throw e;
        })
      );
  }
}
