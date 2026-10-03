import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { Button } from '../components/ui/Button.tsx';
import { connectionState } from '../lib/state.ts';
import type { QuestionFormDraft } from '../components/question-form-draft.ts';
import type { useNeoWorkQuestionObserver } from './useNeoWorkQuestionObserver.ts';

export function NeoWorkQuestionControls({
  work,
  observation,
}: {
  work: NeoWork;
  observation: ReturnType<typeof useNeoWorkQuestionObserver>;
  formDraft?: { value: QuestionFormDraft; onChange: (draft: QuestionFormDraft) => void };
}) {
  const { store, question, loadError } = observation;
  const errorMessage = store.error.value?.message ?? loadError;
  return (
    <>
      {question && work.sessionId && (
        <a
          href={`/session/${encodeURIComponent(work.sessionId)}`}
          target="_blank"
          rel="noreferrer"
          class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-fg hover:border-accent/60"
        >
          <span>Waiting for your answer</span>
          <span class="text-accent">Answer in chat ↗</span>
        </a>
      )}
      {errorMessage && (
        <div role="alert" class="mt-3 text-sm text-danger">
          <p>{errorMessage}</p>
          {(loadError || store.loadErrorKind.value) && work.status === 'queued' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={connectionState.value !== 'connected'}
              onClick={observation.retry}
            >
              Check questions again
            </Button>
          )}
        </div>
      )}
    </>
  );
}
