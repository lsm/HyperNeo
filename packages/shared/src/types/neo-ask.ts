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
