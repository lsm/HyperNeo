import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import {
  createCodingIssueTracker,
  planCodingIssueHome,
} from '../../../../src/lib/neo/packs/coding/issue-tracker.ts';
import { planNeoTrackerMirror } from '../../../../src/lib/neo/tracker-mirror-plan.ts';
import type { SpawnFn, SpawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';

const ownerCreatedAt = Date.UTC(2026, 0, 1);
let db: Database, store: NeoAskTodoRepository;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'synthetic',
    originMessageId: null,
    title: 'Plan',
    request: 'Private details',
    createdAt: ownerCreatedAt,
  });
});
afterEach(() => db.close());
const add = (id: string, repo: string) => {
  store.addTodo(
    id,
    'ask',
    { title: id, instruction: null, named: null, check: null, doneWhen: 'Done' },
    ownerCreatedAt + 1,
    repo
  );
};
const readTodos = (askId: string) => store.listTodosForAsks([askId]);
const response = (data: unknown): SpawnProcess => ({
  stdout: new Response(JSON.stringify(data)).body,
  stderr: new Response('').body,
  exited: Promise.resolve(0),
  exitCode: 0,
  kill: () => {},
});
const tracker = (
  enabled: (repo: string) => boolean,
  spawn: SpawnFn = () => {
    throw new Error('Unexpected gh');
  }
) =>
  createCodingIssueTracker({
    todos: readTodos,
    createdAt: (marker) => {
      const [, kind, id] = marker.split(':');
      return (kind === 'ask' ? store.getAsk(id!) : store.getTodo(id!))?.createdAt ?? null;
    },
    enabled,
    spawn,
  });
const item = {
  home: 'example/one',
  title: 'Plan',
  body: 'Plan\n\n<!-- hyperneo:ask:ask -->',
  marker: 'hyperneo:ask:ask',
};

test('preference off creates nothing', () => {
  add('one', 'github.com/example/one');
  const adapter = tracker(() => false);
  expect(planNeoTrackerMirror([store.getAsk('ask')!], readTodos('ask'), [], [adapter])).toEqual([]);
});

test('a cross-repo plan has one parent in the first enabled repository', () => {
  add('one', 'github.com/example/one');
  add('two', 'github.com/example/two');
  const adapter = tracker(() => true);
  const plans = planNeoTrackerMirror([store.getAsk('ask')!], readTodos('ask'), [], [adapter]);
  expect(plans.map((plan) => [plan.row.ownerKind, plan.item.home])).toEqual([
    ['ask', 'example/one'],
    ['todo', 'example/one'],
    ['todo', 'example/two'],
  ]);
  expect(
    planCodingIssueHome([{ repo: null }, { repo: 'https://github.com/Example/Two.git' }])
  ).toBe('example/two');
  expect(
    tracker((repo) => repo === 'example/two').home({ kind: 'ask', ask: store.getAsk('ask')! })
  ).toBe('example/two');
});

test('create, marker lookup, sub-issue link and close use REST fields', async () => {
  const calls: string[][] = [];
  const replies: unknown[] = [
    { private: true },
    { id: 10, number: 1 },
    [{ id: 10, number: 1, body: item.body }],
    { id: 20, number: 2 },
    [],
    {},
    {},
    {},
  ];
  const adapter = tracker(
    () => true,
    (args) => {
      calls.push(args);
      return response(replies.shift());
    }
  );
  expect(await adapter.create(item)).toEqual({ ref: 'example/one#1' });
  expect(await adapter.find(item.marker, item.home)).toBe('example/one#1');
  expect(await adapter.link('example/one#1', 'example/two#2')).toBe(true);
  expect(await adapter.close('example/one#1', 'completed')).toBe(true);
  expect(await adapter.close('example/two#2', 'not_planned')).toBe(true);
  expect(calls[1]).toEqual(
    expect.arrayContaining(['repos/example/one/issues', 'title=Plan', `body=${item.body}`])
  );
  expect(calls[5]).toEqual(
    expect.arrayContaining(['repos/example/one/issues/1/sub_issues', 'sub_issue_id=20'])
  );
  expect(calls[6]).toContain('state_reason=completed');
  expect(calls[7]).toContain('state_reason=not_planned');
});

test('an existing sub-issue link is idempotent', async () => {
  let calls = 0;
  const adapter = tracker(
    () => true,
    () => response(++calls === 1 ? { id: 20, number: 2 } : [[{ id: 20, number: 2 }]])
  );
  expect(await adapter.link('example/one#1', 'example/two#2')).toBe(true);
  expect(calls).toBe(2);
});

