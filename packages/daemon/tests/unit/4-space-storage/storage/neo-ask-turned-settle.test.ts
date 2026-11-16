import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createCleanupHandler } from '../../../../src/lib/job-handlers/cleanup.handler.ts';
import { createMailboxEntry } from '../../../../src/lib/mailbox/entry.ts';
import {
  type Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoWakeQueueRepository } from '../../../../src/storage/repositories/neo-wake-queue-repository.ts';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { neoFinishedAskUuids } from '../../../../src/lib/neo/stalled-asks.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { neoAskTodosVersion } from '../../../../src/storage/repositories/neo-ask-settlement.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

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
    recoveryBillingTerminal = 0,
    session = 'neo'
  ) => {
    seq += 1;
    db.prepare(`INSERT INTO sdk_messages
      (seq, id, session_id, message_type, sdk_message, timestamp, sdk_uuid, consumed_seq,
       is_terminal, send_status, recovery_intercepted, recovery_billing_terminal)
      VALUES (?, ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?, ?)`).run(
      seq,
      `m${seq}`,
      session,
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
  const wakeUuid = (askId: string, which = 0) => {
    const row = db
      .prepare(`SELECT title, (SELECT MAX(updated_at) FROM neo_todos WHERE ask_id = neo_asks.id)
        AS since FROM neo_asks WHERE id = ?`)
      .get(askId) as { title: string; since: number | null } | undefined;
    return neoFinishedAskUuids({
      id: askId,
      title: row?.title ?? askId,
      since: row?.since ?? 1,
    })[which]!;
  };
  const queue = () => new NeoWakeQueueRepository(db);
  const held = (messageUuid: string, sessionId = 'neo', askId = 'ask') =>
    queue().holdOnce(
      createMailboxEntry({
        to: { kind: 'session', sessionId },
        origin: `session:${sessionId}`,
        messageUuid,
        message: {
          type: 'user',
          parent_tool_use_id: null,
          message: { content: 'reminder' },
          inputKind: 'system',
        },
      }),
      `ask.idle:${askId}`
    );
  const wakeNote = (askId: string, batch?: string) => {
    held(`idle-${askId}`, 'neo', askId);
    if (batch) queue().attach('neo', [], undefined, batch);
  };
  const consumedWake = (askId: string, turnEnds = true) => {
    wakeNote(askId, `batch-${askId}`);
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
  const sweep = async () => {
    const ids = await gateway.run(
      DB_OPS.get('neo.turnedAskSettleReads') as DbOp<Record<string, never>, string[]>,
      {}
    );
    return gateway.run(
      DB_OPS.get('neo.turnedAskSettles') as DbOp<{ now: number; ids: string[] }, string[]>,
      { now: 100, ids }
    );
  };
  const touchAsk = (ms: number) =>
    db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(ms, 'ask');

  test('settles done with Neo’s written outcome once the wake turn ends', async () => {
    add('first', 'done');
    add('second', 'removed', { reason: 'Superseded' });
    store.recordAskOutcome('ask', 'Shipped the work', 3);
    consumedWake('ask');
    expect(await sweep()).toEqual(['ask']);
    expect(store.getAsk('ask')).toMatchObject({ status: 'done', outcome: 'Shipped the work' });
    expect(changes).toEqual(['neo_asks']);
  });

  test('skips an ask whose todos changed after the caller checked them', async () => {
    add('design', 'done');
    add('build', 'done');
    sdk('user', wakeUuid('ask'), 10);
    sdk('result', 'first-result', 11);
    const write = DB_OPS.get('neo.turnedAskSettles') as DbOp<
      { now: number; ids: string[]; versions?: Record<string, string> },
      string[]
    >;
    const checked = { ask: neoAskTodosVersion(store.listTodos('ask')) };
    store.updateTodo(store.getTodo('build')!, { state: 'removed', reason: 'Not needed' }, 5);
    expect(await gateway.run(write, { now: 100, ids: ['ask'], versions: checked })).toEqual([]);
    expect(store.getAsk('ask')?.status).toBe('open');
    const fresh = { ask: neoAskTodosVersion(store.listTodos('ask')) };
    expect(await gateway.run(write, { now: 100, ids: ['ask'], versions: fresh })).toEqual([]);
    sdk('user', wakeUuid('ask'), 12);
    sdk('result', 'second-result', 13);
    expect(await gateway.run(write, { now: 100, ids: ['ask'], versions: fresh })).toEqual(['ask']);
  });

  test('generates the outcome from the step list when Neo wrote none', async () => {
    add('alpha', 'done');
    add('gamma', 'removed', { reason: 'Superseded' });
    add('delta', 'failed');
    consumedWake('ask');
    await sweep();
    const ask = store.getAsk('ask')!;
    expect(ask.status).toBe('done');
    expect(ask.outcome).toContain('Step alpha');
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

  test('leaves an ask that never had a todo open', async () => {
    consumedWake('ask');
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
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

  test('a card answered after the wake turn settles the ask once the turn that reads the answer ends', async () => {
    add('finished', 'done');
    sdk('user', wakeUuid('ask'), 20);
    sdk('result', 'wake-result', 21);
    const answeredAt = new Date('2026-01-02').getTime();
    const card = store.askQuestion(
      'card',
      'ask',
      {
        kind: 'yesno',
        text: 'Go?',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        confirm: null,
        document: null,
        replyTo: [],
        todoId: null,
        artifacts: [],
      },
      answeredAt - 1
    );
    store.answerQuestion(card, true as never, 'button', answeredAt);
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    sdk('user', 'answer-note', 30);
    expect(await sweep()).toEqual([]);
    sdk('result', 'answer-result', 31);
    db.prepare(`UPDATE sdk_messages SET timestamp = '2026-01-03T00:00:00.000Z'
      WHERE sdk_uuid IN ('answer-note', 'answer-result')`).run();
    expect(await sweep()).toEqual(['ask']);
  });

  test('an undelivered or unconsumed wake does not settle the ask', async () => {
    add('finished', 'done');
    wakeNote('ask');
    expect(await sweep()).toEqual([]);
    wakeNote('ask', 'unconsumed-batch');
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
    sdk('user', wakeUuid('ask'), 20);
    sdk('result', 'direct-result', 21);
    expect(await sweep()).toEqual(['ask']);
  });

  test('the repeat of the finished wake also counts once its turn ends', async () => {
    add('finished', 'done');
    sdk('user', wakeUuid('ask', 1), 20);
    sdk('result', 'direct-result', 21);
    expect(await sweep()).toEqual(['ask']);
  });

  test('a digest read before the last todo change does not settle the ask', async () => {
    add('removed', 'removed', { reason: 'Not needed' });
    consumedWake('ask');
    db.prepare('UPDATE neo_todos SET updated_at = ? WHERE ask_id = ?').run(
      new Date('2026-01-02').getTime(),
      'ask'
    );
    sdk('user', 'later-turn', 30);
    sdk('result', 'later-result', 31);
    db.prepare(`UPDATE sdk_messages SET timestamp = '2026-01-03T00:00:00.000Z'
      WHERE sdk_uuid IN ('later-turn', 'later-result')`).run();
    expect(await sweep()).toEqual([]);
  });

  test('a wake told before the last todo change does not settle the ask', async () => {
    add('finished', 'done');
    const earlier = wakeUuid('ask');
    db.prepare('UPDATE neo_todos SET updated_at = 2 WHERE ask_id = ?').run('ask');
    sdk('user', earlier, 20);
    sdk('result', 'direct-result', 21);
    expect(await sweep()).toEqual([]);
  });

  const session = (id: string) =>
    db
      .prepare(`INSERT INTO sessions
      (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata)
      VALUES (?,'Neo','general','/synthetic','2026-01-01','2026-01-01','active','{}','{}')`)
      .run(id);
  const coordinator = () => {
    session('coordinator');
    db.prepare(
      "INSERT INTO neo_session_bindings (session_id, concern_id, kind) VALUES ('coordinator', NULL, 'neo')"
    ).run();
  };

  test('a wake read in Neo’s session settles an ask recorded on another session', async () => {
    coordinator();
    add('finished', 'done');
    sdk('user', wakeUuid('ask'), 20, 'consumed', 0, 0, 'coordinator');
    sdk('result', 'coordinator-result', 21, 'consumed', 0, 0, 'coordinator');
    expect(await sweep()).toEqual(['ask']);
  });

  test('a digest read in the session it was held for settles the ask', async () => {
    coordinator();
    session('earlier');
    add('removed', 'removed', { reason: 'Not needed' });
    held('idle-first', 'earlier');
    queue().attach('earlier', [], undefined, 'earlier-batch');
    sdk('user', 'earlier-batch', 20, 'consumed', 0, 0, 'earlier');
    sdk('result', 'earlier-result', 21, 'consumed', 0, 0, 'earlier');
    expect(await sweep()).toEqual(['ask']);
  });

  test('a digest read before the queue cleanup settles the ask once its child settles', async () => {
    add('removed', 'removed', { reason: 'Not needed' });
    held('idle-first');
    queue().attach('neo', [], undefined, 'digest-batch');
    sdk('user', 'digest-batch', 10);
    sdk('result', 'digest-result', 11);
    store.openAsk({
      id: 'child',
      parentId: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Child',
      request: 'Child work',
      createdAt: 2,
    });
    expect(await sweep()).toEqual([]);
    const later = Date.now() + 8 * 24 * 3_600_000;
    const now = spyOn(Date, 'now').mockReturnValue(later);
    const cleaned = await createCleanupHandler(new JobQueueRepository(db))({} as Job);
    now.mockRestore();
    expect(cleaned.deletedJobs).toBe(1);
    store.settleAsk(store.getAsk('child')!, 'done', 'Child done', 3);
    expect(await sweep()).toEqual(['ask']);
  });

  test('a reminder still being read in Neo’s session keeps the ask open', async () => {
    coordinator();
    session('earlier');
    add('removed', 'removed', { reason: 'Not needed' });
    held('idle-first', 'earlier');
    queue().attach('earlier', [], undefined, 'earlier-batch');
    sdk('user', 'earlier-batch', 20, 'consumed', 0, 0, 'earlier');
    sdk('result', 'earlier-result', 21, 'consumed', 0, 0, 'earlier');
    held('idle-repeat', 'coordinator');
    queue().attach('coordinator', [], undefined, 'repeat-batch');
    sdk('user', 'repeat-batch', 30, 'consumed', 0, 0, 'coordinator');
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    sdk('result', 'repeat-result', 31, 'consumed', 0, 0, 'coordinator');
    expect(await sweep()).toEqual(['ask']);
  });

  test('a card answer still being read in the ask’s own session keeps the ask open', async () => {
    coordinator();
    add('finished', 'done');
    sdk('user', wakeUuid('ask'), 20, 'consumed', 0, 0, 'coordinator');
    sdk('result', 'reminder-result', 21, 'consumed', 0, 0, 'coordinator');
    const answeredAt = new Date('2026-01-02').getTime();
    const card = store.askQuestion(
      'card',
      'ask',
      {
        kind: 'yesno',
        text: 'Go?',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        confirm: null,
        document: null,
        replyTo: [],
        todoId: null,
        artifacts: [],
      },
      answeredAt - 1
    );
    store.answerQuestion(card, true as never, 'button', answeredAt);
    sdk('user', 'answer-note', 30);
    sdk('user', 'unrelated', 40, 'consumed', 0, 0, 'coordinator');
    sdk('result', 'unrelated-result', 41, 'consumed', 0, 0, 'coordinator');
    const later = db.prepare(`UPDATE sdk_messages SET timestamp = '2026-01-03T00:00:00.000Z'
      WHERE sdk_uuid = ?`);
    for (const uuid of ['answer-note', 'unrelated', 'unrelated-result']) later.run(uuid);
    const reads = DB_OPS.get('neo.turnedAskSettleReads') as DbOp<Record<string, never>, string[]>;
    const write = DB_OPS.get('neo.turnedAskSettles') as DbOp<
      { now: number; ids: string[] },
      string[]
    >;
    expect(await gateway.run(reads, {})).toEqual([]);
    expect(await gateway.run(write, { now: 100, ids: ['ask'] })).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    sdk('result', 'answer-result', 31);
    later.run('answer-result');
    expect(await sweep()).toEqual(['ask']);
  });

  test('an unfinished turn in Neo’s session keeps the ask open', async () => {
    coordinator();
    add('finished', 'done');
    sdk('user', wakeUuid('ask'), 20, 'consumed', 0, 0, 'coordinator');
    expect(await sweep()).toEqual([]);
  });

  test('a wake for another ask does not settle this one', async () => {
    add('finished', 'done');
    consumedWake('other-ask');
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
  });

  test('a change after the wake turn ended keeps the ask open', async () => {
    add('finished', 'done');
    consumedWake('ask');
    touchAsk(new Date('2026-01-02').getTime());
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
  });

  test('a newer consumed input with no terminal result keeps the ask open', async () => {
    add('finished', 'done');
    consumedWake('ask');
    sdk('user', 'new-turn', 30);
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    sdk('result', 'new-turn-result', 31);
    expect(await sweep()).toEqual(['ask']);
    expect(store.getAsk('ask')).toMatchObject({ status: 'done' });
  });

  test('an open child ask keeps the parent open', async () => {
    add('finished', 'done');
    consumedWake('ask');
    store.openAsk({
      id: 'child',
      parentId: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Child',
      request: 'Child work',
      createdAt: 2,
    });
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'open' });
    store.settleAsk(store.getAsk('child')!, 'done', 'Child done', 3);
    expect(await sweep()).toEqual(['ask']);
  });

  test('a settled ask is left alone', async () => {
    add('finished', 'done');
    consumedWake('ask');
    store.settleAsk(store.getAsk('ask')!, 'dropped', 'Earlier', 4);
    expect(await sweep()).toEqual([]);
    expect(store.getAsk('ask')).toMatchObject({ status: 'dropped', outcome: 'Earlier' });
  });

  test('the sweep stays under 250 ms at live scale', async () => {
    db.prepare(`INSERT INTO sessions
      (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata)
      VALUES ('big','Big','general','/big','2026-01-01','2026-01-01','active','{}','{}')`).run();
    const asks: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < 32; i += 1) {
        const id = `bulk-${i}`;
        asks.push(id);
        store.openAsk({
          id,
          projectId: null,
          sessionId: 'big',
          originMessageId: null,
          title: id,
          request: 'Bulk work',
          createdAt: 1,
        });
        store.addTodo(
          `done-${id}`,
          id,
          { title: `Step ${id}`, doneWhen: 'Done', check: null, instruction: null, named: null },
          1
        );
        db.prepare(`UPDATE neo_todos SET state = 'done' WHERE id = ?`).run(`done-${id}`);
      }
    })();
    const insert = db.prepare(`INSERT INTO sdk_messages
      (seq, id, session_id, message_type, sdk_message, timestamp, sdk_uuid, consumed_seq,
       is_terminal, send_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const bulkSdk = (kind: 'user' | 'result', uuid: string, consumedSeq: number | null) =>
      insert.run(
        (seq += 1),
        `m${seq}`,
        'big',
        kind,
        JSON.stringify({ type: kind }),
        new Date(Date.UTC(2026, 0, 2) + seq).toISOString(),
        uuid,
        consumedSeq,
        kind === 'result' ? 1 : 0,
        'consumed'
      );
    for (let i = 0; i < 1946; i += 1) held(`bulk-note-${i}`, 'big', asks[i % asks.length]!);
    queue().attach('big', [], undefined, 'bulk-batch');
    db.transaction(() => {
      for (let i = 0; i < 86_710; i += 1)
        bulkSdk(i % 2 ? 'result' : 'user', `bulk-msg-${i}`, i + 1);
      for (const id of asks) {
        bulkSdk('user', wakeUuid(id), 87_000);
        bulkSdk('result', `bulk-result-${id}`, 87_001);
      }
    })();
    db.exec('DROP INDEX idx_sdk_messages_session_consumed');
    db.exec('ANALYZE');
    db.exec(`CREATE INDEX idx_sdk_messages_session_consumed
      ON sdk_messages(session_id, consumed_seq)`);
    const started = performance.now();
    const settled = await sweep();
    const elapsed = performance.now() - started;
    expect(settled).toEqual(asks);
    expect(elapsed).toBeLessThan(250);
  }, 30_000);
});
