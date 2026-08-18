import { useCallback, useState } from 'preact/hooks';

export function useFlags(initialFlags = 0) {
  const [flags, setFlags] = useState(initialFlags);

  const setFlag = useCallback((flag: number) => setFlags(flag), []);
  const addFlag = useCallback((flag: number) => setFlags((flags) => flags | flag), []);
  const hasFlag = useCallback((flag: number) => (flags & flag) === flag, [flags]);
  const removeFlag = useCallback((flag: number) => setFlags((flags) => flags & ~flag), []);
  const toggleFlag = useCallback((flag: number) => setFlags((flags) => flags ^ flag), []);

  return { flags, setFlag, addFlag, hasFlag, removeFlag, toggleFlag };
}
