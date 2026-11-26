import { eastAsianWidth } from 'get-east-asian-width';
import type { ArtifactProjection, ArtifactRef, PublicHandoffReference } from './artifact-file.ts';
import type { WorkerIdentity } from './worker-identity.ts';

export type NeoAskStatus = 'open' | 'done' | 'dropped';

export const NEO_OTHER_TOPIC = '其他';
export const NEO_OTHER_TOPIC_KEY = `pick:${NEO_OTHER_TOPIC}`;
export const NEO_TOPIC_CELLS = 12;

const topicGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function topicGraphemeWidth(grapheme: string): number {
  const base = grapheme.match(/[^\p{Mark}]/u)?.[0]?.codePointAt(0);
  if (base === undefined) return 0;
  return /\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(grapheme)
    ? 2
    : eastAsianWidth(base, { ambiguousAsWide: false });
}

export function neoTopicFits(label: string): boolean {
  let width = 0;
  for (const { segment } of topicGraphemes.segment(label)) {
    width += topicGraphemeWidth(segment);
    if (width > NEO_TOPIC_CELLS) return false;
  }
  return !!label;
}

export function shortenNeoTopic(label: string): string {
  if (neoTopicFits(label)) return label;
  let width = 0;
  let prefix = '';
  for (const { segment } of topicGraphemes.segment(label)) {
    width += topicGraphemeWidth(segment);
    if (width >= NEO_TOPIC_CELLS) break;
    prefix += segment;
  }
  return `${prefix}…`;
}

export interface NeoTopicLabel {
  topic: string;
  topicKey: string;
  topicSource?: 'project' | 'repository';
}

export interface NeoDesktopApp {
  seen?: 'all';
  bundleId: string;
  name: string;
}

