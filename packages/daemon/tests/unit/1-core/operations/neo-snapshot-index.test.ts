import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NEO_OTHER_TOPIC, NEO_OTHER_TOPIC_KEY } from '@hyperneo/shared/types/neo-ask';
import { createNeoService, createNeoOperations } from '../../helpers/neo-service.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let registry: ReturnType<typeof createOperationRegistry>;
const rpc = { source: 'rpc' as const, principal: 'local' as const };
const mcp = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo:index' };
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  registry = createOperationRegistry(createNeoOperations(service));
  await db.createSession(createTestSession(mcp.sessionId));
  service.repo.reserveBinding({ sessionId: mcp.sessionId, kind: 'neo', projectId: null });
  db.updateGlobalSettings({ neo: { standingRules: ['Synthetic standing rule.'] } });
});
afterEach(async () => {
  await service.dispose();
  db.close();
});
function seed(count: number) {
  const raw = db.getDatabase();
  raw.transaction(() => {
    for (let i = 0; i < count; i++) {
      raw
        .prepare(
          "INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES (?, 'neo:index', ?, ?, 'open', ?, ?)"
        )
        .run(`index-${i}`, 'Long ask '.repeat(100), 'Request '.repeat(1000), i, i);
      raw
        .prepare(
          'INSERT INTO neo_todos (id,ask_id,position,title,done_when,instruction,report,created_at,updated_at) VALUES (?,?,0,?,?,?,?,?,?)'
        )
        .run(
          `todo-${i}`,
          `index-${i}`,
          'Title '.repeat(100),
          'Done when '.repeat(100),
          'Instruction '.repeat(1000),
          'Report '.repeat(1000),
          i,
          i
        );
    }
  })();
}
async function snapshot(caller = mcp as typeof mcp | typeof rpc, input: unknown = {}) {
  const result = await invokeOperation(registry, 'neo.snapshot', input, caller);
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as NeoSnapshot;
}
test('an MCP snapshot with 200 large asks lists 30 and says how many more, with a cursor that returns the rest', async () => {
  seed(200);
  db.getDatabase().exec("UPDATE neo_todos SET state = 'blocked', blocked_by = 'needs-human'");
  const first = await snapshot();
  expect(first.todoAsks).toHaveLength(30);
  expect(first.neoUnhandled).toBe(200);
  expect(first.more?.asks?.count).toBe(170);
  const seen = first.todoAsks!.map((entry) => entry.ask.id);
  let page = first;
  while (page.more?.asks) {
    page = await snapshot(mcp, { cursor: page.more.asks.cursor });
    expect(page.todoAsks!.length).toBeLessThanOrEqual(30);
    expect(page.needsYou).toBe(first.needsYou);
    expect(page.neoUnhandled).toBe(first.neoUnhandled);
    expect(page.omitted).toEqual(first.omitted);
    seen.push(...page.todoAsks!.map((entry) => entry.ask.id));
  }
  expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => `index-${199 - i}`));
  expect(new Set(seen).size).toBe(200);
});
test('no MCP snapshot field is shortened except the marked question preview', async () => {
  seed(2);
  db.getDatabase()
    .prepare(
      "INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at) VALUES ('long-project',?,?, '',1,1,1)"
    )
    .run('Project '.repeat(1000), 'Summary '.repeat(1000));
  service.sessionWatcher.sessionNoticeGroups = Array.from({ length: 3 }, (_, i) => ({
    id: `group-${i}`,
    at: i,
    line: 'Notice '.repeat(1000),
    notices: [
      {
        key: `notice-${i}`,
        ref: { adapter: 'codex', id: `synthetic-${i}` },
        title: 'Notice title '.repeat(1000),
        kind: 'needs_you' as const,
        at: i,
      },
    ],
  }));
  spyOn(service, 'packs').mockReturnValue([
    {
      id: 'synthetic',
      describe: 'Synthetic pack',
      instructions: () => null,
      snapshotRows: () =>
        Array.from({ length: 100 }, (_, i) => ({ id: i, title: 'Pack row '.repeat(1000) })),
    },
  ]);
  service.todos.askQuestion(
    'question',
    'index-1',
    {
      text: 'Question '.repeat(1000),
      kind: 'reply',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      document: 'Document '.repeat(1000),
      replyTo: [],
      confirm: null,
    },
    1
  );
  const app = await snapshot(rpc);
  const index = await snapshot();
  expect(index.todoAsks).toEqual(app.todoAsks);
  expect(Buffer.byteLength(JSON.stringify(index))).toBeGreaterThan(40_000);
  expect(index.packRows![0].rows).toHaveLength(100);
  expect(index.sessionNoticeGroups).toHaveLength(3);
  expect(index.projects[0].summary).toBe('Summary '.repeat(1000));
  expect(index.todoAsks![0].questions[0].document).toContain('[Document preview truncated]');
  for (const key of [
    'projects',
    'sessionNoticeGroups',
    'packRows',
    'working',
    'preferences',
    'mutedSessions',
    'historyCursor',
  ] as const)
    expect(index[key]).toEqual(app[key]);
  expect(index).not.toHaveProperty('trimmed');
});
test('the MCP snapshot has no standingRules or standingRuleSources', async () => {
  const index = await snapshot();
  expect(index).not.toHaveProperty('standingRules');
  expect(index).not.toHaveProperty('standingRuleSources');
  expect((await snapshot(rpc)).standingRules).toEqual(['Synthetic standing rule.']);
});
test('RPC snapshot output is unchanged by MCP paging', async () => {
  seed(40);
  const before = await snapshot(rpc);
  await snapshot();
  const after = await snapshot(rpc, { cursor: { updatedAt: 10, id: 'index-10' } });
  expect(after).toEqual(before);
  expect(after.todoAsks).toHaveLength(40);
  expect(after).not.toHaveProperty('more');
  expect(after).toHaveProperty('packPreferences');
});
test('working over 100 says more.working.count', async () => {
  const raw = db.getDatabase();
  const prepare = raw.prepare.bind(raw);
  const rows = Array.from({ length: 103 }, (_, i) => ({
    sessionId: `working-${i}`,
    projectId: null,
    title: `Working ${i}`,
    status: 'processing',
  }));
  const reader = spyOn(raw, 'prepare').mockImplementation(
    <TRow = unknown, TParams extends unknown[] = unknown[]>(
      sql: string,
      options?: Parameters<typeof raw.prepare>[1]
    ) => {
      const statement = prepare<TRow, TParams>(sql, options);
      if (!sql.includes('SELECT b.session_id AS sessionId')) return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'all') return () => rows;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
  );
  try {
    const index = await snapshot();
    expect(index.working).toHaveLength(100);
    expect(index.more?.working).toEqual({ count: 3 });
    expect((await snapshot(rpc)).working).toEqual(index.working);
  } finally {
    reader.mockRestore();
  }
});
test('a held Neo session reaches the snapshot with its role and model hold', async () => {
  db.getDatabase()
    .prepare(
      "UPDATE sessions SET processing_state = ?, config = json_set(config, '$.provider', 'anthropic') WHERE id = ?"
    )
    .run(
      JSON.stringify({
        status: 'rate_limit_cooldown',
        retryCount: 0,
        maxRetries: 0,
        retryAt: 9_000,
        reason: 'login',
        since: 7_000,
      }),
      mcp.sessionId
    );
  expect((await snapshot(rpc)).working).toEqual([
    expect.objectContaining({
      sessionId: mcp.sessionId,
      role: 'neo',
      modelHold: { provider: 'anthropic', reason: 'login', since: 7_000 },
    }),
  ]);
});

