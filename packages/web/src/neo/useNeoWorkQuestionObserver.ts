import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { SessionStore } from '../lib/session-store.ts';
import { connectionState } from '../lib/state.ts';
import { projectNeoWorkQuestion } from './work-question.ts';

export function useNeoWorkQuestionObserver(work: NeoWork) {
  const store = useMemo(() => new SessionStore(), [work.sessionId]);
  const [loadError, setLoadError] = useState('');
  const currentStore = useRef<SessionStore | null>(store);
  currentStore.current = store;
  const connected = connectionState.value === 'connected';
  useEffect(() => {
    let alive = true;
    setLoadError('');
    void store.select(work.sessionId).catch(() => {
      if (alive) setLoadError('Could not check this agent’s questions.');
    });
    return () => {
      alive = false;
      if (currentStore.current === store) currentStore.current = null;
      void store.destroy();
    };
  }, [store, work.sessionId]);
  const source = store.sessionState?.value ?? null;
  const question = projectNeoWorkQuestion(
    work,
    store.activeSessionId.value,
    !!source && connected && !store.isRecovering.value && !store.error.value,
    source
  );
  const retry = () => {
    setLoadError(store.error.value?.message ?? 'Checking this agent’s questions again…');
    void store
      .select(work.sessionId)
      .then(() => {
        if (currentStore.current === store) setLoadError('');
      })
      .catch(() => {
        if (currentStore.current === store) setLoadError('Could not check this agent’s questions.');
      });
  };
  return { store, question, loadError: source && !source.error ? '' : loadError, retry };
}
