import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NeoResult, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { SessionStore } from '../lib/session-store.ts';
import { createNeoIntakeClient, type NeoPendingAsk } from './neo-intake.ts';
import { readNeoConversationAsks } from './conversation-ask-client.ts';
import { useNeoConversationAsks } from './useNeoConversationAsks.ts';
import type { DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import { projectNeoConcernBoard } from './neo-concern-board.ts';
import { readNeoPublications } from './publication-client.ts';
import { useNeoPublications } from './useNeoPublications.ts';
import { projectNeoPublicConversation } from './public-conversation.ts';
import { projectNeoPublicHolderConversation } from './public-holder-conversation.ts';

export function useNeo() {
  const store = useMemo(() => new SessionStore(), []);
  const [pendingAsks, setPendingAsks] = useState<readonly NeoPendingAsk[]>([]);
  const intake = useMemo(
    () => createNeoIntakeClient(() => connectionManager.getHub(), setPendingAsks),
    []
  );
  const [snapshot, setSnapshot] = useState<NeoSnapshot | null>(null);
  const publications = useNeoPublications(snapshot?.sessionId ?? null);
  const asks = useNeoConversationAsks(snapshot?.sessionId ?? null);
  useEffect(() => {
    intake.settle(new Set(asks.items.map((ask) => ask.requestId)));
  }, [asks.items, intake]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busyWork, setBusyWork] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const refreshGeneration = useRef(0);
  const alive = useRef(true);

  async function refresh() {
    const ticket = ++refreshGeneration.current;
    const current = () => alive.current && ticket === refreshGeneration.current;
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<NeoSnapshot>>(hub, 'neo.snapshot', {});
      if (!current()) return;
      if (!result.ok) throw new Error(result.reason);
      setSnapshot(result);
    } catch (cause) {
      if (current()) throw cause;
    }
  }

  async function open() {
    const ticket = ++generation.current;
    ++refreshGeneration.current;
    setSessionId(null);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<NeoSnapshot>>(hub, 'neo.open', {});
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
        void open();
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
      const result = await invokeOperation<NeoResult<{ ok: true }>>(
        hub,
        ({ start: 'neo.work.start', cancel: 'neo.work.cancel' } as const)[action],
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

  const publicConversation = projectNeoPublicConversation(
    snapshot?.sessionId ?? null,
    asks,
    publications
  );
  return {
    publicConversation,
    viewPublicConversation: projectNeoPublicHolderConversation(
      publicConversation,
      snapshot,
      sessionId
    ),
    publications,
    asks,
    readPublications: readNeoPublications,
    readAsks: readNeoConversationAsks,
    store,
    snapshot,
    projectBoard: (inventory: DaemonSnapshot | null) =>
      projectNeoConcernBoard(snapshot, null, inventory),
    sessionId,
    error,
    setError,
    busyWork,
    open,
    act,
    send: intake.send,
    pendingAsks: pendingAsks.filter((ask) => ask.sessionId === sessionId),
    retrySend: intake.retry,
    discardSend: intake.discard,
    sendRequestId: intake.requestIdFor,
    retry: () => setAttempt((value) => value + 1),
  };
}
