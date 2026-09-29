import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { SessionStore } from '../lib/session-store.ts';
import { connectionState } from '../lib/state.ts';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { projectNeoWorkQuestion } from './work-question.ts';

type QuestionEpoch = Readonly<{ store: SessionStore; workId: string; toolUseId: string }>;
type ReplyFailure = { epoch: QuestionEpoch; message: string };

export function NeoWorkQuestion({ work }: { work: NeoWork }) {
  const store = useMemo(() => new SessionStore(), [work.sessionId]);
  const [loadError, setLoadError] = useState('');
  const [replyFailure, setReplyFailure] = useState<ReplyFailure | null>(null);
  const connected = connectionState.value === 'connected';
  useEffect(() => {
    let alive = true;
    setLoadError('');
    void store.select(work.sessionId).catch(() => {
      if (alive) setLoadError('Could not check this agent’s questions.');
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
  const epoch = useMemo(
    () =>
      question ? Object.freeze({ store, workId: work.id, toolUseId: question.toolUseId }) : null,
    [store, work.id, question?.toolUseId]
  );
  const currentEpoch = useRef<QuestionEpoch | null>(epoch);
  currentEpoch.current = epoch;
  useEffect(
    () => () => {
      currentEpoch.current = null;
    },
    []
  );
  const isCurrentEpoch = (candidate: QuestionEpoch) => {
    const state = candidate.store.agentState.value;
    return (
      currentEpoch.current === candidate &&
      state.status === 'waiting_for_input' &&
      state.pendingQuestion.toolUseId === candidate.toolUseId
    );
  };
  const questionError =
    question && epoch && replyFailure?.epoch === epoch ? replyFailure.message : null;
  const errorMessage = store.error.value?.message ?? (loadError || questionError);
  return (
    <>
      {question && epoch && (
        <QuestionPrompt
          key={`${work.sessionId}:${work.id}:${question.toolUseId}`}
          pendingHeading="A quick choice"
          sessionId={work.sessionId!}
          pendingQuestion={question}
          onResolved={() => {
            if (!isCurrentEpoch(epoch)) return;
            setReplyFailure(null);
            void epoch.store.refresh();
          }}
          onError={(cause) => {
            if (!isCurrentEpoch(epoch)) return;
            setReplyFailure({
              epoch,
              message:
                cause instanceof Error ? cause.message : 'Could not send your choice. Try again.',
            });
          }}
        />
      )}
      {errorMessage && (
        <p role="alert" class="mt-3 text-sm text-danger">
          {errorMessage}
        </p>
      )}
    </>
  );
}
