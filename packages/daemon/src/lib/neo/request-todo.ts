import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { neoDerivedId } from './derived-id.ts';

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
  const askId = neoDerivedId(`neo-request-ask:${input.incident}`);
  const todoId = neoDerivedId(`neo-request-todo:${input.incident}`);
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
      named: null,
      instruction: null,
      approvedAt: input.now,
      dependsOn: [],
    },
    input.now
  );
}
