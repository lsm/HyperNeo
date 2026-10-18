export type NeoAskStatus = 'open' | 'done' | 'dropped';

export interface NeoAsk {
  id: string;
  projectId: string | null;
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

export type NeoTodoState = 'todo' | 'doing' | 'done' | 'failed' | 'removed';

export interface NeoTodo {
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

export interface NeoQuestion {
  id: string;
  askId: string;
  text: string;
  kind: NeoQuestionKind;
  options: string[] | null;
  multiple: boolean;
  noLabel: string | null;
  yesLabel: string | null;
  startTodos: string[] | null;
  state: NeoQuestionState;
  answer: NeoQuestionAnswer | null;
  answeredBy: 'button' | 'chat' | null;
  answeredAt: number | null;
  retiredReason: string | null;
  replacedBy: string | null;
  createdAt: number;
}

export interface NeoReplyTo {
  kind: 'question' | 'todo' | 'message' | 'ask';
  id: string;
  author?: 'neo' | 'user';
  excerpt?: string;
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
}

export interface NeoAskEntry {
  ask: NeoAsk;
  state: NeoAskEntryState;
  todos: NeoTodoEntry[];
  questions: NeoQuestionEntry[];
}
