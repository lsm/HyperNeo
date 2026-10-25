import { readNeoQuestion } from '../question-operations.ts';
import type { HomeSavePlan } from './save.ts';
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

export function requireHomeChoice(
  input: HomeSavePlan,
  store: NeoAskTodoRepository,
  sessionId: string | undefined
): { value: HomeSavePlan } | { reason: HomeFailure } {
  if (!input.conflictQuestionId) return { value: input };
  const question = store.getQuestion(input.conflictQuestionId);
  const read = readNeoQuestion(question);
  const choice = [question?.answer ?? []].flat();
  if (
    !question ||
    !read.ok ||
    !read.answeredByHuman ||
    question.kind !== 'choice' ||
    question.answeredAt === null ||
    !question.answeredBy ||
    !sessionId ||
    store.getAsk(question.askId)?.sessionId !== sessionId ||
    choice.length !== 1 ||
    !['Keep local', 'Use remote'].includes(choice[0])
  )
    return {
      reason: {
        ok: false,
        reason:
          'human_choice_required: record the root-Neo question’s human Keep local or Use remote answer first; Review together needs further review.',
      },
    };
  return {
    value: {
      ...input,
      resolution: {
        questionId: question.id,
        version: choice[0] === 'Keep local' ? 'local' : 'remote',
      },
    },
  };
}
