import { Logger } from '../../../../src/lib/logger.ts';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTrackerMirrorRepository } from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import {
  planNeoTrackerMirror,
  neoTrackerMarker,
  readNeoTrackerMarker,
} from '../../../../src/lib/neo/tracker-mirror-plan.ts';
import { sweepNeoTrackerMirrors } from '../../../../src/lib/neo/tracker-mirror.ts';
import type { NeoTrackerAdapter } from '../../../../src/lib/neo/pack-contract.ts';

let db: Database, todos: NeoAskTodoRepository, mirrors: NeoTrackerMirrorRepository;
let creates: string[], closed: string[], links: string[];
let adapter: NeoTrackerAdapter;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  todos = new NeoAskTodoRepository(db);
  mirrors = new NeoTrackerMirrorRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Plan',
    request: 'Implement',
    createdAt: 1,
  });
  creates = [];
  closed = [];
  links = [];
  adapter = {
    id: 'fixture',
    enabled: () => true,
    home: () => 'example/repo',
    find: async () => null,
    create: async (item) => {
      creates.push(item.marker);
      return { ref: `${item.home}#${creates.length}` };
    },
    link: async (parent, child) => {
      links.push(`${parent}:${child}`);
      return true;
    },
    close: async (ref) => {
      closed.push(ref);
      return true;
    },
  };
});
afterEach(() => db.close());
const addTodo = (id: string) =>
  todos.addTodo(
    id,
    'ask',
    { title: id, instruction: null, named: null, check: null, doneWhen: 'Done' },
    2
  );

test('no enabled adapter plans nothing', () => {
  const facts = mirrors.facts();
  expect(
    planNeoTrackerMirror(facts.asks, facts.todos, facts.mirrors, [
      { ...adapter, enabled: () => false },
    ])
  ).toEqual([]);
});

test('crash after create binds by marker instead of creating twice', async () => {
  mirrors.put({
    ownerKind: 'ask',
    ownerId: 'ask',
    tracker: 'fixture',
    home: 'stored/home',
    ref: null,
    parentRef: null,
    state: 'creating',
    failures: 0,
    updatedAt: 1,
  });
  adapter.home = () => 'changed/home';
  const finds: string[][] = [];
  adapter.find = async (marker, home) => {
    finds.push([marker, home]);
    return 'stored/home#1';
  };
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(finds).toEqual([['hyperneo:ask:ask', 'stored/home']]);
  expect(creates).toHaveLength(0);
  expect(mirrors.facts().mirrors[0]).toMatchObject({
    home: 'stored/home',
    ref: 'stored/home#1',
    state: 'bound',
  });
});

test('a late step gets its child on the next sweep', async () => {
  await sweepNeoTrackerMirrors(db, [adapter]);
  addTodo('late');
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(creates).toEqual(['hyperneo:ask:ask', 'hyperneo:todo:late']);
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(creates).toHaveLength(2);
  expect(links).toContain('example/repo#1:example/repo#2');
});

test('settled ask closes its parent', async () => {
  await sweepNeoTrackerMirrors(db, [adapter]);
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(closed).toEqual(['example/repo#1']);
  expect(mirrors.facts().mirrors).toEqual([]);
});

test('lookup failure preserves creating state and records one failed sweep', async () => {
  adapter.find = async () => {
    throw new Error('Unavailable');
  };
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(creates).toHaveLength(0);
  expect(mirrors.facts().mirrors[0]).toMatchObject({ state: 'creating', failures: 1 });
});

test('marker survives the tracker body', () => {
  const owner = { kind: 'ask' as const, ask: todos.getAsk('ask')! };
  const marker = neoTrackerMarker(owner);
  expect(marker).toBe('hyperneo:ask:ask');
  expect(readNeoTrackerMarker(`Body\n<!-- ${marker} -->`)).toBe(marker);
  expect(readNeoTrackerMarker('No marker')).toBeNull();
});

test('a successful link is persisted and never repeated', async () => {
  addTodo('child');
  await sweepNeoTrackerMirrors(db, [adapter]);
  await sweepNeoTrackerMirrors(db, [adapter]);
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(links).toHaveLength(1);
});

