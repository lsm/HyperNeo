import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
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

export function applyOrKeepCard(text: string, apply: string, keep: string): NeoQuestionDraft {
  return choiceCard(text, [apply, keep]);
}

export function choiceCard(text: string, options: string[]): NeoQuestionDraft {
  return {
    text,
    kind: 'choice',
    options,
    multiple: false,
    noLabel: null,
    yesLabel: null,
  };
}

export function humanPickedApply(question: {
  kind: string;
  options: readonly string[] | null;
  answer: unknown;
}): boolean {
  return question.kind === 'yesno'
    ? question.answer === 'yes'
    : question.kind === 'choice' && [question.answer].flat().join('\n') === question.options?.[0];
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
  language: LanguageSetting | undefined
): Gate<T> {
  const reason =
    asksSomething(card) ?? shortEnough(card) ?? noInternalId(card) ?? inLanguage(card, language);
  return reason ? { reason: { ok: false, reason } } : { value: card };
}
