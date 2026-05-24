import { useCallback, useState } from 'preact/hooks';

/**
 * A hook for managing bitwise flags.
 *
 * This is useful for tracking multiple boolean states in a single number,
 * which is more efficient than multiple useState calls.
 *
 * @param initialFlags - The initial flags value (default: 0)
 * @returns An object with flag manipulation methods
 *
 * @example
 * ```tsx
 * enum States {
 *   Open = 1 << 0,
 *   Active = 1 << 1,
 *   Visible = 1 << 2,
 * }
 *
 * const { flags, addFlag, removeFlag, hasFlag } = useFlags(States.Open);
 * addFlag(States.Active);
 * if (hasFlag(States.Visible)) { ... }
 * ```
 */
export function useFlags(initialFlags = 0) {
  const [flags, setFlags] = useState(initialFlags);

  const setFlag = useCallback((flag: number) => setFlags(flag), []);
  const addFlag = useCallback((flag: number) => setFlags((flags) => flags | flag), []);
  const hasFlag = useCallback((flag: number) => (flags & flag) === flag, [flags]);
  const removeFlag = useCallback((flag: number) => setFlags((flags) => flags & ~flag), []);
  const toggleFlag = useCallback((flag: number) => setFlags((flags) => flags ^ flag), []);

  return { flags, setFlag, addFlag, hasFlag, removeFlag, toggleFlag };
}