test('MCP historyCursor retains the finished-ask continuation', async () => {
  seed(45);
  db.getDatabase().exec(
    "UPDATE neo_asks SET status = 'done' WHERE updated_at < 15; UPDATE neo_todos SET state = 'done' WHERE ask_id IN (SELECT id FROM neo_asks WHERE status = 'done')"
  );
  const app = await snapshot(rpc);
  const index = await snapshot();
  expect(index.historyCursor).toEqual(app.historyCursor);
  expect(index.historyCursor).not.toBeNull();
  expect(index.todoAsks).toEqual(app.todoAsks);
  const page = await snapshot(mcp, { cursor: { updatedAt: 15, id: 'index-15' } });
  expect(page.todoAsks).toEqual([]);
});

test.each(['settle', 'insert'] as const)(
  'a %s between pages does not skip or duplicate existing open asks',
  async (change) => {
    seed(65);
    const first = await snapshot();
    if (change === 'settle') {
      db.getDatabase().exec("UPDATE neo_asks SET status = 'done' WHERE id = 'index-64'");
    } else {
      db.getDatabase().exec(
        "INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at) VALUES ('new-ask', 'neo:index', 'New ask', '', 'open', 1000, 1000)"
      );
    }
    const seen = first.todoAsks!.map((entry) => entry.ask.id);
    let page = first;
    while (page.more?.asks) {
      page = await snapshot(mcp, { cursor: page.more.asks.cursor });
      seen.push(...page.todoAsks!.map((entry) => entry.ask.id));
    }
    expect(seen).toEqual(Array.from({ length: 65 }, (_, i) => `index-${64 - i}`));
  }
);

