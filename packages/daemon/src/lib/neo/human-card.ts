import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
} from '../../storage/repositories/neo-ask-todo-repository.ts';

export function openHumanCard(
  store: NeoAskTodoRepository,
  id: string,
  askId: string,
  draft: NeoQuestionDraft,
  now: number
): NeoQuestion {
  return store.askQuestion(id, askId, draft, now);
}

export function replaceHumanCard(
  store: NeoAskTodoRepository,
  replaced: NeoQuestion,
  id: string,
  draft: NeoQuestionDraft,
  now: number
): NeoQuestion | null {
  return store.replaceQuestion(replaced, id, draft, now);
}
