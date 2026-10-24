import { afterEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const close: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of close.splice(0).reverse()) fn();
});
const MIN = 60_000;
const pr = 'https://github.com/synthetic/plan/pull/4';
const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coding-issues-'));
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  let db: Database, store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository;
  let pack: ReturnType<typeof createCodingPack>, runner: ReturnType<typeof createNeoTodoRunner>;
  let now = 100_000,
    progress = now,
    reachable = true;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let issue: (NeoRefState & { stateReason?: string; closingPrs?: string[] }) | null = null;
  const calls: string[] = [],
    notes: string[] = [];
  const open = () => {
    db = new Database(join(directory, 'state.db'));
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    if (!store.getAsk('ask'))
      store.openAsk({
        id: 'ask',
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Synthetic plan',
        request: 'Two stages',
        createdAt: now,
      });
    pack = createCodingPack({
      database: () => db,
      todoPrs: new CodingTodoPrRepository(db),
      prLedger: new CodingPrLedgerRepository(db),
      prSweep: new CodingPrSweepRepository(db),
      prEvents: new CodingPrEventRepository(db),
      prSweepDeps: { tell: async () => true, wake: async () => true },
      readPrs: async (urls) =>
        urls.map((url) => ({ url, state: 'MERGED', checks: 'passing', review: 'approved' })),
      readRefStates: async (refs) =>
        refs[0]?.number === 1
          ? issue
            ? [issue]
            : []
          : [
              {
                kind: 'issue',
                url: 'https://github.com/synthetic/plan/issues/2',
                state: 'OPEN',
                done: false,
                closedBy: null,
                at: null,
              },
            ],
      projectRepos: () => [],
    });
    pack.todos!.schema(db);
    runner = createNeoTodoRunner({
      store,
      sessions,
      packs: () => [pack],
      changed: () => {},
      tell: async (_ask, _todo, text) => {
        notes.push(text);
      },
      invoke: async (_caller, name) => {
        calls.push(name);
        return {
          kind: 'completed',
          value:
            name === 'work.start'
              ? { ok: true, value: { ref, lastActivityAt: now } }
              : name === 'work.send'
                ? { ok: reachable }
                : {
                    ok: true,
                    value: { status: 'stopped', lastActivityAt: progress, lastReplyAt: progress },
                  },
        };
      },
    });
  };
  open();
  close.push(() => db.close());
  const warn = (_message: string, error: unknown) => {
    throw error;
  };
  return {
    calls,
    notes,
    get store() {
      return store;
    },
    get pack() {
      return pack;
    },
    add(id: string, doing = false) {
      const todo = store.addTodo(
        id,
        'ask',
        {
          title: id,
          doneWhen: 'Issue completed',
          check: {
            pack: 'coding',
            kind: 'issue_closed',
            params: { issue: id === 'next' ? 'synthetic/plan#2' : 'synthetic/plan#1' },
          },
          instruction: 'Synthetic stage',
          named: null,
        },
        now
      );
      sessions.create(id, {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'laptop', name: 'synthetic', folder: '/synthetic' },
      });
      if (doing) {
        sessions.recordRef(id, ref, now);
        store.updateTodo(
          todo,
          { state: 'doing', startedAt: now, report: 'Retain complete report 🦊' },
          now
        );
      }
      return store.getTodo(id)!;
    },
    issue(state: 'OPEN' | 'COMPLETED' | 'NOT_PLANNED' | null, links = [pr]) {
      issue =
        state === null
          ? null
          : {
              kind: 'issue',
              url: 'https://github.com/synthetic/plan/issues/1',
              state: state === 'OPEN' ? 'OPEN' : 'CLOSED',
              done: state === 'COMPLETED',
              stateReason: state === 'OPEN' ? undefined : state,
              closedBy: null,
              at: now,
              closingPrs: links,
            };
    },
    at: async (minutes: number) => {
      now = 100_000 + minutes * MIN;
      await runner.refresh(warn);
    },
    restart() {
      db.close();
      open();
    },
    edit() {
      store.updateTodo(store.getTodo('first')!, { title: 'Edited metadata' }, now);
    },
    progress() {
      progress = now;
    },
    unreachable() {
      reachable = false;
    },
    linked: () => new CodingTodoPrRepository(db).prs('first'),
  };
}

test.each(['Could not start: needs_you', 'Failed twice: unavailable'])(
  'an inconclusive coding check preserves failure block %s across restart',
  async (blockedReason) => {
    const f = fixture();
    const todo = f.add('first');
    f.store.updateTodo(todo, { state: 'blocked', blockedBy: 'failure', blockedReason }, 100_000);
    f.issue('OPEN');
    await f.at(2);
    f.restart();
    await f.at(4);
    expect(f.store.getTodo('first')).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason,
    });
    expect(f.calls).toEqual([]);
  }
);

test.each(['worker', 'check'] as const)(
  'a stale %s block clears without a current blocker',
  async (blockedBy) => {
    const f = fixture();
    const todo = f.add('first', true);
    f.store.updateTodo(todo, { state: 'blocked', blockedBy }, 100_000);
    f.issue('OPEN');
    await f.at(2);
    expect(f.store.getTodo('first')).toMatchObject({ state: 'doing', blockedBy: null });
  }
);

