import { useMemo } from 'preact/hooks';

let idCounter = 0;

export function useId(): string {
  return useMemo(() => `hui-${++idCounter}`, []);
}
