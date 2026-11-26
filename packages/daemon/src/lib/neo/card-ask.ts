import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import { openHumanCard } from './human-card.ts';

export const CARD_ASKS = {
  rule: { title: 'Standing rule change', topic: '规则' },
  settings: { title: 'Settings change', topic: '设置' },
} as const;

export const cardAskId = (questionId: string) => neoDerivedId(`card-ask:${questionId}`);

export function requireCardAskSession(
  sessionId: string | null | undefined
): { value: string } | { reason: { ok: false; reason: string } } {
  return sessionId
    ? { value: sessionId }
    : { reason: { ok: false, reason: 'no_session: no Neo session can own this card.' } };
}

export function openCardOnOwnAsk(
  store: NeoAskTodoRepository,
  questionId: string,
  sessionId: string,
  kind: keyof typeof CARD_ASKS,
  draft: NeoQuestionDraft,
  now: number
): void {
  const ask = store.openAsk({
    ...CARD_ASKS[kind],
    id: cardAskId(questionId),
    projectId: null,
    sessionId,
    originMessageId: null,
    request: draft.text,
    createdAt: now,
  });
  openHumanCard(store, questionId, ask.id, draft, now);
}
