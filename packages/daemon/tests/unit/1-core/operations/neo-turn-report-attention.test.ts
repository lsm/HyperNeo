import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { deliverNeoTurnReport } from '../../../../src/lib/neo/turn-report.ts';
import { NeoTurnReportReceipts } from '../../../../src/lib/neo/turn-report-receipts.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoDraft,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { neoAttentionNotes } from '../../helpers/neo-attention-notes.ts';

const T0 = 1_000_000;
const ref = { adapter: 'hyperneo', id: 'worker-1' };
const draft: NeoTodoDraft = {
  title: 'Ship it',
  doneWhen: 'Shipped',
  check: null,
  named: null,
  instruction: 'Ship the change.',
  approvedAt: T0,
  dependsOn: [],
};
const facts = {
  priorStatus: 'running' as const,
  state: 'doing' as const,
  blockedBy: null,
  questionOpen: false,
};

describe('worker turn reports through the attention entry', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let notes: ReturnType<typeof neoAttentionNotes>;
  let todo: NeoTodo;

  const report = (
    turn: { id: string; at: number; message: string },
    status = 'done',
    latestAt = turn.at,
    receipts = new NeoTurnReportReceipts(db)
  ) =>
    deliverNeoTurnReport(
      store.getAsk('ask-1')!,
      store.getTodo(todo.id)!,
      'dispatch-1',
      ref,
      { status },
      turn,
      notes.attend,
      receipts,
      facts,
      latestAt
    );

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask-1',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: 'Ask',
      request: 'Do it',
      createdAt: T0,
    });
    todo = store.addTodo('todo-1', 'ask-1', draft, T0);
    store.updateTodo(todo, { state: 'doing', startedAt: T0 }, T0);
    notes = neoAttentionNotes(db, store);
  });

  afterEach(() => db.close());

  test('a finished turn is a digest line and does not wake Neo', async () => {
    await report({ id: 'turn-1', at: T0 + 100, message: 'PR opened' });
    expect(notes.wakes()).toEqual([]);
    expect(notes.digests()).toEqual([
      'Worker turn report (todo todo-1, dispatch dispatch-1, status done):\n\nWorker: hyperneo:worker-1\n\nPR opened',
    ]);
  });

  test.each(['failed', 'needs_you'])('a turn that ends %s wakes Neo', async (status) => {
    await report({ id: 'turn-1', at: T0 + 100, message: 'Stopped' }, status);
    expect(notes.wakes()).toHaveLength(1);
    expect(notes.digests()).toEqual([]);
  });

  test('a turn on a blocked todo wakes Neo', async () => {
    store.updateTodo(
      store.getTodo(todo.id)!,
      { state: 'blocked', blockedBy: 'environment', blockedReason: 'No network' },
      T0 + 50
    );
    await report({ id: 'turn-1', at: T0 + 100, message: 'Blocked (environment): No network' });
    expect(notes.wakes()).toHaveLength(1);
    expect(notes.digests()).toEqual([]);
  });

  test('an older turn read together with a newer one is dropped', async () => {
    await report({ id: 'turn-1', at: T0 + 100, message: 'First' }, 'done', T0 + 200);
    await report({ id: 'turn-2', at: T0 + 200, message: 'Second' }, 'done', T0 + 200);
    expect(notes.told().filter((text) => text.includes('First'))).toEqual([]);
    expect(notes.told().filter((text) => text.includes('Second'))).toHaveLength(1);
    expect(notes.dropped).toEqual(['turn.report todo-1: superseded by a newer report']);
  });

  test('the same turn read again is told once, across a restart and a status change', async () => {
    const turn = { id: 'turn-1', at: T0 + 100, message: 'PR opened' };
    await report(turn);
    await report(turn);
    await report(turn, 'running', turn.at, new NeoTurnReportReceipts(db));
    expect(notes.told()).toHaveLength(1);
  });

  test('a turn of a todo that waits on an open card is dropped', async () => {
    store.askQuestion(
      'card-1',
      'ask-1',
      {
        text: 'Which region?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        todoId: todo.id,
        document: null,
      },
      T0 + 50
    );
    await report({ id: 'turn-1', at: T0 + 100, message: 'Still waiting' });
    expect(notes.told()).toEqual([]);
    expect(notes.dropped).toEqual(['turn.report todo-1: covered by card']);
  });
});
