import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NeoResult, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { SessionStore } from '../lib/session-store.ts';
import { createNeoIntakeClient } from './neo-intake.ts';
import type { DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import { projectNeoConcernBoard } from './neo-concern-board.ts';

export function useNeo() {
  const store = useMemo(() => new SessionStore(), []);
  const intake = useMemo(() => createNeoIntakeClient(() => connectionManager.getHub()), []);
  const [snapshot, setSnapshot] = useState<NeoSnapshot | null>(null);
  const [scopedSnapshot, setScopedSnapshot] = useState<NeoSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busyWork, setBusyWork] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const refreshGeneration = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const alive = useRef(true);

  async function refresh() {
    const ticket = ++refreshGeneration.current;
    const concernId = selectedIdRef.current;
    const current = () =>
      alive.current && ticket === refreshGeneration.current && selectedIdRef.current === concernId;
    try {
      const hub = await connectionManager.getHub();
      const [result, scoped] = await Promise.all([
        invokeOperation<NeoResult<NeoSnapshot>>(hub, 'neo.snapshot', {}),
        concernId
          ? invokeOperation<NeoResult<NeoSnapshot>>(hub, 'neo.snapshot', { concernId })
          : Promise.resolve(null),
      ]);
      if (!current()) return;
      if (!result.ok) throw new Error(result.reason);
      if (scoped && !scoped.ok) throw new Error(scoped.reason);
      setSnapshot(result);
      setScopedSnapshot(scoped);
    } catch (cause) {
      if (current()) throw cause;
    }
  }

  async function open(id: string | null) {
    const ticket = ++generation.current;
    ++refreshGeneration.current;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSessionId(null);
    setScopedSnapshot(null);
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

  async function act(id: string, action: 'start' | 'cancel' | 'stop-waiting') {
    if (busyWork) return;
    setBusyWork(id);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<{ ok: true }>>(
        hub,
        (
          {
            start: 'neo.work.start',
            cancel: 'neo.work.cancel',
            'stop-waiting': 'neo.concern.cancel',
          } as const
        )[action],
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
    viewSnapshot: selectedId ? scopedSnapshot : snapshot,
    projectBoard: (inventory: DaemonSnapshot | null) =>
      projectNeoConcernBoard(selectedId ? scopedSnapshot : snapshot, selectedId, inventory),
    selectedId,
    sessionId,
    error,
    setError,
    busyWork,
    open,
    act,
    send: intake.send,
    retry: () => setAttempt((value) => value + 1),
  };
}
