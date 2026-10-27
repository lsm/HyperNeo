import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { createNeoWorkSearch } from './neo-work-search.ts';

export function useNeoWorkSearch(
  entries: readonly NeoAskEntry[],
  query: string,
  read: (id: string) => Promise<NeoAskEntry>
) {
  const active = !!query.trim();
  const [index, setIndex] = useState<{
    source: typeof entries;
    full: NeoAskEntry[];
    failed: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setIndex(null);
      return;
    }
    let current = true;
    void Promise.all(entries.map((entry) => (entry.summary ? read(entry.ask.id) : entry))).then(
      (full) => {
        if (current) setIndex({ source: entries, full, failed: false });
      },
      () => {
        if (current) setIndex({ source: entries, full: [], failed: true });
      }
    );
    return () => {
      current = false;
    };
  }, [entries, active, read]);
  const search = useMemo(() => createNeoWorkSearch(index?.full ?? []), [index]);
  const ready = active && index?.source === entries;
  return {
    results: ready ? search(query) : [],
    pending: active && !ready,
    failed: ready && index.failed,
  };
}
