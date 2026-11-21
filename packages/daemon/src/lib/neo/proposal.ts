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
  if (!(pendingProposal || pendingSessionQuestion || sessionRequest)) return { value: ask };
  return { reason: { ok: false, reason: notAcceptedReason(pendingProposal ? proposal : null) } };
}

export function notAcceptedReason(proposal: NeoQuestion | null): string {
  return proposal?.state === 'open'
    ? `ask_not_accepted: the human has not said yes on this ask's card (question ${proposal.id}). Wait for that answer; do not open another card asking for approval.`
    : 'ask_not_accepted: human approval is required before starting work.';
}

export const proposalCardRecord = (questionId: string) =>
  `proposal_card: the human now sees a yes/no card for this ask (question ${questionId}). Add todos after the human answers yes; do not open another card asking for approval.`;
