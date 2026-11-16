import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  NeoResult,
  NeoSnapshot,
  NeoWorkingEvent,
  NeoWorkingSession,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoQuestionAnswer, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import type { OperationName } from '@hyperneo/shared/types/operation-names';
import { type NeoTodoControl, neoTodoControlCall } from './todo-controls.ts';
import { SessionStore } from '../lib/session-store.ts';
import { createNeoIntakeClient, type NeoPendingAsk } from './neo-intake.ts';
import { readNeoConversationAsks } from './conversation-ask-client.ts';
import { useNeoConversationAsks } from './useNeoConversationAsks.ts';
import { readNeoPublications } from './publication-client.ts';
import { useNeoPublications } from './useNeoPublications.ts';
import { projectNeoPublicConversation } from './public-conversation.ts';
import { projectNeoPublicHolderConversation } from './public-holder-conversation.ts';

export function useNeo() {
  const store = useMemo(() => new SessionStore({ transcript: false }), []);
  const [pendingAsks, setPendingAsks] = useState<readonly NeoPendingAsk[]>([]);
  const intake = useMemo(
    () => createNeoIntakeClient(() => connectionManager.getHub(), setPendingAsks),
    []
  );
  const [received, setSnapshot] = useState<NeoSnapshot | null>(null);
  const [working, setWorking] = useState<NeoWorkingSession[] | null>(null);
  const snapshot = useMemo(
    () => (received && working ? { ...received, working } : received),
    [received, working]
  );
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
    const opened = ++refreshGeneration.current;
    setSessionId(null);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<NeoSnapshot>>(hub, 'neo.open', {});
      if (!result.ok) throw new Error(result.reason);
      if (!alive.current || ticket !== generation.current) return;
      if (opened === refreshGeneration.current) setSnapshot(result);
      await store.select(result.sessionId);
      if (!alive.current || ticket !== generation.current) return;
      setSessionId(result.sessionId);
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
        const offChanged = hub.onEvent('neo.changed', update);
        const offNotices = hub.onEvent('neo.session.notices', update);
        const offWorking = hub.onEvent<NeoWorkingEvent>('neo.working', (event) => {
          if (event?.working) setWorking(event.working);
        });
        unsubscribe = () => {
          offChanged();
          offNotices();
          offWorking();
        };
        reconnect = hub.onConnection((state) => {
          if (state !== 'connected') return;
          setWorking(null);
          update();
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

  async function settleAsk(askId: string, status: 'done' | 'dropped') {
    if (busyWork) return;
    setBusyWork(askId);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<{ ok: true }>>(hub, 'neo.ask.settle', {
        askId,
        status,
        outcome: status === 'done' ? 'Closed by the user.' : 'Dropped by the user.',
      });
      if (!result.ok) throw new Error(result.reason);
      await refresh();
    } finally {
      if (alive.current) setBusyWork(null);
    }
  }

  async function controlTodo(todo: Pick<NeoTodo, 'id' | 'startedAt'>, control: NeoTodoControl) {
    setError('');
    const hub = await connectionManager.getHub();
    const call = neoTodoControlCall(todo, control);
    const result = await invokeOperation<NeoResult<{ ok: true }>>(hub, call.name, call.input);
    if (!result.ok) throw new Error(result.reason);
    await refresh();
  }

  async function setDesktopControl(todoId: string, on: boolean) {
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<{ accepted: boolean; reason?: string }>(
        hub,
        'desktop.control.set',
        { todoId, on }
      );
      if (!result.accepted) throw new Error(result.reason);
      await refresh();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function muteSession(key: string, muted: boolean) {
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<{ ok: true }>>(hub, 'neo.session.mute', {
        key,
        muted,
      });
      if (!result.ok) throw new Error(result.reason);
      await refresh();
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'That session could not be muted.');
    }
  }

  async function answerQuestion(questionId: string, answer: NeoQuestionAnswer) {
    await questionCall(questionId, 'neo.question.answer', { questionId, answer });
  }

  async function holdQuestion(questionId: string, held: boolean) {
    const requestId = crypto.randomUUID();
    await questionCall(questionId, 'neo.question.hold', { questionId, held, requestId });
  }

  async function questionCall(questionId: string, operation: OperationName, input: object) {
    if (busyWork) return;
    setBusyWork(questionId);
    setError('');
    try {
      const hub = await connectionManager.getHub();
      const result = await invokeOperation<NeoResult<{ ok: true }>>(hub, operation, input);
      if (!result.ok) throw new Error(result.reason);
      await refresh();
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'That answer could not be sent.');
    } finally {
      if (alive.current) setBusyWork(null);
    }
  }

  const publicConversation = projectNeoPublicConversation(
    snapshot?.sessionId ?? null,
    asks,
    publications,
    snapshot?.sessionNoticeGroups,
    snapshot?.sessionMessages,
    snapshot?.wakes
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
    sessionId,
    error,
    setError,
    busyWork,
    open,
    refresh,
    settleAsk,
    controlTodo,
    setDesktopControl,
    muteSession,
    answerQuestion,
    holdQuestion,
    send: intake.send,
    pendingAsks: pendingAsks.filter((ask) => ask.sessionId === sessionId),
    retrySend: intake.retry,
    discardSend: intake.discard,
    sendRequestId: intake.requestIdFor,
    retry: () => setAttempt((value) => value + 1),
  };
}
