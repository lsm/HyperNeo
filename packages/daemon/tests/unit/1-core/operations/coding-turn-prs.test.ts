import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  createCodingTodoPack,
  CodingTodoPrRepository,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { codingTurnSessionKey } from '../../../../src/lib/neo/packs/coding/turn-owner.ts';
import { CodingTurnPrRepository } from '../../../../src/lib/neo/packs/coding/turn-prs.ts';
import { readDriverOutcome } from '../../../../src/lib/neo/driver-work.ts';
import { readCodexTurnFacts } from '../../../../src/lib/drivers/codex-turn-reader.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordWorkTurns,
  WorkTurnRepository,
} from '../../../../src/storage/repositories/work-turn-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';

const url = 'https://github.com/acme/app/pull/7';
const ref = { adapter: 'hyperneo', id: 'worker' };
const fact = (id: string, inputs: string[], urls: string[], start: number, change = {}) => ({
  id,
  startedAt: start,
  endedAt: start + 10,
  ended: 'success',
  inputs,
  urls,
  finalUrls: urls,
  complete: true,
  cursor: `{"at":${start}}`,
  ...change,
});

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const send = (id: string, todoId: string, inputId: string) =>
    db
      .prepare(
        `INSERT INTO work_delivery_inputs
          (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
         VALUES (?, ?, 'neo', '{}', 'work', 1, 2, ?)`
      )
      .run(id, todoId, JSON.stringify({ ref, receipt: { executionId: 'worker', inputId } }));
  const record = (...turns: ReturnType<typeof fact>[]) =>
    recordWorkTurns.run(db, { ref, turns }, undefined as never);
  return { db, send, record };
}

const ledger = (db: Database, createdAt: number) =>
  db
    .prepare(
      `INSERT INTO pack_coding_pr_ledger
        (repo, number, title, branch, head, state, state_since, read_at, created_at)
       VALUES ('acme/app', 7, 't', 'b', 'h', 'open', 1, 1, ?)`
    )
    .run(createdAt);

const todo = (id: string) =>
  ({
    id,
    check: { pack: 'coding', kind: 'pr_merged', params: {} },
    report: null,
    startedAt: 1,
  }) as unknown as NeoTodo;

const merged = (createdAt: number) =>
  ({ url, title: 't', state: 'MERGED', createdAt, mergedAt: 500 }) as NeoWorkPr;

