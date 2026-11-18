import type { WorkerIdentity } from './worker-identity.ts';
import type { ArtifactProjection, ArtifactRef, PublicHandoffReference } from './artifact-file.ts';

export type NeoAskStatus = 'open' | 'done' | 'dropped';

export const NEO_OTHER_TOPIC = '其他';

export interface NeoAsk {
  focusedSession?: NeoQuestionSource;
  id: string;
  goalId?: string | null;
  projectId: string | null;
  parentId: string | null;
  sessionId: string;
  originMessageId: string | null;
  title: string;
  topic: string | null;
  topicKey?: string;
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

/** The numbers the card shows in front of choice options: 1, 2, 3… in order. */
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
const EN_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const EN_WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];
const NUMBER = `(?:[1-6]|[${ZH_DIGITS}]|${EN_ORDINALS.join('|')}|${EN_WORDS.join('|')})`;
const ONE_PICK = `(?:第\\s*)?${NUMBER}(?:\\s*(?:号|个|项|条))?`;
const JOIN = '\\s*(?:[,，、&和与跟]|and)\\s*|\\s+';
const NUMBER_REPLY = new RegExp(
  `^(?:我?选(?:择|项)?|option|choice|pick|number|no\\.?|#|the)?\\s*(${ONE_PICK}(?:(?:${JOIN})${ONE_PICK})*)\\s*(?:吧|好了)?\\s*[.。!！]?$`,
  'i'
);

function optionNumber(word: string): number | undefined {
  const bare = word
    .replace(/^第\s*/, '')
    .replace(/\s*(?:号|个|项|条)$/, '')
    .toLowerCase();
  if (/^[1-6]$/.test(bare)) return Number(bare);
  const zh = ZH_DIGITS.indexOf(bare);
  if (zh >= 0) return zh + 1;
  const ordinal = EN_ORDINALS.indexOf(bare);
  if (ordinal >= 0) return ordinal + 1;
  const plain = EN_WORDS.indexOf(bare);
  return plain >= 0 ? plain + 1 : undefined;
}

/** Reads a chat reply like "2", "选二", "第二个", "1 和 3" or "the second one" as the numbered options. */
export function neoChoiceByNumber(
  words: string,
  question: Pick<NeoQuestion, 'kind' | 'options' | 'multiple'> | null
): string[] | null {
  const said = words
    .trim()
    .replace(new RegExp(`\\b(${EN_ORDINALS.join('|')})\\s+one\\b`, 'gi'), '$1');
  const list = said.match(NUMBER_REPLY)?.[1];
  if (question?.kind !== 'choice' || !question.options || !list) return null;
  const parts = list.match(new RegExp(ONE_PICK, 'gi')) ?? [];
  const numbers = parts.map(optionNumber);
  if (numbers.some((n) => n === undefined)) return null;
  const picked = [...new Set(numbers.map((n) => question.options?.[(n as number) - 1]))];
  return picked.every((option) => option !== undefined) &&
    (question.multiple || picked.length === 1)
    ? (picked as string[])
    : null;
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
