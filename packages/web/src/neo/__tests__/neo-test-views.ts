import type { NeoAskEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';

export function testTodo(id: string, patch: Partial<NeoTodoEntry> = {}): NeoTodoEntry {
  return {
    id,
    askId: 'ask',
    position: 0,
    priority: 'normal',
    title: `Todo ${id}`,
    doneWhen: 'Merged',
    check: null,
    instruction: 'Do it',
    named: null,
    repo: null,
    state: 'todo',
    reason: null,
    blockedReason: null,
    nextAction: null,
    blockedBy: null,
    replacedBy: null,
    addedAfterStart: false,
    report: null,
    evidence: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    finishedAt: null,
    status: '没开始',
    link: null,
    remoteLink: null,
    ...patch,
  };
}

export function testAskEntry(
  id: string,
  title: string,
  patch: Partial<Omit<NeoAskEntry, 'ask'>> = {}
): NeoAskEntry {
  return {
    ask: {
      id,
      projectId: null,
      repo: null,
      parentId: null,
      sessionId: 'neo',
      originMessageId: null,
      title,
      request: title,
      status: 'open',
      outcome: null,
      createdAt: 1,
      updatedAt: 1,
      settledAt: null,
    },
    state: 'todo',
    todos: [],
    doneCount: 0,
    questions: [],
    ...patch,
  };
}
