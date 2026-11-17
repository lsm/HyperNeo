import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { neoDerivedId } from './derived-id.ts';

const requestTodoId = (incident: string) => neoDerivedId(`neo-request-todo:${incident}`);
export const neoRequestAskId = (incident: string) => neoDerivedId(`neo-request-ask:${incident}`);

export function closedNeoRequest(store: NeoAskTodoRepository, incident: string): string | null {
  const todo = store.getTodo(requestTodoId(incident));
  return todo && ['done', 'removed', 'failed'].includes(todo.state) ? todo.id : null;
}

export function recordNeoRequestTodo(
  store: NeoAskTodoRepository,
  input: {
    incident: string;
    neoSession: string;
    sender: string;
    text: string;
    messageId: string;
    now: number;
  }
): void {
  const askId = neoRequestAskId(input.incident);
  const todoId = requestTodoId(input.incident);
  if (store.getTodo(todoId)) return;
  const title = input.text.trim().split('\n')[0].trim().slice(0, 120) || 'Request from a session';
  if (!store.getAsk(askId))
    store.openAsk({
      id: askId,
      projectId: null,
      sessionId: input.neoSession,
      originMessageId: input.messageId,
      title,
      request: `From session ${input.sender}:\n${input.text}`,
      createdAt: input.now,
    });
  store.addTodo(
    todoId,
    askId,
    {
      title,
      doneWhen: `Neo replied to session ${input.sender} and closed this todo.`,
      check: null,
      named: { requestFrom: input.sender },
      instruction: null,
      approvedAt: input.now,
      dependsOn: [],
    },
    input.now
  );
}

export const NEO_REQUEST_REPLY = 'neo.request.reply';

export type NeoRequestReply = {
  todoId: string;
  key?: string;
  to: string;
  from: string | null;
  text: string;
  deferred?: number;
};

export function queueNeoRequestReply(
  db: Database,
  before: NeoTodo,
  after: NeoTodo,
  reason: string | undefined,
  from: string | null
): void {
  const to = before.named?.requestFrom;
  const terminal = (todo: NeoTodo) => ['done', 'removed'].includes(todo.state);
  if (typeof to !== 'string' || terminal(before) || !terminal(after)) return;
  const added = askTodos(db, before.askId).filter((todo) => todo.id !== before.id);
  const split = added.length
    ? `Todos added for it: ${added.map((todo) => `"${todo.title}" (${todo.id})`).join(', ')}.`
    : 'No todo was added for it.';
  const reply: NeoRequestReply = {
    todoId: before.id,
    to,
    from,
    text: `Neo closed your request "${after.title}" as ${after.state}${reason ? `: ${reason}` : '.'}\n${split}`,
  };
  enqueueReply(db, reply, { todoId: before.id });
}

export function queueNeoRequestSettledReply(db: Database, askId: string, from: string | null) {
  const todos = askTodos(db, askId);
  const request = todos.find((todo) => todo.requestFrom !== null);
  const others = todos.filter((todo) => todo !== request);
  if (!request?.requestFrom || !others.length) return;
  const key = `neo-request-settled:${askId}`;
  const states = others.map(
    (todo) => `"${todo.title}" (${todo.id}) ${todo.state}${todo.reason ? `: ${todo.reason}` : ''}`
  );
  enqueueReply(
    db,
    {
      todoId: request.id,
      key,
      to: request.requestFrom,
      from,
      text: `Your request "${request.title}" is finished:\n${states.join('\n')}`,
    },
    { key }
  );
}

const askTodos = (db: Database, askId: string) =>
  db
    .prepare(
      `SELECT id, title, state, reason, json_extract(named, '$.requestFrom') AS requestFrom
         FROM neo_todos WHERE ask_id = ? ORDER BY position, created_at`
    )
    .all(askId) as {
    id: string;
    title: string;
    state: string;
    reason: string | null;
    requestFrom: string | null;
  }[];

const enqueueReply = (db: Database, payload: NeoRequestReply, match: Record<string, string>) =>
  new JobQueueRepository(db).enqueueUniquePending({
    queue: NEO_REQUEST_REPLY,
    payload,
    matchPayload: match,
    activeStatuses: ['pending', 'processing', 'completed'],
    maxRetries: 4,
  });
