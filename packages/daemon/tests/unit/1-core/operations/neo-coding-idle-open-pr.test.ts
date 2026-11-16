import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { NEO_ATTENTION_KINDS } from '../../../../src/lib/neo/attention/decide.ts';
import { createNeoAttentionSweep } from '../../../../src/lib/neo/attention/sweep.ts';
import {
  createNeoAttention,
  neoAttentionDelivery,
} from '../../../../src/lib/neo/attention/tell.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import {
  CODING_ATTENTION_KINDS,
  scanCodingIdleOpenPrs,
} from '../../../../src/lib/neo/packs/coding/attention.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const HOUR = 3_600_000;
const T0 = 1_000_000;
const ROOT = 'neo:root';
const URL = 'https://github.com/acme/app/pull/7';
const ref = { adapter: 'hyperneo', id: 'worker-1' };
const LINE =
  'Todo "Ship it" (todo-1) has an idle worker and an open pull request: https://github.com/acme/app/pull/7 (waiting for review). Continue its worker if the pull request needs work; otherwise it waits on review, CI or the merge.';

describe('coding.idle_with_open_pr through the Neo attention sweep', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let sweep: (now: number) => Promise<void>;

  const told = (queue: 'mailbox' | 'neo_notes') =>
    (
      db.prepare('SELECT payload FROM job_queue WHERE queue = ?').all(queue) as {
        payload: string;
      }[]
    ).map((row) => String(JSON.parse(row.payload).message.message.content));
  const live = (todoId: string, status: string, since = T0) =>
    sessions.recordNudge(todoId, { since, nudges: 0, live: status });
  const ledger = (state: string, since: number, closedAt: number | null = null) =>
    db
      .prepare(
        `INSERT INTO pack_coding_pr_ledger
           (repo, number, title, branch, head, state, state_since, closed_at, read_at)
         VALUES ('acme/app', 7, 'Ship it', 'ship', 'abc1234', ?, ?, ?, ?)
         ON CONFLICT(repo, number) DO UPDATE SET state = excluded.state,
           state_since = excluded.state_since, closed_at = excluded.closed_at`
      )
      .run(state, since, closedAt, since);

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db, T0);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    const prs = new CodingTodoPrRepository(db);
    store.openAsk({
      id: 'ask-1',
      title: 'Cache layer',
      request: 'Build the cache layer',
      sessionId: ROOT,
      projectId: null,
      originMessageId: null,
      createdAt: T0,
    });
    const todo: NeoTodo = store.addTodo(
      'todo-1',
      'ask-1',
      {
        title: 'Ship it',
        doneWhen: 'Merged',
        check: null,
        named: null,
        instruction: 'Ship the change.',
        approvedAt: T0,
        dependsOn: [],
      },
      T0
    );
    sessions.create(todo.id, { verb: 'send', ref });
    sessions.recordRef(todo.id, ref, T0);
    store.updateTodo(todo, { state: 'doing', startedAt: T0 }, T0);
    live(todo.id, 'done');
    prs.record(todo.id, [{ url: URL, state: 'OPEN' } as never], T0);
    ledger('waiting_review', T0);
    const packs = [
      {
        id: 'coding',
        todos: { waiting: (todos: NeoTodo[]) => prs.readWaiting(todos.map((item) => item.id)) },
        attention: { kinds: CODING_ATTENTION_KINDS, scan: scanCodingIdleOpenPrs(prs) },
      } as never as NeoPack,
    ];
    sweep = createNeoAttentionSweep({
      sessions,
      packs: () => packs,
      limits: () => ({ running: 6, perGroup: 3 }),
      scan: (now, waiting) =>
        Promise.all(packs.map((pack) => pack.attention?.scan?.(now, waiting) ?? [])).then((lists) =>
          lists.flat()
        ),
      tell: createNeoAttention({
        kinds: () => [...NEO_ATTENTION_KINDS, ...CODING_ATTENTION_KINDS],
        read: () => ({ covered: false, latestReportAt: null }),
        ...neoAttentionDelivery(
          db,
          () => ROOT,
          () => false
        ),
        dropped: () => {},
      }),
      failed: (_event, error) => {
        throw error;
      },
    });
  });
  afterEach(() => db.close());

  test('an idle worker with an open pull request is one digest line, and one more after 4 hours', async () => {
    for (const hours of [0, 0.5, 1, 3.9]) await sweep(T0 + hours * HOUR);
    expect(told('neo_notes')).toEqual([LINE]);
    for (const hours of [4, 5, 24]) await sweep(T0 + hours * HOUR);
    expect(told('neo_notes')).toEqual([LINE, LINE]);
    expect(told('mailbox')).toEqual([]);
  });

  test('a running worker is no message', async () => {
    live('todo-1', 'running');
    await sweep(T0);
    expect([told('neo_notes'), told('mailbox')]).toEqual([[], []]);
  });

  test('a pull request that changes state restarts the ladder with its new state', async () => {
    await sweep(T0);
    ledger('failing', T0 + HOUR);
    await sweep(T0 + HOUR);
    await sweep(T0 + 2 * HOUR);
    expect(told('neo_notes')).toEqual([LINE, LINE.replace('(waiting for review)', '(failing CI)')]);
  });

  test('a merged pull request is no message', async () => {
    ledger('merged', T0, T0);
    new CodingTodoPrRepository(db).record('todo-1', [{ url: URL, state: 'MERGED' } as never], T0);
    await sweep(T0);
    await sweep(T0 + 4 * HOUR);
    expect(told('neo_notes')).toEqual([]);
  });
});