test('equal update times page in the same id order as RPC', async () => {
  seed(65);
  db.getDatabase().exec('UPDATE neo_asks SET updated_at = 1');
  const expected = (await snapshot(rpc)).todoAsks!.map((entry) => entry.ask.id);
  let page = await snapshot();
  const seen = page.todoAsks!.map((entry) => entry.ask.id);
  while (page.more?.asks) {
    page = await snapshot(mcp, { cursor: page.more.asks.cursor });
    seen.push(...page.todoAsks!.map((entry) => entry.ask.id));
  }
  expect(seen).toEqual(expected);
});

test('cursor replies contain the next ask page and shared counts', async () => {
  seed(40);
  const first = await snapshot();
  const page = await snapshot(mcp, { cursor: first.more!.asks!.cursor });
  expect(page.todoAsks).toHaveLength(10);
  expect(page.projects).toEqual([]);
  expect(page.needsYou).toBe(first.needsYou);
  expect(page.neoUnhandled).toBe(first.neoUnhandled);
  expect(Object.keys(page).sort()).toEqual(
    ['ok', 'sessionId', 'projects', 'todoAsks', 'needsYou', 'neoUnhandled', 'rev'].sort()
  );
});

test('a fresh first page reveals an unseen ask updated ahead of the cursor', async () => {
  seed(65);
  const first = await snapshot();
  db.getDatabase().exec("UPDATE neo_asks SET updated_at = 1000 WHERE id = 'index-10'");
  const next = await snapshot(mcp, { cursor: first.more!.asks!.cursor });
  expect(next.todoAsks!.some((entry) => entry.ask.id === 'index-10')).toBe(false);
  const refreshed = await snapshot();
  expect(refreshed.todoAsks![0].ask.id).toBe('index-10');
});

test.each(['workers', 'packs', 'projects'] as const)(
  'cursor reads bypass unrelated %s lookups',
  async (lookup) => {
    seed(40);
    const first = await snapshot();
    const fail = () => {
      throw new Error(`Unrelated ${lookup} lookup`);
    };
    const snapshotRows = mock(fail);
    if (lookup === 'workers') spyOn(service, 'readWorker').mockImplementation(fail);
    if (lookup === 'packs')
      spyOn(service, 'packs').mockReturnValue([
        { id: 'synthetic', describe: 'Synthetic', instructions: () => null, snapshotRows },
      ]);
    if (lookup === 'projects') spyOn(service.repo, 'listProjects').mockImplementation(fail);
    const page = await snapshot(mcp, { cursor: first.more!.asks!.cursor });
    expect(page.todoAsks).toHaveLength(10);
    expect(snapshotRows).not.toHaveBeenCalled();
  }
);

test('the RPC snapshot carries the human queue with each todo owner and step', async () => {
  seed(2);
  db.getDatabase().exec("UPDATE neo_todos SET title = id, approved_at = 1 WHERE id = 'todo-0'");
  service.todos.askQuestion(
    'queue-card',
    'index-1',
    {
      text: 'Ship it?',
      kind: 'reply',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      document: null,
      replyTo: [],
      confirm: null,
    },
    1
  );
  expect((await snapshot(rpc)).humanQueue).toEqual({
    items: [
      {
        state: 'waiting',
        askId: 'index-1',
        questionId: 'queue-card',
        text: 'Ship it?',
        todos: [{ id: 'todo-1', title: 'Title '.repeat(100) }],
      },
      {
        state: 'waiting',
        askId: 'index-0',
        todoId: 'todo-0',
        title: 'todo-0',
        owner: 'neo',
        step: 'neo',
      },
    ],
    counts: {
      'index-0': { waiting: 1, held: 0, progress: 0 },
      'index-1': { waiting: 1, held: 0, progress: 0 },
    },
    topics: {
      'index-0': { topic: NEO_OTHER_TOPIC, topicKey: NEO_OTHER_TOPIC_KEY },
      'index-1': { topic: NEO_OTHER_TOPIC, topicKey: NEO_OTHER_TOPIC_KEY },
    },
  });
  expect(await snapshot(mcp)).not.toHaveProperty('humanQueue');
});

