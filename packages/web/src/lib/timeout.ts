/**
 * Timeout Utility
 *
 * Provides utilities for adding timeouts to async operations.
 */

/**
 * Create a deferred promise that can be resolved/rejected externally
 *
 * @returns Object with promise and resolve/reject functions
 *
 * @example
 * ```typescript
 * const { promise, resolve, reject } = createDeferred<string>();
 * // Later...
 * resolve('done');
 * // Or...
 * reject(new Error('failed'));
 * ```
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
