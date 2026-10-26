import type { WorkerIdentity } from './worker-identity.ts';
import type { ArtifactProjection } from './artifact-file.ts';

export type NeoAskStatus = 'open' | 'done' | 'dropped';

export interface NeoAsk {
  focusedSession?: NeoQuestionSource;
  id: string;
  goalId?: string | null;
  projectId: string | null;
  repo: string | null;
  parentId: string | null;
  sessionId: string;
  originMessageId: string | null;
  title: string;
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

export type NeoTodoState =
  | 'todo'
  | 'doing'
  | 'blocked'
  | 'done'
  | 'closed_unverified'
  | 'failed'
  | 'removed';

export type NeoTodoBlocker = 'check' | 'worker' | 'failure' | 'question' | 'needs-human';

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
  repo: string | null;
  state: NeoTodoState;
  reason: string | null;
  blockedReason: string | null;
  nextAction: string | null;
  blockedBy: NeoTodoBlocker | null;
  replacedBy: string | null;
  addedAfterStart: boolean;
  report: string | null;
  evidence: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type NeoQuestionKind = 'yesno' | 'choice' | 'reply' | 'start';

export type NeoQuestionState = 'open' | 'answered' | 'retired';

export type NeoQuestionAnswer = string | string[];

export interface NeoQuestionSource extends WorkerIdentity {
  provider: string;
  link: string | null;
}

export interface NeoQuestion extends ArtifactProjection {
  sourceSession?: NeoQuestionSource;
  todoId?: string | null;
  document?: string | null;
  replyTo?: string[];
  id: string;
  askId: string;
  text: string;
  kind: NeoQuestionKind;
  options: string[] | null;
  multiple: boolean;
  noLabel: string | null;
  yesLabel: string | null;
  startTodos: string[] | null;
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
  return options.map((_, index) => String.fromCharCode(65 + index));
}

export function neoLabelledOptions(options: readonly string[], picked: readonly string[]): string {
  return picked
    .map((option) => {
      const index = options.indexOf(option);
      return index < 0 ? option : `${String.fromCharCode(65 + index)} (${option})`;
    })
    .join(', ');
}

const LETTER_REPLY =
  /^(?:我?选(?:择|项)?|option|choice|pick)?\s*([a-f](?:(?:\s*[,，、&和与]\s*|\s+and\s+)[a-f])*)\s*(?:吧|好了)?\s*[.。!！]?$/i;

export function neoChoiceByLetter(
  words: string,
  question: Pick<NeoQuestion, 'kind' | 'options' | 'multiple'> | null
): string[] | null {
  const letters = words
    .trim()
    .match(LETTER_REPLY)?.[1]
    .split(/\s*[,，、&和与]\s*|\s+and\s+/i);
  if (question?.kind !== 'choice' || !question.options || !letters) return null;
  const picked = [
    ...new Set(
      letters.map((letter) => question.options?.[letter.toUpperCase().charCodeAt(0) - 65])
    ),
  ];
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