test('a COMPLETED issue advances its next todo before a stopped worker can be nudged', async () => {
  const f = fixture();
  f.add('first', true);
  f.add('next');
  f.issue('COMPLETED', []);
  await f.at(120);
  expect(f.store.getTodo('first')).toMatchObject({
    state: 'done',
    report: 'Retain complete report 🦊',
  });
  expect(f.store.getTodo('next')?.state).toBe('doing');
  expect(f.calls.filter((name) => name === 'work.start')).toHaveLength(1);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(0);
  f.restart();
  await f.at(121);
  expect(f.calls.filter((name) => name === 'work.start')).toHaveLength(1);
});

test.each(['NOT_PLANNED', 'OPEN', null] as const)(
  '%s never completes or advances the coding plan',
  async (state) => {
    const f = fixture();
    f.add('first', true);
    f.add('next');
    f.issue(state);
    await f.at(10);
    expect(f.store.getTodo('first')?.state).toBe(state === 'NOT_PLANNED' ? 'failed' : 'doing');
    expect(f.store.getTodo('next')?.state).toBe('todo');
  }
);

test('GitHub closing links supply PR membership, not worker claims or PR merge alone', async () => {
  const f = fixture();
  const todo = f.add('first', true);
  f.issue('OPEN');
  await f.pack.todos!.openedPrs!(todo, ['https://github.com/synthetic/plan/pull/99']);
  await f.at(1);
  expect(f.linked().map((row) => row.url)).toEqual([pr]);
  expect(f.store.getTodo('first')?.state).toBe('doing');
});

test.each(['', 'synthetic/plan#0', '#1', 'synthetic/plan#1oops', 'a/b/c#1'])(
  'invalid issue reference %s is refused',
  (issue) => {
    const f = fixture();
    expect(
      f.pack.todos!.refuse!({
        check: { pack: 'coding', kind: 'issue_closed', params: { issue } },
        instruction: 'Stage',
      })
    ).toContain('issue_closed_invalid_issue');
  }
);

test('20/40/60 reminders persist across reopen, ignore metadata edits, and never block', async () => {
  const f = fixture();
  f.add('first', true);
  f.issue('OPEN', []);
  await f.at(19);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(0);
  await f.at(20);
  f.edit();
  f.restart();
  await f.at(21);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(1);
  await f.at(40);
  f.restart();
  await f.at(60);
  await f.at(120);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(2);
  expect(f.notes.filter((text) => text.includes('without progress'))).toHaveLength(1);
  expect(f.store.getTodo('first')?.state).toBe('doing');
  f.progress();
  await f.at(139);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(2);
  await f.at(140);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(3);
});

test('unreachable reminder delivery escalates without turning time into a block fact', async () => {
  const f = fixture();
  f.add('first', true);
  f.issue('OPEN', []);
  f.unreachable();
  await f.at(20);
  expect(f.store.getTodo('first')?.state).toBe('doing');
  expect(f.notes.some((text) => text.includes('could not be reached'))).toBe(true);
});

test('a first refresh after 60 minutes escalates without inventing sent reminders', async () => {
  const f = fixture();
  f.add('first', true);
  f.issue('OPEN', []);
  await f.at(60);
  expect(f.calls.filter((name) => name === 'work.send')).toHaveLength(0);
  expect(f.notes.filter((text) => text.includes('without progress'))).toHaveLength(1);
  expect(f.notes.some((text) => text.includes('two reminders'))).toBe(false);
  expect(f.store.getTodo('first')?.state).toBe('doing');
});

test('issue judgement uses CLOSED/COMPLETED even without PR, review or deploy evidence', async () => {
  const f = fixture();
  const todo = f.add('first', true);
  f.issue('COMPLETED', []);
  const facts = await f.pack.readFacts!(todo);
  expect(facts).toMatchObject({ prs: [], issue: { state: 'CLOSED', stateReason: 'COMPLETED' } });
  expect(f.pack.judge!(todo, facts)).toEqual({
    state: 'done',
    evidence: 'https://github.com/synthetic/plan/issues/1 completed',
  });
  expect(await f.pack.todos!.check(todo)).toEqual({
    done: true,
    evidence: 'https://github.com/synthetic/plan/issues/1 completed',
  });
  expect(f.store.getTodo(todo.id)?.state).toBe('doing');
});

test.each([
  ['OPEN', 'COMPLETED', true],
  ['CLOSED', undefined, true],
  ['CLOSED', 'REOPENED', true],
])('issue %s/%s ignores the reader done flag %s', async (state, stateReason, done) => {
  const f = fixture();
  const todo = f.add('first', true);
  f.issue('COMPLETED');
  const facts = await f.pack.readFacts!(todo);
  expect(facts).toMatchObject({ issue: { state: 'CLOSED' } });
  const captured = facts as { issue: NeoRefState };
  expect(
    f.pack.judge!(todo, {
      ...captured,
      issue: { ...captured.issue, state, stateReason, done },
    })
  ).toEqual({ state: 'no_opinion' });
});
