import { useState, useCallback, useEffect } from 'preact/hooks';
import type {
  PendingUserQuestion,
  QuestionCancelReason,
  QuestionDraftResponse,
} from '@hyperneo/shared';
import { useMessageHub } from '../hooks/useMessageHub.ts';
import { Button } from './ui/Button.tsx';
import { cn } from '../lib/utils.ts';

const questionColors = {
  active: {
    bg: 'bg-cat-rose/30',
    border: 'border-cat-rose/40',
    text: 'text-cat-rose',
    iconColor: 'text-rose-400',
    selectedBg: 'bg-cat-rose/15 border-cat-rose/60 text-cat-rose',
    unselectedBg: 'bg-surface-raised/60',
    unselectedText: 'text-fg-soft',
  },
  submitted: {
    bg: 'bg-green-950/20',
    border: 'border-success/40',
    text: 'text-success-soft',
    iconColor: 'text-success',
  },
  cancelled: {
    bg: 'bg-surface/30',
    border: 'border-line-strong',
    text: 'text-fg-muted',
    iconColor: 'text-fg-muted',
  },
};

export type ResolvedState = 'submitted' | 'cancelled' | null;

interface QuestionPromptProps {
  sessionId: string;
  pendingQuestion: PendingUserQuestion;
  resolvedState?: ResolvedState;
  finalResponses?: QuestionDraftResponse[];
  cancelReason?: QuestionCancelReason;
  onResolved?: (state: 'submitted' | 'cancelled', responses: QuestionDraftResponse[]) => void;
}