test('a failed child close leaves the parent open', async () => {
  addTodo('child');
  await sweepNeoTrackerMirrors(db, [adapter]);
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  adapter.close = async () => ({ reason: 'Unavailable' });
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(mirrors.facts().mirrors.find((row) => row.ownerKind === 'ask')?.state).toBe('bound');
  expect(mirrors.facts().mirrors.find((row) => row.ownerKind === 'todo')?.failures).toBe(1);
});

test('a final todo closes once and is not recreated after becoming active', async () => {
  addTodo('child');
  await sweepNeoTrackerMirrors(db, [adapter]);
  const outcomes: string[] = [];
  adapter.close = async (ref, outcome) => {
    outcomes.push(`${ref}:${outcome}`);
    return true;
  };
  db.prepare("UPDATE neo_todos SET state = 'done'").run();
  await sweepNeoTrackerMirrors(db, [adapter]);
  db.prepare("UPDATE neo_todos SET state = 'doing'").run();
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(outcomes).toEqual(['example/repo#2:completed']);
  expect(creates).toHaveLength(2);
});

test('overlapping sweeps create one external item', async () => {
  let entered!: () => void;
  let release!: () => void;
  const creating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.create = async (item) => {
    creates.push(item.marker);
    entered();
    await finish;
    return { ref: 'example/repo#1' };
  };
  const first = sweepNeoTrackerMirrors(db, [adapter]);
  await creating;
  const second = sweepNeoTrackerMirrors(db, [adapter]);
  release();
  await Promise.all([first, second]);
  expect(creates).toEqual(['hyperneo:ask:ask']);
});

test('failed tracker effects remain retryable below the cap', async () => {
  const warning = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  warning.mockClear();
  try {
    adapter.find = async () => {
      throw new Error('Unavailable');
    };
    await sweepNeoTrackerMirrors(db, [adapter]);
    expect(
      warning.mock.calls.filter(([message]) => message === 'Tracker retry limit reached')
    ).toHaveLength(0);
    expect(mirrors.facts().mirrors[0].failures).toBe(1);
    adapter.find = async () => null;
    await sweepNeoTrackerMirrors(db, [adapter]);
    expect(creates).toHaveLength(1);
  } finally {
    warning.mockRestore();
  }
});

test('a child close failing 3 times stops retrying and the parent still closes', async () => {
  addTodo('child');
  await sweepNeoTrackerMirrors(db, [adapter]);
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  const attempts: string[] = [];
  adapter.close = async (ref) => {
    attempts.push(ref);
    return ref === 'example/repo#2' ? { reason: 'Unavailable' } : true;
  };
  for (let sweep = 0; sweep < 6; sweep++) await sweepNeoTrackerMirrors(db, [adapter]);
  expect(attempts).toEqual([
    'example/repo#2',
    'example/repo#2',
    'example/repo#2',
    'example/repo#1',
  ]);
  expect(mirrors.facts().mirrors.find((row) => row.ownerKind === 'todo')?.failures).toBe(3);
});

test('success resets failures', async () => {
  adapter.find = async () => {
    throw new Error('Unavailable');
  };
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(mirrors.facts().mirrors[0].failures).toBe(1);
  adapter.find = async () => null;
  await sweepNeoTrackerMirrors(db, [adapter]);
  expect(mirrors.facts().mirrors[0]).toMatchObject({ failures: 0, state: 'bound' });
});

test('the cap log is written once', async () => {
  const warning = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  warning.mockClear();
  try {
    adapter.find = async () => {
      throw new Error('Unavailable');
    };
    for (let sweep = 0; sweep < 5; sweep++) await sweepNeoTrackerMirrors(db, [adapter]);
    expect(
      warning.mock.calls.filter(([message]) => message === 'Tracker retry limit reached')
    ).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      'Tracker retry limit reached',
      expect.objectContaining({ tracker: 'fixture', action: 'create' }),
      expect.any(Error)
    );
    expect(mirrors.facts().mirrors[0].failures).toBe(3);
  } finally {
    warning.mockRestore();
  }
});

test('link failures stop at the same cap', async () => {
  addTodo('child');
  await sweepNeoTrackerMirrors(db, [adapter]);
  let attempts = 0;
  adapter.link = async () => {
    attempts++;
    return { reason: 'Unavailable' };
  };
  for (let sweep = 0; sweep < 5; sweep++) await sweepNeoTrackerMirrors(db, [adapter]);
  expect(attempts).toBe(3);
  expect(mirrors.facts().mirrors.find((row) => row.ownerKind === 'todo')?.failures).toBe(3);
});
