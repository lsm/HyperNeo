import { useEffect, useMemo, useState } from 'preact/hooks';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { SessionStore } from '../lib/session-store.ts';
import { connectionState } from '../lib/state.ts';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { projectNeoWorkQuestion } from './work-question.ts';

export function NeoWorkQuestion({ work }: { work: NeoWork }) {
  const store = useMemo(() => new SessionStore(), [work.sessionId]);
  const [error, setError] = useState('');
  const connected = connectionState.value === 'connected';
  useEffect(() => {
    let alive = true;
    setError('');
    void store.select(work.sessionId).catch(() => {
      if (alive) setError('Could not check this agent’s questions.');
    });
    return () => {
      alive = false;
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
  return (
    <>
      {question && (
        <QuestionPrompt
          key={`${work.id}:${question.toolUseId}`}
          pendingHeading="A quick choice"
          sessionId={work.sessionId!}
          pendingQuestion={question}
          onResolved={() => {
            setError('');
            void store.refresh();
          }}
          onError={(cause) =>
            setError(
              cause instanceof Error ? cause.message : 'Could not send your choice. Try again.'
            )
          }
        />
      )}
      {(error || store.error.value) && (
        <p role="alert" class="mt-3 text-sm text-danger">
          {error || 'Could not check this agent’s questions.'}
        </p>
      )}
    </>
  );
}
