import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Receipt = { recovery: { todo: NeoTodo; ask: NeoAsk } | null; changed: boolean };
const reason = 'Start was interrupted; a session may have started without being recorded.';
describe('Atomic interrupted-start recovery build', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let gateway: DbGateway;
  let changes: string[];
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (events) => {
      changes.push(...events.map((event) => event.table));
    };
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Full work',
      request: 'Retain work',
      createdAt: 1,
    });
    store.addTodo(
      'todo',
      'ask',
      { title: 'Work', doneWhen: 'Observed', check: null, instruction: 'Continue', named: null },
      1
    );
    sessions.create('todo', {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'synthetic', name: 'Fixture', folder: '/synthetic' },
    });
    store.claimStart(store.getTodo('todo')!, 2);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const recover = (id = 'todo', now = 10) =>
    gateway.run(DB_OPS.get('neo.todoRunnerWrites') as DbOp<unknown, Receipt>, {
      method: 'recover',
      args: [id, now],
    });
  const snapshot = () => ({
    todo: store.getTodo('todo'),
    ask: store.getAsk('ask'),
    cards: store.listQuestions('ask'),
    interrupted: sessions.readStartInterrupted('todo'),
  });
  const startCard = () =>
    store.askQuestion(
      'start',
      'ask',
      {
        kind: 'start',
        text: 'Start?',
        startTodos: ['todo'],
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
      },
      3
    );

  test('the committed receipt retains the entire report and marks only the interrupted start', async () => {
    const report = 'Complete report 🦊\n'.repeat(20000);
    store.updateTodo(store.getTodo('todo')!, { report }, 3);
    startCard();
    const receipt = await recover();
    expect(receipt).toMatchObject({
      recovery: { todo: { state: 'failed', reason, report }, ask: { id: 'ask' } },
      changed: true,
    });
    expect(sessions.readStartInterrupted('todo')).toBe(true);
    expect(store.getQuestion('start')?.state).toBe('retired');
    expect(changes).toContain('neo_todo_sessions');
    expect(changes).toContain('neo_todos');
    expect(changes).toContain('neo_questions');
  });

  test('an ask-stamp failure rolls back the interruption flag, state and cards together', async () => {
    startCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_stamp BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    await expect(recover()).rejects.toThrow('synthetic rollback');
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('a failure writing the interruption flag leaves work unchanged', async () => {
    startCard();
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_flag BEFORE UPDATE OF start_interrupted ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic flag failure'); END"
    );
    await expect(recover()).rejects.toThrow('synthetic flag failure');
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('a worker bound after candidate discovery is preserved without recovery', async () => {
    expect(sessions.unrecordedStarts()).toEqual(['todo']);
    sessions.recordRef('todo', { adapter: 'hyperneo', id: 'late-worker' }, 4);
    const before = snapshot();
    expect(await recover()).toEqual({ recovery: null, changed: false });
    expect(snapshot()).toEqual(before);
    expect(sessions.readRef('todo')?.id).toBe('late-worker');
    expect(changes).toEqual([]);
  });

  test.each(['todo', 'done', 'blocked', 'failed', 'removed', 'closed_unverified'] as const)(
    'current %s work stays unchanged',
    async (state) => {
      expect(sessions.unrecordedStarts()).toEqual(['todo']);
      store.updateTodo(store.getTodo('todo')!, { state, reason: 'Current decision' }, 4);
      const before = snapshot();
      expect(await recover()).toEqual({ recovery: null, changed: false });
      expect(snapshot()).toEqual(before);
      expect(changes).toEqual([]);
    }
  );

  test('competing or repeated recovery returns one committed transition', async () => {
    const receipts = await Promise.all([recover(), recover()]);
    expect(receipts.filter((receipt) => receipt.recovery)).toHaveLength(1);
    expect(receipts[1]).toEqual({ recovery: null, changed: false });
    const before = snapshot(),
      prior = changes.length;
    expect(await recover()).toEqual({ recovery: null, changed: false });
    expect(snapshot()).toEqual(before);
    expect(changes).toHaveLength(prior);
  });

  test('a repeated interruption reason reuses the existing failure escalation policy', async () => {
    store.updateTodo(store.getTodo('todo')!, { reason }, 3);
    expect(await recover()).toMatchObject({
      recovery: {
        todo: { state: 'blocked', blockedBy: 'failure', blockedReason: `Failed twice: ${reason}` },
      },
      changed: true,
    });
  });

  test('a settled ask keeps the existing removal semantics', async () => {
    db.prepare("UPDATE neo_asks SET status='done' WHERE id='ask'").run();
    expect(await recover()).toMatchObject({
      recovery: { todo: { state: 'removed' }, ask: { status: 'done' } },
      changed: true,
    });
    expect(sessions.readStartInterrupted('todo')).toBe(true);
  });

  test('a missing candidate is a quiet no-op', async () => {
    expect(await recover('missing')).toEqual({ recovery: null, changed: false });
    expect(changes).toEqual([]);
  });
});
