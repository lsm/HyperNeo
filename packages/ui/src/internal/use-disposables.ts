import { useEffect, useState } from 'preact/hooks';
import { disposables, type Disposables } from './disposables.ts';

/**
 * The `useDisposables` hook returns a `disposables` object that is disposed
 * when the component is unmounted.
 *
 * This is useful for managing cleanup of event listeners, timers, and other
 * resources that need to be cleaned up when a component unmounts.
 *
 * @returns A disposables object that will be automatically disposed on unmount
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const d = useDisposables();
 *
 *   useEffect(() => {
 *     d.addEventListener(element, 'click', handleClick);
 *     d.setTimeout(() => {}, 1000);
 *     // All disposables are cleaned up when component unmounts
 *   }, []);
 * }
 * ```
 */
export function useDisposables(): Disposables {
  // Using useState instead of useRef so that we can use the initializer function.
  const [d] = useState(disposables);
  useEffect(() => () => d.dispose(), [d]);
  return d;
}
