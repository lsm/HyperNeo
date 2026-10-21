import type { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { neoDerivedId } from '../derived-id.ts';

export type HomeConflict = { id: string; text: string; document: string };
export type HomeFailure = {
  ok: false;
  reason: string;
  questionId?: string;
  conflict?: HomeConflict;
};

export function reportHomeConflict<T extends { ok: boolean }>(
  result: T & { conflict?: HomeConflict },
  store: NeoAskTodoRepository,
  sessionId: string | undefined
): T & { questionId?: string } {
  const { conflict, ...receipt } = result;
  if (!conflict || !sessionId) return receipt as T;
  const questionId = neoDerivedId(`home-conflict-question:${conflict.id}`);
  if (!store.getQuestion(questionId)) {
    const askId = neoDerivedId(`home-conflict-ask:${conflict.id}`);
    if (!store.getAsk(askId))
      store.openAsk({
        id: askId,
        projectId: null,
        sessionId,
        originMessageId: null,
        title: 'Resolve Neo home sync conflict',
        request: 'Review both preserved versions before proposing a resolution.',
        createdAt: Date.now(),
      });
    store.askQuestion(
      questionId,
      askId,
      {
        text: conflict.text,
        document: conflict.document,
        kind: 'choice',
        options: ['Keep local', 'Use remote', 'Review together'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      Date.now()
    );
  }
  return { ...receipt, questionId } as T & { questionId: string };
}
