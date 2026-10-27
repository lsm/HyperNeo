import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { WorkStatus } from '../../../../src/lib/drivers/types.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const hour = 3_600_000;
const root = 'neo:00000000-0000-4000-8000-000000008420';
let clock: number,
  db: Awaited<ReturnType<typeof createTestDb>>,
  service: ReturnType<typeof createNeoService>;
let now: ReturnType<typeof spyOn>;
const hub = { event: mock(() => {}) };
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    hub as unknown as MessageHub,
    new InternalEventBus()
  );
  clock = Date.UTC(2026, 9, 24, 12);
  now = spyOn(Date, 'now').mockImplementation(() => clock);
  db.getDatabase()
    .prepare(
      'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      root,
      'Synthetic',
      'general',
      '/synthetic',
      new Date(clock).toISOString(),
      new Date(clock).toISOString(),
      'active',
      '{}',
      '{}'
    );
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  service.pack('coding')!.sweep = mock(async () => {});
  db.getDatabase()
    .prepare(
      "UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'coding' AND key = 'watchedRepos'"
    )
    .run('["synthetic/plan"]');
});
afterEach(async () => {
  await service.dispose();
  now.mockRestore();
  db.close();
});
function ask(id: string, at = clock - 3 * hour) {
  return service.todos.openAsk({
    id,
    sessionId: root,
    projectId: null,
    originMessageId: null,
    title: id,
    request: 'Synthetic task',
    createdAt: at,
  });
}
function todo(
  id: string,
  state: 'todo' | 'doing' | 'blocked' | 'done',
  status: WorkStatus | null = null,
  report: string | null = null,
  at = clock - 3 * hour
) {
  ask(id, at);
  const step = service.todos.addTodo(
    id,
    id,
    { title: id, doneWhen: 'Done', instruction: null, named: null, check: null },
    at
  );
  service.todos.updateTodo(step, { state, report }, at);
  if (status) {
    service.todoSessions.create(id, {
      verb: 'adopt',
      ref: { adapter: 'hyperneo', id: 'worker-' + id },
    });
    service.todoSessions.recordLive(id, status, null);
    service.todoSessions.recordCardCheck(id, { checkedAt: clock, unchecked: false });
  }
}
function history() {
  return service.publications.list(service.repo.conversationId()!, 0, 100)!;
}

test('one daily message separates core counts from enabled pack counts and keeps old history', async () => {
  ask('stalled');
  ask('recent', clock - 2 * hour + 1);
  const closed = ask('closed');
  service.todos.settleAsk(closed, 'done', 'Settled', clock - 3 * hour);
  todo('waiting', 'todo');
  todo('recent-wait', 'todo', null, null, clock - 2 * hour + 1);
  todo('idle', 'doing', 'stopped');
  todo('reported', 'doing', 'done', 'Worker report');
  todo('running', 'doing', 'running');
  todo('unknown', 'doing');
  ask('question');
  service.todos.askQuestion(
    'q',
    'question',
    {
      text: 'Choose',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      startTodos: null,
      confirm: null,
      document: null,
      replyTo: [],
      todoId: null,
      artifacts: [],
    },
    clock - 3 * hour
  );
  const ledger = new CodingPrLedgerRepository(db.getDatabase());
  ledger.replace(
    'synthetic/plan',
    [
      {
        repo: 'synthetic/plan',
        number: 1,
        title: 'Ready',
        branch: 'one',
        head: 'h1',
        state: 'approved_green',
        closedAt: null,
      },
      {
        repo: 'synthetic/plan',
        number: 2,
        title: 'Waiting',
        branch: 'two',
        head: 'h2',
        state: 'waiting_review',
        closedAt: null,
      },
    ],
    clock - hour - 1
  );
  await Promise.all([service.sweepPacks(), service.sweepPacks()]);
  expect(history()).toHaveLength(1);
  const first = history()[0];
  expect(first.fullText).toContain('stalled asks: 1');
  expect(first.fullText).toContain('todos waiting >2h: 1');
  expect(first.fullText).toContain('idle workers without a report: 1');
  expect(first.fullText).toContain('coding');
  expect(first.fullText).toContain('ready to merge >1h: 1');
  clock += hour;
  await service.sweepPacks();
  expect(history()).toHaveLength(1);
  service.todos.settleAsk(service.todos.getAsk('stalled')!, 'done', 'Settled', clock);
  clock += 24 * hour;
  await service.sweepPacks();
  expect(history()).toHaveLength(2);
  expect(history()[0]).toEqual(first);
  expect(history()[1].fullText).toContain('stalled asks: 1');
});

