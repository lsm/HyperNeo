import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createNeoWorkSearch } from './neo-work-search.ts';

export function useNeoWorkSearch(
  entries: readonly NeoAskEntry[],
  query: string,
  read: (id: string) => Promise<NeoAskEntry>,
  find: (query: string) => Promise<readonly { askId: string }[]>
) {
  const active = !!query.trim();
  const revision = JSON.stringify(entries.map(({ ask }) => [ask.id, ask.updatedAt]));
  const visible = new Set(entries.map((entry) => entry.ask.id));
  const bodies = useRef(
    new Map<string, { revision: number; promise: Promise<NeoAskEntry> }>()
  ).current;
  const [index, setIndex] = useState<{
    revision: string;
    full: NeoAskEntry[];
    failed: boolean;
  } | null>(null);
  const [remote, setRemote] = useState<{
    query: string;
    revision: string;
    entries: NeoAskEntry[];
    failed: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setRemote(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void find(query.trim())
        .then((hits) =>
          Promise.all(
            [...new Set(hits.map((hit) => hit.askId))].filter((id) => !visible.has(id)).map(read)
          )
        )
        .then(
          (entries) => {
            if (current) setRemote({ query, revision, entries, failed: false });
          },
          () => {
            if (current) setRemote({ query, revision, entries: [], failed: true });
          }
        );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [active, query, revision, find, read]);
  useLayoutEffect(() => {
    if (!active) {
      bodies.clear();
      setIndex(null);
      return;
    }
    let current = true;
    for (const id of bodies.keys()) if (!visible.has(id)) bodies.delete(id);
    void Promise.all(
      entries.map((entry) => {
        if (!entry.summary) return entry;
        const cached = bodies.get(entry.ask.id);
        if (cached?.revision === entry.ask.updatedAt) return cached.promise;
        const promise: Promise<NeoAskEntry> = read(entry.ask.id).catch((cause) => {
          if (bodies.get(entry.ask.id)?.promise === promise) bodies.delete(entry.ask.id);
          throw cause;
        });
        bodies.set(entry.ask.id, { revision: entry.ask.updatedAt, promise });
        return promise;
      })
    ).then(
      (full) => {
        if (current) setIndex({ revision, full, failed: false });
      },
      () => {
        if (current) setIndex({ revision, full: [], failed: true });
      }
    );
    return () => {
      current = false;
    };
  }, [revision, active, read]);
  const search = useMemo(() => createNeoWorkSearch(index?.full ?? []), [index]);
  const ready = active && index?.revision === revision;
  const remoteReady = remote?.query === query && remote.revision === revision;
  const failed = (ready && index.failed) || (remoteReady && remote.failed);
  return {
    results:
      active && index && !index.failed
        ? [
            ...search(query).filter((entry) => visible.has(entry.ask.id)),
            ...(remoteReady ? remote.entries.filter((entry) => !visible.has(entry.ask.id)) : []),
          ]
        : [],
    pending: active && !failed && (!ready || !remoteReady),
    failed,
  };
}
