import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createNeoWorkSearch } from './neo-work-search.ts';

export function useNeoWorkSearch(
  entries: readonly NeoAskEntry[],
  query: string,
  read: (id: string) => Promise<NeoAskEntry>,
  find: (
    query: string,
    cursor?: string
  ) => Promise<{ results: readonly { askId: string }[]; nextCursor: string | null }>
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
  const cache = useRef(new Map<string, NeoAskEntry>()).current;
  const slots = useRef(Array.from({ length: 4 }, () => Promise.resolve())).current;
  const slotIndex = useRef(0);
  const visibleIds = useRef(visible);
  visibleIds.current = visible;
  const [request, setRequest] = useState<{ query: string; cursor: string } | null>(null);
  useLayoutEffect(() => setRequest(null), [query]);
  const cursor = request?.query === query ? request.cursor : undefined;
  const [remote, setRemote] = useState<{
    query: string;
    entries: NeoAskEntry[];
    nextCursor: string | null;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      cache.clear();
      setRemote(null);
      setRequest(null);
      return;
    }
    let current = true;
    setRemote((previous) => ({
      query,
      entries: previous?.query === query ? previous.entries : [],
      nextCursor: null,
      pending: true,
      failed: false,
    }));
    const timer = setTimeout(() => {
      void find(query.trim(), cursor)
        .then(async (page) => {
          const entries = await Promise.all(
            [...new Set(page.results.map((hit) => hit.askId))]
              .filter((id) => !visibleIds.current.has(id))
              .map((id) => {
                const slot = slotIndex.current++ % slots.length;
                const result = slots[slot].then(async () => {
                  if (!current) return null;
                  const entry = cache.get(id) ?? (await read(id));
                  if (current) cache.set(id, entry);
                  return entry;
                });
                slots[slot] = result.then(
                  () => {},
                  () => {}
                );
                return result;
              })
          );
          if (current)
            setRemote((previous) => ({
              query,
              entries: [
                ...new Map(
                  [
                    ...(previous?.query === query ? previous.entries : []),
                    ...entries.filter((entry) => entry !== null),
                  ].map((entry) => [entry.ask.id, entry])
                ).values(),
              ],
              nextCursor: page.nextCursor,
              pending: false,
              failed: false,
            }));
        })
        .catch(() => {
          if (current)
            setRemote((previous) => ({
              query,
              entries: previous?.query === query ? previous.entries : [],
              nextCursor: null,
              pending: false,
              failed: true,
            }));
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [active, query, cursor, find, read]);
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
  const remoteReady = remote?.query === query;
  const failed = (ready && index.failed) || (remoteReady && remote.failed);
  return {
    results:
      active && index && !index.failed
        ? [
            ...search(query).filter((entry) => visible.has(entry.ask.id)),
            ...(remoteReady ? remote.entries.filter((entry) => !visible.has(entry.ask.id)) : []),
          ]
        : [],
    pending: active && !failed && (!ready || !remoteReady || remote.pending),
    nextCursor: remoteReady ? remote.nextCursor : null,
    loadMore: () => {
      if (remoteReady && remote.nextCursor && !remote.pending)
        setRequest({ query, cursor: remote.nextCursor });
    },
    failed,
  };
}
