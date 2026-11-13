import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const NOTE = 'neo-stalled-ask';
describe('Auto-settle after a consumed stalled-ask turn', () => {
  let db: Database, store: NeoAskTodoRepository, gateway: DbGateway, changes: string[];
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (events) => {
      changes.push(...events.map((event) => event.table));
    };
    db.prepare(`INSERT INTO sessions
      (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata)
      VALUES ('neo','Synthetic','general','/synthetic','2026-01-01','2026-01-01','active','{}','{}')`).run();
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Work',
      request: 'Keep work',
      createdAt: 1,
    });
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  let seq = 0;
  const sdk = (
    kind: 'user' | 'result',
    uuid: string,
    consumedSeq: number | null,
    sendStatus = 'consumed',
    recoveryIntercepted = 0,
    recoveryBillingTerminal = 0
  ) => {
    seq += 1;
    db.prepare(`INSERT INTO sdk_messages
      (seq, id, session_id, message_type, sdk_message, timestamp, sdk_uuid, consumed_seq,
       is_terminal, send_status, recovery_intercepted, recovery_billing_terminal)
      VALUES (?, ?, 'neo', ?, ?, '2026-01-01', ?, ?, ?, ?, ?, ?)`).run(
      seq,
      `m${seq}`,
      kind,
      JSON.stringify({ type: kind }),
      uuid,
      consumedSeq,
      kind === 'result' ? 1 : 0,
      sendStatus,
      recoveryIntercepted,
      recoveryBillingTerminal
    );
  };
  const wakeNote = (askId: string, options: { batch?: string; status?: string } = {}) => {
    const payload = {
      to: { kind: 'session', sessionId: 'neo' },
      origin: 'session:neo',
      messageUuid: `${NOTE}:${askId}:1:0`,
      message: { type: 'user', message: { content: 'reminder' } },
      ...(options.batch ? { neoBatchUuid: options.batch } : {}),
    };
    db.prepare(`INSERT INTO job_queue
      (id, queue, status, payload, run_at, created_at, completed_at)
      VALUES (?, 'neo_notes', ?, ?, 0, 0, 0)`).run(
      `note-${askId}-${++seq}`,
      options.status ?? 'completed',
      JSON.stringify(payload)
    );
  };
  const consumedWake = (askId: string, turnEnds = true) => {
    wakeNote(askId, { batch: `batch-${askId}` });
    sdk('user', `batch-${askId}`, 10);
    if (turnEnds) sdk('result', `result-${askId}`, 11);
  };
  const add = (id: string, state: string, extra: { reason?: string | null } = {}) => {
    store.addTodo(
      id,
      'ask',
      { title: `Step ${id}`, doneWhen: `Done ${id}`, check: null, instruction: null, named: null },
      1
    );
    db.prepare('UPDATE neo_todos SET state = ?, reason = ? WHERE id = ?').run(
      state,
      extra.reason ?? null,
      id
    );
  };
  const sweep = () =>
    gateway.run(DB_OPS.get('neo.turnedAskSettles') as DbOp<{ now: number }, string[]>, {
      now: 100,
    });

  test('settles done with Neo’s written outcome once the wake turn ends', async () => {
    add('first', 'done');
    add('second', 'removed', { reason: 'Superseded' });
    store.recordAskOutcome('ask', 'Shipped the work', 3);
    consumedWake('ask');
    expect(await sweep()).toEqual(['ask']);
    expect(store.getAsk('ask')).toMatchObject({ status: 'done', outcome: 'Shipped the work' });
    expect(changes).toEqual(['neo_asks']);
  });

  test('generates the outcome from the step list when Neo wrote none', async () => {
    add('alpha', 'done');
    add('beta', 'closed_unverified');
    add('gamma', 'removed', { reason: 'Superseded' });
    add('delta', 'failed');
    consumedWake('ask');
    await sweep();
    const ask = store.getAsk('ask')!;
    expect(ask.status).toBe('done');
    expect(ask.outcome).toContain('Step alpha');
    expect(ask.outcome).toContain('Step beta');
    expect(ask.outcome).toContain('Step gamma');
    expect(ask.outcome).toContain('Step delta');
  });

  test('drops the ask when no step finished', async () => {
    add('gone', 'removed', { reason: 'No longer needed' });
    add('broken', 'failed');
    consumedWake('ask');
    await sweep();
    expect(store.getAsk('ask')).toMatchObject({ status: 'dropped' });
    expect(store.getAsk('ask')!.outcome).toContain('Step gone');
    expect(store.getAsk('ask')!.outcome).toContain('Step broken');
  });

  test('drops an ask that never had steps', async () => {
    consumedWake('ask');
    await sweep();
    expect(store.getAsk('ask')).toMatchObject({ status: 'dropped', outcome: 'No steps recorded.' });
  });

  test.each(['todo', 'doing', 'blocked'] as const)(
    'leaves an ask with a live %s todo open',
    async (state) => {
      add('live', state);
      consumedWake('ask');
      expect(await sweep()).toEqual([]);
      expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
      expect(changes).toEqual([]);
    }
  );

  test('leaves an ask with an open card alone', async () => {
    add('finished', 'done');
    store.askQuestion(
      'card',
      'ask',
      {
        kind: 'yesno',
        text: 'Go?',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: null,
        confirm: null,
        document: null,
        replyTo: [],
        todoId: null,
        artifacts: [],
      },
      2
    );
    consumedWake('ask');
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    expect(changes).toEqual([]);
  });

  test('an undelivered or unconsumed wake does not settle the ask', async () => {
    add('finished', 'done');
    wakeNote('ask');
    expect(await sweep()).toEqual([]);
    wakeNote('ask', { batch: 'unconsumed-batch', status: 'completed' });
    sdk('user', 'unconsumed-batch', null, 'enqueued');
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
  });

  test('a wake consumed mid-turn does not settle until the turn ends', async () => {
    add('finished', 'done');
    consumedWake('ask', false);
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    sdk('result', 'result-ask', 11);
    expect(await sweep()).toEqual(['ask']);
    expect(store.getAsk('ask')).toMatchObject({ status: 'done' });
  });

  test('a limit result intercepted for recovery does not end the turn', async () => {
    add('finished', 'done');
    consumedWake('ask', false);
    sdk('result', 'limited', 11, 'consumed', 1, 0);
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    sdk('result', 'recovered', 12);
    expect(await sweep()).toEqual(['ask']);
  });

  test('a directly delivered wake also counts once its turn ends', async () => {
    add('finished', 'done');
    sdk('user', `${NOTE}:ask:1:0`, 20);
    sdk('result', 'direct-result', 21);
    expect(await sweep()).toEqual(['ask']);
  });

  test('a wake for another ask does not settle this one', async () => {
    add('finished', 'done');
    consumedWake('other-ask');
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
  });

  test('a settled ask is left alone', async () => {
    add('finished', 'done');
    consumedWake('ask');
    store.settleAsk(store.getAsk('ask')!, 'dropped', 'Earlier', 4);
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'dropped', outcome: 'Earlier' });
  });
});