export interface NeoAsk {
  focusedSession?: NeoQuestionSource;
  desktopApps?: NeoDesktopApp[];
  id: string;
  goalId?: string | null;
  projectId: string | null;
  parentId: string | null;
  sessionId: string;
  originMessageId: string | null;
  title: string;
  topic: string | null;
  topicKey?: string;
  topicSource?: NeoTopicLabel['topicSource'];
  request: string;
  status: NeoAskStatus;
  outcome: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface NeoTodoCheck {
  pack: string;
  kind: string;
  params: Record<string, unknown>;
}

export type NeoTodoState = 'todo' | 'doing' | 'blocked' | 'done' | 'removed';

export type NeoTodoPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NeoTodoBlocker =
  | 'check'
  | 'worker'
  | 'failure'
  | 'question'
  | 'needs-human'
  | 'environment'
  | 'stalled'
  | 'held';

export interface NeoTodo extends ArtifactProjection {
  worker?: WorkerIdentity | null;
  desktopApps?: NeoDesktopApp[];
  id: string;
  askId: string;
  position: number;
  title: string;
  doneWhen: string;
  check: NeoTodoCheck | null;
  instruction: string | null;
  named: Record<string, unknown> | null;
  state: NeoTodoState;
  reason: string | null;
  blockedReason: string | null;
  nextAction: string | null;
  blockedBy: NeoTodoBlocker | null;
  priority: NeoTodoPriority;
  dependsOn: string[] | null;
  replacedBy: string | null;
  addedAfterStart: boolean;
  report: string | null;
  evidence: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  approvedAt: number | null;
  approvalQuestionId: string | null;
  producesFollowUp?: true;
}

export type NeoQuestionKind = 'yesno' | 'choice' | 'reply';

export type NeoQuestionState = 'open' | 'answered' | 'retired';

export type NeoQuestionAnswer = string | string[];

export function isAgentResolvedQuestion(
  question: Pick<NeoQuestion, 'state' | 'answer' | 'answeredBy'>
): boolean {
  return question.state === 'retired' && question.answer !== null && question.answeredBy === null;
}

export interface NeoQuestionSource extends WorkerIdentity {
  provider: string;
  link: string | null;
}

export interface NeoAnswerProvenance {
  words: string;
  via: string;
  viaName: string;
  where: string;
  when: string;
  at: number;
}

export interface NeoQuestion {
  answerProvenance?: NeoAnswerProvenance;
  readonly artifacts?: readonly (ArtifactRef | PublicHandoffReference)[];
  retireWhen?: NeoTodoCheck;
  sourceSession?: NeoQuestionSource;
  todoId?: string | null;
  document?: string | null;
  replyTo?: string[];
  cause?: string | null;
  actionsAppliedAt?: number | null;
  heldAt?: number | null;
  id: string;
  askId: string;
  text: string;
  kind: NeoQuestionKind;
  options: string[] | null;
  optionDetails?: Record<string, string>;
  recommended?: string;
  multiple: boolean;
  noLabel: string | null;
  yesLabel: string | null;
  todos: string[];
  confirm?: { path: string; sha256: string } | null;
  state: NeoQuestionState;
  answer: NeoQuestionAnswer | null;
  answeredBy: 'button' | 'chat' | null;
  answeredAt: number | null;
  retiredReason: string | null;
  replacedBy: string | null;
  createdAt: number;
}

export function neoOptionLabels(options: readonly string[]): string[] {
  return options.map((_, index) => String(index + 1));
}

export function neoLabelledOptions(options: readonly string[], picked: readonly string[]): string {
  return picked
    .map((option) => {
      const index = options.indexOf(option);
      return index < 0 ? option : `${index + 1} (${option})`;
    })
    .join(', ');
}

const ZH_DIGITS = '一二三四五六';
const ZH_NUMBER = '[零〇一二三四五六七八九十百千万两]+';
const EN_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const EN_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const EN_EXTRA_ORDINAL =
  '(?:seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)';
const NUMBER = `(?:\\d+(?:st|nd|rd|th)?|${ZH_NUMBER}|${EN_ORDINALS.join('|')}|${EN_EXTRA_ORDINAL})`;
const ONE_PICK = `(?:第\\s*)?${NUMBER}(?:\\s*(?:号|个|项|条))?`;
const JOIN = '\\s*(?:[,，、&和与跟]|and)\\s*|\\s+';
const NUMBER_REPLY = new RegExp(
  `^(?:我?选(?:择|项)?|option|choice|pick|number|#|the)?\\s*(${ONE_PICK}(?:(?:${JOIN})${ONE_PICK})*)\\s*(?:吧|好了)?\\s*[.。!！]?$`,
  'i'
);

function optionNumber(word: string): number | undefined {
  const bare = word
    .replace(/^第\s*/, '')
    .replace(/\s*(?:号|个|项|条)$/, '')
    .toLowerCase();
  if (/^\d+(?:st|nd|rd|th)?$/.test(bare)) return Number.parseInt(bare, 10);
  const zh = bare.length === 1 ? ZH_DIGITS.indexOf(bare) : -1;
  if (zh >= 0) return zh + 1;
  const ordinal = EN_ORDINALS.indexOf(bare);
  return ordinal >= 0 ? ordinal + 1 : 0;
}

export function neoChoiceByNumber(
  words: string,
  question: Pick<NeoQuestion, 'kind' | 'options' | 'multiple'> | null
): string[] | 'invalid' | null {
  const said = words
    .trim()
    .replace(new RegExp(`\\b(${EN_ORDINALS.join('|')})\\s+one\\b`, 'gi'), '$1')
    .replace(
      new RegExp(`\\b(option|choice|number)\\s+(${EN_WORDS.join('|')})\\b`, 'gi'),
      (_, lead, word) => `${lead} ${EN_WORDS.indexOf(word.toLowerCase()) + 1}`
    );
  const list = said.match(NUMBER_REPLY)?.[1];
  if (question?.kind !== 'choice' || !question.options || !list) return null;
  const parts = list.match(new RegExp(ONE_PICK, 'gi')) ?? [];
  const numbers = parts.map(optionNumber);
  if (numbers.some((n) => n === undefined)) return null;
  const picked = [...new Set(numbers.map((n) => question.options?.[(n as number) - 1]))];
  return picked.every((option) => option !== undefined) &&
    (question.multiple || picked.length === 1)
    ? (picked as string[])
    : question.options.includes(words.trim())
      ? [words.trim()]
      : 'invalid';
}

export interface NeoReplyTo {
  kind: 'question' | 'todo' | 'message' | 'ask';
  id: string;
  author?: 'neo' | 'user';
  excerpt?: string;
}

export function neoReplyExcerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300).trimEnd()}…` : trimmed;
}

export interface NeoStatusCode {
  code: string;
  params: Record<string, string>;
}

export interface NeoTodoEntry extends NeoTodo {
  status: string;
  statusCodes?: NeoStatusCode[];
  link: string | null;
  remoteLink: string | null;
}

export type NeoAskEntryState = 'waiting' | 'doing' | 'done' | 'dropped' | 'todo';

export interface NeoQuestionEntry extends NeoQuestion {
  textCodes?: NeoStatusCode[];
  optionLabels?: string[];
  optionCodes?: NeoStatusCode[];
}

export interface NeoAskEntry {
  summary?: {
    todoCount: number;
    questionCount: number;
    openQuestionCount: number;
    questionRefs?: { id: string; replacedBy: string | null }[];
  };
  ask: NeoAsk;
  state: NeoAskEntryState;
  todos: NeoTodoEntry[];
  doneCount: number;
  questions: NeoQuestionEntry[];
}