test('a timed-out create kills its gh subprocess', async () => {
  let finish!: (code: number) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const kill = mock(() => finish(137));
  const adapter = tracker(
    () => true,
    () => {
      if (++calls === 1) return response({ private: true });
      entered();
      return {
        stdout: null,
        stderr: null,
        exited: new Promise((resolve) => {
          finish = resolve;
        }),
        exitCode: null,
        kill,
      };
    }
  );
  jest.useFakeTimers();
  try {
    const creating = adapter.create(item);
    const failed = creating.then(
      () => null,
      (error: unknown) => error
    );
    await started;
    jest.advanceTimersByTime(30_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(await failed).toBeInstanceOf(Error);
  } finally {
    jest.useRealTimers();
  }
});

test('a later gh subprocess is killed at the shared adapter deadline', async () => {
  let finish!: (code: number) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const kill = mock(() => finish(137));
  const adapter = tracker(
    () => true,
    () => {
      if (++calls === 1)
        return {
          ...response({ id: 20, number: 2 }),
          exited: new Promise((resolve) => setTimeout(() => resolve(0), 15_000)),
        };
      entered();
      return {
        stdout: null,
        stderr: null,
        exited: new Promise((resolve) => {
          finish = resolve;
        }),
        exitCode: null,
        kill,
      };
    }
  );
  jest.useFakeTimers();
  try {
    const linking = adapter.link('example/one#1', 'example/two#2');
    const failed = linking.then(
      () => null,
      (error: unknown) => error
    );
    jest.advanceTimersByTime(15_000);
    await started;
    jest.advanceTimersByTime(15_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(await failed).toBeInstanceOf(Error);
  } finally {
    jest.useRealTimers();
  }
});

test('marker recovery paginates issues and ignores pull requests', async () => {
  let pages = 0;
  const adapter = tracker(
    () => true,
    () =>
      response(
        ++pages === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: index,
              number: index + 1,
              body: item.body,
              pull_request: {},
            }))
          : [{ id: 101, number: 101, body: item.body }]
      )
  );
  expect(await adapter.find(item.marker, item.home)).toBe('example/one#101');
  expect(pages).toBe(2);
});

test('a failed recovery lookup throws instead of allowing a duplicate create', async () => {
  const adapter = tracker(
    () => true,
    () => ({
      stdout: null,
      stderr: new Response('Permission denied').body,
      exited: Promise.resolve(1),
      exitCode: 1,
      kill: () => {},
    })
  );
  await expect(adapter.find(item.marker, item.home)).rejects.toThrow('Permission denied');
});

test('recovery bounds history by the recorded owner creation time', async () => {
  let request: string[] = [];
  const adapter = tracker(
    () => true,
    (args) => {
      request = args;
      return response([]);
    }
  );
  expect(await adapter.find(item.marker, item.home)).toBeNull();
  expect(request).toContain('since=2025-12-31T00:00:00Z');
});

test('a public repository creates nothing and reports public_repository', async () => {
  const calls: string[][] = [];
  const adapter = tracker(
    () => true,
    (args) => {
      calls.push(args);
      return response(args.includes('POST') ? { id: 10, number: 1 } : { private: false });
    }
  );
  expect(await adapter.create(item)).toEqual({
    reason: 'public_repository: issue mirroring is for private repositories only',
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('repos/example/one');
  expect(calls[0]).not.toContain('POST');
  expect(calls[0]).not.toContain(`body=${item.body}`);
});

test('a private repository creates as before', async () => {
  const calls: string[][] = [];
  const adapter = tracker(
    () => true,
    (args) => {
      calls.push(args);
      return response(args.includes('POST') ? { id: 10, number: 1 } : { private: true });
    }
  );
  expect(await adapter.create(item)).toEqual({ ref: 'example/one#1' });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('repos/example/one');
  expect(calls[1]).toEqual(
    expect.arrayContaining(['repos/example/one/issues', 'POST', `body=${item.body}`])
  );
});

test('recovery finds a marker when the owner clock is five minutes ahead', async () => {
  const issueUpdatedAt = ownerCreatedAt - 5 * 60_000;
  const adapter = tracker(
    () => true,
    (args) => {
      const since = args.find((arg) => arg.startsWith('since='))!.slice('since='.length);
      return response(
        Date.parse(since) <= issueUpdatedAt ? [{ id: 10, number: 1, body: item.body }] : []
      );
    }
  );
  expect(await adapter.find(item.marker, item.home)).toBe('example/one#1');
});
