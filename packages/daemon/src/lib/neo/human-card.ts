import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import type {
  NeoAskTodoRepository,
  NeoQuestionDraft,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import { isNeoTodoStalledCard, neoQuestionTodo } from './todo-state.ts';

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

type Card = Pick<NeoQuestionDraft, 'text' | 'kind' | 'confirm'>;
type Gate<T> = { value: T } | { reason: { ok: false; reason: string } };

const NEO_CARD_MAX_CHARS = 400;
const INTERNAL_ID = /\b(?=[0-9a-f-]*\d)(?=[0-9a-f-]*[a-f])[0-9a-f]{7,}(?:-[0-9a-f]{4,})*\b/;
const CJK = /[一-鿿]/g;

const asksSomething = (card: Card) =>
  card.kind !== 'reply' || /[?？]/.test(card.text)
    ? null
    : 'card_no_action: a reply card must ask the human something; a notice belongs in chat.';

const onlyCard = (open: readonly NeoQuestion[], replaced: NeoQuestion | null) => {
  const other = open.find(
    (question) =>
      question.state === 'open' &&
      question.kind !== 'start' &&
      (neoQuestionTodo(question) || question.retireWhen) &&
      question.id !== replaced?.id &&
      !isNeoTodoStalledCard(question.text)
  );
  return other
    ? `card_open: card ${other.id} is already open on this ask; wait for its answer, or change it with neo.question.ask replaces.`
    : null;
};

const shortEnough = (card: Card) =>
  card.text.length < NEO_CARD_MAX_CHARS + 1
    ? null
    : `card_too_long: keep text to ${NEO_CARD_MAX_CHARS} characters and put the rest in document.`;

const noInternalId = (card: Card) =>
  !card.confirm && INTERNAL_ID.test(card.text)
    ? 'card_internal_id: say what it is in plain words, not its internal id.'
    : null;

const inLanguage = (card: Card, language: LanguageSetting | undefined) => {
  const cjk = card.text.match(CJK)?.length ?? 0;
  if (language === 'zh-Hans' && cjk === 0) return 'card_language: write this card in Chinese.';
  if (language === 'en' && cjk * 2 > card.text.replace(/\s/g, '').length)
    return 'card_language: write this card in English.';
  return null;
};

export function requireHumanCard<T extends Card>(
  card: T,
  open: readonly NeoQuestion[],
  replaced: NeoQuestion | null,
  language: LanguageSetting | undefined
): Gate<T> {
  const reason =
    asksSomething(card) ??
    onlyCard(open, replaced) ??
    shortEnough(card) ??
    noInternalId(card) ??
    inLanguage(card, language);
  return reason ? { reason: { ok: false, reason } } : { value: card };
}
