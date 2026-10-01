import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PendingUserQuestion } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  createQuestionFormDraft,
  type QuestionFormDraft,
} from '../components/question-form-draft.ts';
import { useNeoWorkQuestionObserver } from './useNeoWorkQuestionObserver.ts';
import { NeoWorkQuestionControls } from './NeoWorkQuestionControls.tsx';

export function NeoWorkQuestionResource({
  work,
  target,
  onQuestion,
  onUnavailable,
}: {
  work: NeoWork;
  target?: HTMLElement | null;
  onQuestion?: (workId: string, question: PendingUserQuestion | null) => void;
  onUnavailable?: (workId: string, unavailable: boolean) => void;
}) {
  const observation = useNeoWorkQuestionObserver(work);
  const questionListener = useRef(onQuestion);
  questionListener.current = onQuestion;
  const unavailableListener = useRef(onUnavailable);
  unavailableListener.current = onUnavailable;
  const unavailable =
    !!onUnavailable && (!!observation.loadError || !!observation.store.loadErrorKind.value);
  const { question } = observation;
  const initialDraft = useMemo(
    () =>
      question
        ? createQuestionFormDraft(work.sessionId!, question.toolUseId, question.draftResponses)
        : null,
    [work.sessionId, question?.toolUseId]
  );
  const [draft, setDraft] = useState<QuestionFormDraft | null>(null);
  const currentDraft =
    draft?.sessionId === work.sessionId && draft?.toolUseId === question?.toolUseId
      ? draft
      : initialDraft;
  useEffect(() => {
    onQuestion?.(work.id, question);
  }, [work.id, question, onQuestion]);
  useEffect(() => () => questionListener.current?.(work.id, null), [work.id]);
  useEffect(() => {
    onUnavailable?.(work.id, unavailable);
  }, [work.id, unavailable, onUnavailable]);
  useEffect(() => () => unavailableListener.current?.(work.id, false), [work.id]);
  const controls = (
    <NeoWorkQuestionControls
      work={work}
      observation={observation}
      formDraft={currentDraft ? { value: currentDraft, onChange: setDraft } : undefined}
    />
  );
  return target === undefined ? controls : target ? createPortal(controls, target) : null;
}
