import type { QuestionDraftResponse } from '@hyperneo/shared';

export type QuestionFormDraft = {
  sessionId: string;
  toolUseId: string;
  selections: Map<number, Set<string>>;
  customInputs: Map<number, string>;
  showOther: Set<number>;
};

export function createQuestionFormDraft(
  sessionId: string,
  toolUseId: string,
  source?: QuestionDraftResponse[]
): QuestionFormDraft {
  const selections = new Map<number, Set<string>>();
  const customInputs = new Map<number, string>();
  const showOther = new Set<number>();
  for (const response of source ?? []) {
    selections.set(response.questionIndex, new Set(response.selectedLabels));
    if (response.customText) {
      customInputs.set(response.questionIndex, response.customText);
      showOther.add(response.questionIndex);
    }
  }
  return { sessionId, toolUseId, selections, customInputs, showOther };
}