export function QuestionPrompt({
  sessionId,
  pendingQuestion,
  resolvedState = null,
  finalResponses,
  cancelReason,
  onResolved,
}: QuestionPromptProps) {
  const { questions, toolUseId, draftResponses } = pendingQuestion;
  const { callIfConnected } = useMessageHub();
  const isResolved = resolvedState !== null;

  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => {
    const source = finalResponses || draftResponses;
    const map = new Map<number, Set<string>>();
    if (source) {
      for (const response of source) {
        map.set(response.questionIndex, new Set(response.selectedLabels));
      }
    }
    return map;
  });

  const [customInputs, setCustomInputs] = useState<Map<number, string>>(() => {
    const source = finalResponses || draftResponses;
    const map = new Map<number, string>();
    if (source) {
      for (const response of source) {
        if (response.customText) {
          map.set(response.questionIndex, response.customText);
        }
      }
    }
    return map;
  });

  const [showOther, setShowOther] = useState<Set<number>>(() => {
    const source = finalResponses || draftResponses;
    const set = new Set<number>();
    if (source) {
      for (const response of source) {
        if (response.customText) {
          set.add(response.questionIndex);
        }
      }
    }
    return set;
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const saveDraft = useCallback(async () => {
    const responses: QuestionDraftResponse[] = [];
    for (let i = 0; i < questions.length; i++) {
      const selectedLabels = [...(selections.get(i) || [])];
      const customText = customInputs.get(i);
      if (selectedLabels.length > 0 || customText) {
        responses.push({
          questionIndex: i,
          selectedLabels,
          customText,
        });
      }
    }

    try {
      await callIfConnected('question.saveDraft', {
        sessionId,
        draftResponses: responses,
      });
    } catch {}
  }, [sessionId, questions.length, selections, customInputs, callIfConnected]);

  useEffect(() => {
    if (isResolved) return;

    const timeout = setTimeout(() => {
      saveDraft();
    }, 500);
    return () => clearTimeout(timeout);
  }, [saveDraft, isResolved]);

  const handleOptionClick = (questionIndex: number, label: string) => {
    const question = questions[questionIndex];
    const current = new Set(selections.get(questionIndex) || []);

    if (question.multiSelect) {
      if (current.has(label)) {
        current.delete(label);
      } else {
        current.add(label);
      }
    } else {
      current.clear();
      current.add(label);
    }

    setSelections(new Map(selections.set(questionIndex, current)));

    if (!question.multiSelect) {
      setShowOther((prev) => {
        const next = new Set(prev);
        next.delete(questionIndex);
        return next;
      });
      setCustomInputs((prev) => {
        const next = new Map(prev);
        next.delete(questionIndex);
        return next;
      });
    }
  };

  const handleOtherClick = (questionIndex: number) => {
    const question = questions[questionIndex];

    setShowOther((prev) => new Set([...prev, questionIndex]));

    if (!question.multiSelect) {
      setSelections((prev) => {
        const next = new Map(prev);
        next.get(questionIndex)?.clear();
        return next;
      });
    }
  };

  const handleCustomInput = (questionIndex: number, text: string) => {
    setCustomInputs((prev) => new Map(prev.set(questionIndex, text)));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);

    try {
      const responses: QuestionDraftResponse[] = questions
        .map((_, index) => ({
          questionIndex: index,
          selectedLabels: [...(selections.get(index) || [])],
          customText: customInputs.get(index),
        }))
        .filter((r) => r.selectedLabels.length > 0 || r.customText);

      await callIfConnected('question.respond', {
        sessionId,
        toolUseId,
        responses,
      });

      onResolved?.('submitted', responses);
    } catch {
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);

    try {
      await callIfConnected('question.cancel', {
        sessionId,
        toolUseId,
      });

      onResolved?.('cancelled', []);
    } catch {
    } finally {
      setIsCancelling(false);
    }
  };

  const isValid = questions.every((_, index) => {
    const hasSelection = (selections.get(index)?.size || 0) > 0;
    const hasCustom = !!customInputs.get(index);
    return hasSelection || hasCustom;
  });

  const getContainerClasses = () => {
    if (resolvedState === 'submitted') {
      return cn(
        'rounded-lg border overflow-hidden my-4',
        questionColors.submitted.bg,
        questionColors.submitted.border,
        'opacity-80'
      );
    }
    if (resolvedState === 'cancelled') {
      return cn(
        'rounded-lg border overflow-hidden my-4',
        questionColors.cancelled.bg,
        questionColors.cancelled.border,
        'opacity-60'
      );
    }
    return cn(
      'rounded-lg border overflow-hidden my-4',
      questionColors.active.bg,
      questionColors.active.border
    );
  };

  const getHeaderIcon = () => {
    if (resolvedState === 'submitted') {
      return (
        <svg
          class={cn('w-4 h-4 flex-shrink-0', questionColors.submitted.iconColor)}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    }
    if (resolvedState === 'cancelled') {
      return (
        <svg
          class={cn('w-4 h-4 flex-shrink-0', questionColors.cancelled.iconColor)}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      );
    }
    return (
      <svg
        class={cn('w-4 h-4 flex-shrink-0', questionColors.active.iconColor)}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    );
  };

  const getHeaderTitle = () => {
    if (resolvedState === 'submitted') return 'Response submitted';
    if (resolvedState === 'cancelled') {
      if (cancelReason === 'agent_session_terminated') {
        return 'Question cancelled — agent session ended';
      }
      return 'Question skipped';
    }
    return 'Claude needs your input';
  };

  const getHeaderTextColor = () => {
    if (resolvedState === 'submitted') return questionColors.submitted.text;
    if (resolvedState === 'cancelled') return questionColors.cancelled.text;
    return questionColors.active.text;
  };

  return (
    <div class={getContainerClasses()} data-testid="question-prompt">
      <div class="flex items-center gap-2 min-w-0 flex-1 p-3">
        {getHeaderIcon()}
        <span class={cn('font-semibold text-sm flex-shrink-0', getHeaderTextColor())}>
          {getHeaderTitle()}
        </span>
        {!isResolved && questions.length > 0 && (
          <span class={cn('text-xs text-fg-faint truncate')}>
            {questions.length} question{questions.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div class="p-4 border-t bg-surface space-y-4 border-cat-rose/40">
        {questions.map((question, qIndex) => (
          <div key={qIndex} class={cn('space-y-3', qIndex > 0 && 'pt-4 border-t border-line')}>
            <div class="flex items-start gap-2">
              <span
                class={cn(
                  'inline-block px-2 py-0.5 text-xs rounded flex-shrink-0',
                  resolvedState === 'cancelled'
                    ? 'bg-surface-raised/50 text-fg-faint border border-line'
                    : cn('bg-cat-rose/15 text-cat-rose border', questionColors.active.border)
                )}
              >
                {question.header}
              </span>
              <div class="flex items-center gap-2">
                <span
                  class={cn(
                    'text-sm text-fg-soft',
                    resolvedState === 'cancelled' && 'text-fg-faint'
                  )}
                >
                  {question.question}
                </span>
                {question.multiSelect && !isResolved && (
                  <span
                    class={cn(
                      'inline-flex items-center px-1.5 py-0.5 text-xs rounded',
                      'bg-cat-rose/15 text-cat-rose border border-cat-rose/40'
                    )}
                  >
                    <svg class="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                      />
                    </svg>
                    Multi-select
                  </span>
                )}
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(question.options || []).map((option) => {
                const isSelected = selections.get(qIndex)?.has(option.label);
                return (
                  <button
                    key={option.label}
                    onClick={() => handleOptionClick(qIndex, option.label)}
                    disabled={isResolved}
                    class={cn(
                      'p-3 rounded-lg border transition-all text-left relative',
                      !isResolved && 'hover:scale-[1.01] active:scale-[0.99]',
                      isResolved && 'cursor-default',
                      isSelected
                        ? resolvedState === 'cancelled'
                          ? 'bg-surface-raised/40 border-line-strong text-fg-muted'
                          : questionColors.active.selectedBg
                        : cn(
                            questionColors.active.unselectedBg,
                            resolvedState === 'cancelled'
                              ? 'text-fg-faint'
                              : questionColors.active.unselectedText,
                            'border-line-strong',
                            !isResolved && 'hover:border-rose-600/50'
                          )
                    )}
                    title={option.description}
                  >
                    {question.multiSelect && (
                      <div
                        class={cn(
                          'absolute top-2 right-2 w-4 h-4 rounded border flex items-center justify-center',
                          isSelected ? 'bg-rose-500 border-rose-500' : 'border-fg-faint'
                        )}
                      >
                        {isSelected && (
                          <svg
                            class="w-3 h-3 text-accent-fg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={3}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </div>
                    )}
                    {!question.multiSelect && (
                      <div
                        class={cn(
                          'absolute top-2 right-2 w-4 h-4 rounded-full border flex items-center justify-center',
                          isSelected ? 'border-rose-500' : 'border-fg-faint'
                        )}
                      >
                        {isSelected && <div class="w-2 h-2 rounded-full bg-rose-500" />}
                      </div>
                    )}
                    <div class="pr-6">
                      <div class="font-medium text-sm">{option.label}</div>
                      <div
                        class={cn(
                          'text-xs mt-0.5',
                          resolvedState === 'cancelled' ? 'text-gray-700' : 'text-fg-faint'
                        )}
                      >
                        {option.description}
                      </div>
                    </div>
                  </button>
                );
              })}

              {!(resolvedState === 'cancelled' && !showOther.has(qIndex)) && (
                <button
                  onClick={() => handleOtherClick(qIndex)}
                  disabled={isResolved}
                  class={cn(
                    'p-3 rounded-lg border transition-all text-left relative',
                    !isResolved && 'hover:scale-[1.01] active:scale-[0.99]',
                    isResolved && 'cursor-default',
                    showOther.has(qIndex)
                      ? resolvedState === 'cancelled'
                        ? 'bg-surface-raised/40 border-line-strong text-fg-muted'
                        : questionColors.active.selectedBg
                      : cn(
                          questionColors.active.unselectedBg,
                          'text-fg-muted',
                          'border-line-strong',
                          !isResolved && 'hover:border-rose-600/50'
                        )
                  )}
                >
                  <div
                    class={cn(
                      'absolute top-2 right-2 w-4 h-4 rounded-full border flex items-center justify-center',
                      showOther.has(qIndex) ? 'border-rose-500' : 'border-fg-faint'
                    )}
                  >
                    {showOther.has(qIndex) && <div class="w-2 h-2 rounded-full bg-rose-500" />}
                  </div>
                  <div class="pr-6">
                    <div class="font-medium text-sm">Other...</div>
                    <div
                      class={cn(
                        'text-xs mt-0.5',
                        resolvedState === 'cancelled' ? 'text-gray-700' : 'text-fg-faint'
                      )}
                    >
                      Enter custom answer
                    </div>
                  </div>
                </button>
              )}
            </div>

            {showOther.has(qIndex) && (
              <textarea
                placeholder="Enter your response..."
                value={customInputs.get(qIndex) || ''}
                onInput={(e) => handleCustomInput(qIndex, (e.target as HTMLTextAreaElement).value)}
                disabled={isResolved}
                rows={3}
                class={cn(
                  'w-full px-3 py-2 rounded-lg border resize-y min-h-[80px] max-h-[200px]',
                  'bg-surface-raised/80 placeholder-gray-500',
                  isResolved ? 'text-fg-muted cursor-default' : 'text-fg',
                  'focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500/50',
                  'border-line-strong'
                )}
              />
            )}
          </div>
        ))}

        {!isResolved && (
          <div class="flex items-center gap-3 pt-4 border-t border-line">
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!isValid || isSubmitting || isCancelling}
              loading={isSubmitting}
              class="bg-rose-600 hover:bg-rose-700"
            >
              Submit Response
            </Button>
            <Button
              variant="ghost"
              onClick={handleCancel}
              disabled={isSubmitting || isCancelling}
              loading={isCancelling}
            >
              Skip Question
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
