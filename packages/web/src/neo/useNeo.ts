import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NeoResult, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { SessionStore } from '../lib/session-store.ts';

export function useNeo() {
  const store = useMemo(() => new SessionStore(), []);
  const [snapshot, setSnapshot] = useState<NeoSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busyWork, setBusyWork] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const refreshGeneration = useRef(0);
  const alive = useRef(true);

  async function refresh() {
    const ticket = ++refreshGeneration.current;
    const hub = await connectionManager.getHub();
    const result = await invokeOperation<NeoResult<NeoSnapshot>>(hub, 'neo.snapshot', {});
    if (!result.ok) throw new Error(result.reason);
    if (alive.current && ticket === refreshGeneration.current) setSnapshot(result);
  }

  async function open(id: string | null) {
    const ticket = ++generation.current;
    setSelectedId(id);
    setSessionId(null);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<NeoSnapshot>>(
        hub,
        'neo.open',
        id ? { concernId: id } : {}
      );
      if (!result.ok) throw new Error(result.reason);
      if (!alive.current || ticket !== generation.current) return;
      await store.select(result.sessionId);
      if (!alive.current || ticket !== generation.current) return;
      setSessionId(result.sessionId);
      await refresh();
    } catch (cause) {
      if (alive.current && ticket === generation.current)
        setError(cause instanceof Error ? cause.message : 'Could not open Neo.');
    }
  }

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let unsubscribe = () => {};
    let reconnect = () => {};
    void connectionManager
      .getHub()
      .then((hub) => {
        if (disposed) return;
        const update = () =>
          void refresh().catch((cause) => {
            if (!disposed)
              setError(cause instanceof Error ? cause.message : 'Could not refresh Neo.');
          });
        unsubscribe = hub.onEvent('neo.changed', update);
        reconnect = hub.onConnection((state) => {
          if (state === 'connected') update();
        });
        void open(null);
      })
      .catch((cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : 'Cannot connect to HyperNeo.');
      });
    return () => {
      disposed = true;
      unsubscribe();
      reconnect();
    };
  }, [attempt]);

  useEffect(
    () => () => {
      alive.current = false;
      generation.current++;
      void store.destroy();
    },
    [store]
  );

  async function act(id: string, action: 'start' | 'cancel') {
    if (busyWork) return;
    setBusyWork(id);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<{ ok: true; work: NeoWork }>>(
        hub,
        action === 'start' ? 'neo.work.start' : 'neo.work.cancel',
        { id }
      );
      if (!result.ok) throw new Error(result.reason);
      await refresh();
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'That action could not be completed.');
    } finally {
      if (alive.current) setBusyWork(null);
    }
  }

  return {
    store,
    snapshot,
    selectedId,
    sessionId,
    error,
    setError,
    busyWork,
    open,
    act,
    retry: () => setAttempt((value) => value + 1),
  };
}