test('a project-scoped snapshot still carries the whole human queue, like needsYou', async () => {
  seed(2);
  service.repo.saveProject({ id: 'scoped', title: 'Scoped', summary: '', context: '' }, 0);
  db.getDatabase().exec("UPDATE neo_asks SET project_id = 'scoped' WHERE id = 'index-0'");
  service.todos.askQuestion(
    'other-project-card',
    'index-1',
    {
      text: 'Elsewhere?',
      kind: 'reply',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      document: null,
      todoId: 'todo-1',
    },
    1
  );
  const scoped = await snapshot(rpc, { projectId: 'scoped' });
  expect(scoped.todoAsks?.map((entry) => entry.ask.id)).toEqual(['index-0']);
  expect(scoped.needsYou).toBe(1);
  expect(scoped.humanQueue?.counts).toEqual({
    'index-0': { waiting: 1, held: 0, progress: 0 },
    'index-1': { waiting: 1, held: 0, progress: 0 },
  });
  expect(scoped.humanQueue?.topics).toEqual({
    'index-0': { topic: 'Scoped', topicKey: 'scoped', topicSource: 'project' },
    'index-1': { topic: NEO_OTHER_TOPIC, topicKey: NEO_OTHER_TOPIC_KEY },
  });
});

test('a pack whose wait check fails leaves the human queue out, not the snapshot', async () => {
  seed(1);
  db.getDatabase().exec("UPDATE neo_todos SET approved_at = 1 WHERE id = 'todo-0'");
  const packs = service.installedPacks();
  spyOn(service, 'installedPacks').mockReturnValue([
    ...packs,
    {
      id: 'broken',
      describe: 'Synthetic',
      instructions: () => null,
      todos: {
        schema: () => {},
        check: async () => null,
        statusLine: () => null,
        waiting: async () => {
          throw new Error('synthetic waiting failure');
        },
      },
    },
  ]);
  const value = await snapshot(rpc);
  expect(value.todoAsks?.map((entry) => entry.ask.id)).toEqual(['index-0']);
  expect(value).not.toHaveProperty('humanQueue');
});

test('unapproved pending work and a tracked session both have an owner in the human queue', async () => {
  seed(1);
  const ref = { adapter: 'codex-desktop', id: 'tracked-thread' };
  const tracked = service.todos.addTodo(
    'tracked',
    'index-0',
    { title: 'Tracked', doneWhen: 'Done', check: null, instruction: null, named: null },
    1
  );
  service.todoSessions.create(tracked.id, { verb: 'adopt', ref });
  service.todoSessions.recordRef(tracked.id, ref, 1);
  service.todos.commitState(tracked.id, { state: 'doing', startedAt: 1 }, 1, {
    state: 'no_opinion',
  });
  const { humanQueue } = await snapshot(rpc);
  expect(humanQueue?.items).toEqual([
    expect.objectContaining({ todoId: 'todo-0', owner: 'neo' }),
    expect.objectContaining({ todoId: 'tracked', owner: 'daemon' }),
  ]);
});

test('a card written during the snapshot does not leave its todo owned by the human', async () => {
  seed(1);
  db.getDatabase().exec("UPDATE neo_todos SET approved_at = 1 WHERE id = 'todo-0'");
  const read = service.readWorker.bind(service);
  let wrote = false;
  spyOn(service, 'readWorker').mockImplementation(async (ref) => {
    if (!wrote) {
      wrote = true;
      service.todos.askQuestion(
        'late-card',
        'index-0',
        {
          text: 'Late?',
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          document: null,
          todoId: 'todo-0',
        },
        2
      );
    }
    return read(ref);
  });
  const { humanQueue } = await snapshot(rpc);
  expect(wrote).toBe(true);
  expect(humanQueue?.items).toEqual([
    expect.objectContaining({ state: 'waiting', todoId: 'todo-0', owner: 'neo' }),
  ]);
});
