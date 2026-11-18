import assert from 'node:assert/strict';
import type { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

export function seedHistoricalAsk(
  store: NeoAskTodoRepository,
  sessionId: string,
  input: { title: string; request: string; goalId?: string | null; projectId?: string | null }
) {
  const prior = store.findAsk(sessionId, null, input.title, input.goalId ?? null);
  if (prior) return prior;
  return store.openAsk({ id: crypto.randomUUID(), sessionId, projectId: input.projectId ?? null, goalId: input.goalId ?? null, originMessageId: null, title: input.title, request: input.request, createdAt: Date.now() });
}

export function acceptProposalFixture(store: NeoAskTodoRepository, askId: string) {
  const questions = store.listQuestions(askId).filter((question) => question.state === 'open' && question.kind === 'yesno');
  assert.equal(questions.length, 1, 'Expected one open proposal card');
  const answered = store.answerQuestion(questions[0]!, 'yes', 'button', Date.now());
  assert(answered, 'The synthetic human decision must be recorded');
}
