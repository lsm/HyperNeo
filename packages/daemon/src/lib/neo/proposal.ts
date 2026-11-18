import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoDerivedId } from './derived-id.ts';

export const proposalQuestionId = (askId: string) => neoDerivedId(`neo-proposal:${askId}`);

export const isHumanWorkDecision = (question: NeoQuestion) =>
  question.id === proposalQuestionId(question.askId) || question.cause === 'relay-session-proposal';

export const hasPendingTodoDecision = (questions: readonly NeoQuestion[], todoId: string) =>
  questions.some(
    (question) =>
      question.state === 'open' && question.todoId === todoId && isHumanWorkDecision(question)
  );

export function requireAcceptedAsk(
  ask: NeoAsk,
  proposal: NeoQuestion | null,
  questions: readonly NeoQuestion[],
  todos: readonly NeoTodo[]
): { value: NeoAsk } | { reason: { ok: false; reason: string } } {
  const pendingProposal =
    proposal &&
    (proposal.state !== 'answered' ||
      proposal.answer !== 'yes' ||
      proposal.answeredBy !== 'button');
  const pendingSessionQuestion =
    ask.originMessageId?.endsWith(':relay-pending') ||
    questions.some(
      (question) =>
        question.cause === 'relay-session-proposal' &&
        (question.state !== 'answered' || question.answeredBy !== 'button')
    );
  const sessionRequest = todos.some((todo) => typeof todo.named?.requestFrom === 'string');
  return pendingProposal || pendingSessionQuestion || sessionRequest
    ? {
        reason: {
          ok: false,
          reason: 'ask_not_accepted: human approval is required before starting work.',
        },
      }
    : { value: ask };
}
