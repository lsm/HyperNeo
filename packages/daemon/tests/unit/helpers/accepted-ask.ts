import type { NeoAskTodoRepository } from '../../../src/storage/repositories/neo-ask-todo-repository.ts';

export function historicalAsk(store: NeoAskTodoRepository, sessionId: string, title: string) {
  return (
    store.findAsk(sessionId, null, title, null) ??
    store.openAsk({
      id: crypto.randomUUID(),
      sessionId,
      projectId: null,
      originMessageId: null,
      title,
      request: title,
      createdAt: 1,
    })
  );
}