test('a disabled pack is not counted, and unknown or superseded worker observations are not idle', async () => {
  db.updateGlobalSettings({ neo: { packs: [] } });
  todo('stale', 'doing', 'stopped');
  const item = service.todos.getTodo('stale')!;
  service.todos.updateTodo(item, { report: null }, clock + 1);
  todo('failed-read', 'doing', 'stopped');
  service.todoSessions.recordCardCheck('failed-read', { checkedAt: clock, unchecked: true });
  await service.sweepPacks();
  expect(history()).toHaveLength(1);
  expect(history()[0].fullText).toContain('idle workers without a report: 0');
  expect(history()[0].fullText).not.toContain('coding');
});

test('a new head or non-ready state is not an overdue ready item', async () => {
  const ledger = new CodingPrLedgerRepository(db.getDatabase());
  ledger.replace(
    'synthetic/plan',
    [
      {
        repo: 'synthetic/plan',
        number: 1,
        title: 'Ready',
        branch: 'one',
        head: 'old',
        state: 'approved_green',
        closedAt: null,
      },
    ],
    clock - 2 * hour
  );
  ledger.replace(
    'synthetic/plan',
    [
      {
        repo: 'synthetic/plan',
        number: 1,
        title: 'New head',
        branch: 'one',
        head: 'new',
        state: 'approved_green',
        closedAt: null,
      },
    ],
    clock - hour + 1
  );
  await service.sweepPacks();
  expect(history()).toHaveLength(1);
  expect(history()[0].fullText).toContain('ready to merge >1h: 0');
});

test('another enabled pack contributes its own labelled counts without core domain knowledge', async () => {
  service.filePacks = [
    {
      id: 'example',
      describe: 'Synthetic domain',
      instructions: () => null,
      stats: () => ({ 'waiting items': 4 }),
    },
  ];
  db.updateGlobalSettings({ neo: { packs: ['example'] } });
  await service.sweepPacks();
  expect(history()).toHaveLength(1);
  expect(history()[0].fullText).toContain('example: waiting items: 4');
  expect(history()[0].fullText).not.toContain('coding');
});

test('large pack labels still produce a valid bounded daily publication', async () => {
  service.filePacks = [
    {
      id: 'large',
      describe: 'Synthetic domain',
      instructions: () => null,
      stats: () => ({ ['x'.repeat(17000)]: 4 }),
    },
  ];
  db.updateGlobalSettings({ neo: { packs: ['large'] } });
  await service.sweepPacks();
  expect(history()).toHaveLength(1);
  expect(history()[0].shortText.length).toBeLessThanOrEqual(2000);
  expect(history()[0].fullText.length).toBeLessThanOrEqual(16000);
  expect(history()[0].fullText).toContain('Core: stalled asks: 0');
});

test.each([false, true])(
  'a broken pack cannot suppress daily counts (async: %s)',
  async (asynchronous) => {
    let attempts = 0;
    service.filePacks = [
      {
        id: 'broken',
        describe: 'Synthetic failure',
        instructions: () => null,
        stats: () => {
          attempts++;
          if (asynchronous) return Promise.reject(new Error('Synthetic unavailable'));
          throw new Error('Synthetic unavailable');
        },
      },
      {
        id: 'healthy',
        describe: 'Synthetic domain',
        instructions: () => null,
        stats: () => ({ 'waiting items': 4 }),
      },
    ];
    db.updateGlobalSettings({ neo: { packs: ['broken', 'healthy'] } });
    await service.sweepPacks();
    await service.sweepPacks();
    expect(history()).toHaveLength(1);
    expect(history()[0].fullText).toContain('Core: stalled asks: 0');
    expect(history()[0].fullText).toContain('healthy: waiting items: 4');
    expect(history()[0].fullText).toContain('broken: unavailable');
    expect(attempts).toBe(1);
  }
);