describe('coding turn PRs', () => {
  test('finds every turn showing a PR by URL, across sessions, without a scan', () => {
    const { db, record } = setup();
    record(fact('t1', [], [`${url}/files`], 100), fact('t2', [], ['https://x.test/a'], 200));
    const turns = new WorkTurnRepository(db);
    expect(
      turns.mentioning([url.replace('acme', 'ACME').toLowerCase()]).map(({ id }) => id)
    ).toEqual(['t1']);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT ref, turn_id FROM work_turn_urls WHERE url >= 'a' AND url <= 'b'"
      )
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join()).toContain('USING');
    db.close();
  });

  test('a URL matches whichever scheme the turn showed it with', () => {
    const { db, record } = setup();
    record(fact('t1', [], [url.replace('https:', 'http:')], 100));
    expect(new WorkTurnRepository(db).mentioning([url]).map(({ id }) => id)).toEqual(['t1']);
    db.close();
  });

  test('a turn showing two looked-up URLs comes back once', () => {
    const { db, record } = setup();
    const other = 'https://github.com/acme/app/pull/8';
    record(fact('t1', [], [url, other], 100));
    expect(new WorkTurnRepository(db).mentioning([url, other]).map(({ id }) => id)).toEqual(['t1']);
    db.close();
  });

  test('recording a turn never scans the URL index', () => {
    const { db, record } = setup();
    const plans: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('DELETE FROM work_turn_urls')) plans.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    record(fact('t1', [], [url], 100));
    expect(plans).toEqual([]);
    db.close();
  });

  test('a re-recorded turn reads back with its current URLs', () => {
    const { db, record } = setup();
    record(fact('t1', [], [url], 100));
    record(fact('t1', [], ['https://x.test/other'], 100));
    const [turn] = new WorkTurnRepository(db).mentioning([url]);
    expect(turn.urls).toEqual(['https://x.test/other']);
    db.close();
  });

  test('own turns follow the todo receipts and an aborted turn', () => {
    const { db, send, record } = setup();
    send('d1', 'a', 'receipt-a');
    record(
      fact('t1', ['receipt-a'], [], 100, { ended: 'aborted' }),
      fact('t2', [], [url], 120),
      fact('t3', ['someone-else'], [url], 140)
    );
    expect(new CodingTurnPrRepository(db).own('a').map(({ id }) => id)).toEqual(['t1', 't2']);
    db.close();
  });

  test('reads pending receipts without their offset and Codex sends by turn id', () => {
    const { db, send, record } = setup();
    send('d1', 'a', 'desktop-pending:120:abc123');
    db.prepare(
      `INSERT INTO work_delivery_inputs
        (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
       VALUES ('d2', 'b', 'neo', '{}', 'work', 1, 2, ?)`
    ).run(JSON.stringify({ ref, delivery: { startedTurnId: 't2' } }));
    record(fact('t1', ['desktop-pending:abc123'], [url], 100), fact('t2', [], [url], 200));
    const turns = new CodingTurnPrRepository(db);
    expect(turns.own('a').map(({ id }) => id)).toEqual(['t1']);
    expect(turns.own('b').map(({ id }) => id)).toEqual(['t2']);
    expect(turns.mentions([url]).todos[codingTurnSessionKey(ref)]).toMatchObject({
      'desktop-pending:abc123': 'a',
      t2: 'b',
    });
    db.close();
  });

  test('a Codex start whose rollout read missed gives its todo by the opening turn id', () => {
    const { db, record } = setup();
    const outcome = readDriverOutcome(
      {
        verb: 'start',
        adapter: 'codex-desktop',
        place: { machine: 'laptop', folder: '/w', name: 'w' },
      },
      { kind: 'completed', value: { ok: true, value: { ref, startedTurnId: 't-open' } } }
    );
    db.prepare(
      `INSERT INTO work_delivery_inputs
        (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
       VALUES ('d1', 'a', 'neo', '{}', 'work', 1, 2, ?)`
    ).run(JSON.stringify(outcome));
    record(fact('t-open', [], [url], 100), fact('t-later', [], [url], 200));
    expect(new CodingTurnPrRepository(db).own('a').map(({ id }) => id)).toEqual(['t-open']);
    db.close();
  });

  test('queued Codex sends give their todos by the client id of the turn they ran in', async () => {
    const { db } = setup();
    const dir = mkdtempSync(join(tmpdir(), 'codex-queued-'));
    const rollout = join(dir, 'rollout.jsonl');
    const at = (second: number) => `2026-11-27T04:00:${String(second).padStart(2, '0')}.000Z`;
    const event = (second: number, payload: object) =>
      JSON.stringify({ timestamp: at(second), type: 'event_msg', payload });
    const user = (second: number, id: string, text: string) =>
      JSON.stringify({
        timestamp: at(second),
        type: 'response_item',
        payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
      });
    const ran = (second: number, turn: string, clientId: string, text: string) =>
      event(second, {
        type: 'item_completed',
        thread_id: 'thread',
        turn_id: turn,
        item: {
          type: 'UserMessage',
          id: `item-${second}`,
          client_id: clientId,
          content: [{ type: 'text', text, text_elements: [] }],
        },
      });
    writeFileSync(
      rollout,
      `${[
        event(1, { type: 'task_started', turn_id: 'turn-a' }),
        user(2, 'msg_a', 'first queued'),
        ran(3, 'turn-a', 'client-a', 'first queued'),
        event(4, { type: 'task_complete', turn_id: 'turn-a', last_agent_message: url }),
        event(5, { type: 'task_started', turn_id: 'turn-b' }),
        user(6, 'msg_b', 'second queued'),
        ran(7, 'turn-b', 'client-b', 'second queued'),
        event(8, { type: 'task_complete', turn_id: 'turn-b', last_agent_message: url }),
      ].join('\n')}\n`
    );
    const codex = { adapter: 'codex-desktop', id: 'thread' };
    const queue = (id: string, todoId: string, clientMessageId: string) =>
      db
        .prepare(
          `INSERT INTO work_delivery_inputs
            (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
           VALUES (?, ?, 'neo', '{}', 'work', 1, 2, ?)`
        )
        .run(
          id,
          todoId,
          JSON.stringify(
            readDriverOutcome(
              { verb: 'send', ref: codex },
              {
                kind: 'completed',
                value: {
                  ok: true,
                  value: { delivered: false, queuedSubmissionId: `q-${id}`, clientMessageId },
                },
              }
            )
          )
        );
    queue('d1', 'a', 'client-a');
    queue('d2', 'b', 'client-b');
    recordWorkTurns.run(
      db,
      { ref: codex, turns: await readCodexTurnFacts(rollout) },
      undefined as never
    );
    const turns = new CodingTurnPrRepository(db);
    expect(turns.own('a').map(({ id }) => id)).toEqual(['turn-a']);
    expect(turns.own('b').map(({ id }) => id)).toEqual(['turn-b']);
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  test('pr_merged passes on the PR the todo produced in its own turn', async () => {
    const { db, send, record } = setup();
    send('d1', 'a', 'receipt-a');
    send('d2', 'b', 'receipt-b');
    record(fact('t1', ['receipt-a'], [url], 100), fact('t2', ['receipt-b'], [url], 200));
    const pack = createCodingTodoPack(new CodingTodoPrRepository(db), async () => [merged(105)]);
    const facts = await pack.readFacts(todo('a'), false);
    expect(facts?.prs).toHaveLength(1);
    expect((await pack.readFacts(todo('b'), false))?.prs).toEqual([]);
    db.close();
  });

  test('a PR the check names keeps its named claim', async () => {
    const { db, send, record } = setup();
    db.exec('PRAGMA foreign_keys = OFF');
    send('d1', 'a', 'receipt-a');
    record(fact('t1', ['receipt-a'], [url], 100));
    const pack = createCodingTodoPack(new CodingTodoPrRepository(db), async () => [merged(105)]);
    const named = {
      ...todo('a'),
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
    };
    expect((await pack.readFacts(named as NeoTodo))?.prs.map((pr) => pr.url)).toEqual([url]);
    db.close();
  });

  test('a todo is linked only to the PR its own turn produced', () => {
    const { db, send, record } = setup();
    db.exec('PRAGMA foreign_keys = OFF');
    send('d1', 'a', 'receipt-a');
    send('d2', 'b', 'receipt-b');
    record(fact('t1', ['receipt-a'], [url], 100), fact('t2', ['receipt-b'], [url], 200));
    ledger(db, 105);
    const prs = new CodingTodoPrRepository(db);
    expect(prs.linked('a', url)).toBe(true);
    expect(prs.linked('b', url)).toBe(false);
    db.close();
  });

  test('a PR the ledger has not seen is not linked by a turn', () => {
    const { db, send, record } = setup();
    send('d1', 'a', 'receipt-a');
    record(fact('t1', ['receipt-a'], [url], 100));
    expect(new CodingTodoPrRepository(db).linked('a', url)).toBe(false);
    db.close();
  });

  test('a bound todo owns the turn running at its bind, with no delivery row', async () => {
    const { db, record } = setup();
    db.exec('PRAGMA foreign_keys = OFF');
    record(fact('t1', ['typed'], [url], 100), fact('t0', ['typed'], [url], 50));
    new NeoTodoSessionRepository(db).bind('c', ref, 105);
    const turns = new CodingTurnPrRepository(db);
    expect(turns.own('c').map(({ id }) => id)).toEqual(['t1']);
    expect(turns.mentions([url]).turns.find(({ id }) => id === 't1')?.bound).toMatchObject([
      { todo: 'c', boundAt: 105 },
    ]);
    const pack = createCodingTodoPack(new CodingTodoPrRepository(db), async () => [merged(105)]);
    expect((await pack.readFacts(todo('c'), false))?.prs).toHaveLength(1);
    db.close();
  });

  test('a human turn after the bind keeps a bound todo open', async () => {
    const { db, record } = setup();
    db.exec('PRAGMA foreign_keys = OFF');
    record(fact('t1', ['typed'], [url], 100));
    new NeoTodoSessionRepository(db).bind('c', ref, 50);
    const pack = createCodingTodoPack(new CodingTodoPrRepository(db), async () => [merged(105)]);
    expect((await pack.readFacts(todo('c'), false))?.incomplete).toBe(true);
    db.close();
  });

  test('both reads run on the read-only lane', () => {
    const { db, send, record } = setup();
    send('d1', 'a', 'receipt-a');
    record(fact('t1', ['receipt-a'], [url], 100));
    db.exec('PRAGMA query_only=ON');
    const turns = new CodingTurnPrRepository(db);
    expect(turns.own('a')).toHaveLength(1);
    expect(turns.mentions([url]).turns).toHaveLength(1);
    db.exec('PRAGMA query_only=OFF');
    db.close();
  });

  test('an unread turn keeps the check open', async () => {
    const { db, send, record } = setup();
    send('d1', 'a', 'receipt-a');
    record(fact('t1', ['receipt-a'], [url], 100, { complete: false }));
    const pack = createCodingTodoPack(new CodingTodoPrRepository(db), async () => [merged(105)]);
    const facts = await pack.readFacts(todo('a'), false);
    expect(facts?.incomplete).toBe(true);
    expect(pack.judge(todo('a'), facts!)).toEqual({ state: 'no_opinion' });
    db.close();
  });

  test('a todo with no recorded turns keeps the claims path', async () => {
    const { db } = setup();
    const repo = new CodingTodoPrRepository(db);
    const pack = createCodingTodoPack(repo, async () => []);
    expect(await pack.readFacts(todo('a'), false)).toMatchObject({ prs: [] });
    db.close();
  });
});
