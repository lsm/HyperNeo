import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useState } from 'preact/hooks';
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
}: {
  work: NeoWork;
  target?: HTMLElement | null;
  onQuestion?: (workId: string, question: PendingUserQuestion | null) => void;
}) {
  const observation = useNeoWorkQuestionObserver(work);
  const { question } = observation;
  const initialDraft = useMemo(
    () =>
      question
        ? createQuestionFormDraft(work.sessionId!, question.toolUseId, question.draftResponses)
        : null,
    [work.sessionId, question?.toolUseId, question?.draftResponses]
  );
  const [draft, setDraft] = useState<QuestionFormDraft | null>(null);
  const currentDraft =
    draft?.sessionId === work.sessionId && draft?.toolUseId === question?.toolUseId
      ? draft
      : initialDraft;
  useEffect(() => {
    onQuestion?.(work.id, question);
  }, [work.id, question, onQuestion]);
  useEffect(() => () => onQuestion?.(work.id, null), [work.id, onQuestion]);
  const controls = (
    <NeoWorkQuestionControls
      work={work}
      observation={observation}
      formDraft={currentDraft ? { value: currentDraft, onChange: setDraft } : undefined}
    />
  );
  return target === undefined ? controls : target ? createPortal(controls, target) : null;
}
