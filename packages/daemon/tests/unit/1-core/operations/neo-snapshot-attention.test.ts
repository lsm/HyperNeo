import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createTestDb } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let registry: ReturnType<typeof createOperationRegistry>;
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  registry = createOperationRegistry(createNeoOperations(service));
  for (const id of ['a', 'b'])
    service.repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
});
afterEach(() => {
  service.dispose();
  db.close();
});
function ask(id: string, state = 'open', project = 'a', at = 0) {
  db.getDatabase()
    .prepare(`INSERT INTO neo_asks
    (id,project_id,session_id,title,request,status,created_at,updated_at)
    VALUES (?,?,'synthetic',?,'Synthetic request',?,?,?)`)
    .run(id, project, id, state, at, at);
}
function opens(count: number, project = 'a') {
  for (let index = 0; index < count; index++) ask(`${project}-${index}`, 'open', project, index);
}
async function snapshot(projectId?: string) {
  const result = await invokeOperation(registry, 'neo.snapshot', projectId ? { projectId } : {}, {
    source: 'rpc',
    principal: 'local',
  });
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as NeoSnapshot;
}

test('Work retains every open ask plus ten recent finished or dropped cards', async () => {
  opens(63);
  for (let i = 0; i < 32; i++)
    ask(`finished-${String(i).padStart(2, '0')}`, i % 2 ? 'done' : 'dropped', 'a', 1000);
  const view = await snapshot();
  expect(view.todoAsks?.filter((entry) => entry.ask.status === 'open')).toHaveLength(63);
  expect(
    view.todoAsks?.filter((entry) => entry.ask.status !== 'open').map((entry) => entry.ask.id)
  ).toEqual(Array.from({ length: 10 }, (_, i) => `finished-${31 - i}`));
  expect(view.omitted).toEqual({ asks: 22 });
});

test.each(['todo', 'doing', 'blocked', 'failed', 'closed_unverified'])(
  'old settled cards with a %s todo stay visible outside retention',
  async (state) => {
    for (let i = 0; i < 32; i++) ask(`done-${i}`, 'done', 'a', 1000 + i);
    ask('attention', 'done', 'a', -1);
    db.getDatabase()
      .prepare(`INSERT INTO neo_todos
      (id,ask_id,position,title,done_when,state,created_at,updated_at)
      VALUES ('attention-todo','attention',0,'Needs attention','Observed outcome',?,-1,-1)`)
      .run(state);
    const view = await snapshot();
    expect(view.todoAsks).toHaveLength(11);
    expect(view.todoAsks?.find((entry) => entry.ask.id === 'attention')?.todos[0].state).toBe(
      state
    );
  }
);

test('history pages preserve same-time ordering, project scope, summaries and relay access', async () => {
  for (let i = 0; i < 32; i++) ask(`done-${String(i).padStart(2, '0')}`, 'done', 'a', 1000);
  ask('other-project', 'done', 'b', 999);
  ask('waiting', 'done', 'a', -1);
  db.getDatabase()
    .prepare(`INSERT INTO neo_questions
    (id,ask_id,text,kind,state,created_at) VALUES ('q','waiting','What next?','reply','open',-1)`)
    .run();
  const first = await snapshot('a');
  expect(
    first.todoAsks?.find((entry) => entry.ask.id === 'waiting')?.summary?.openQuestionCount
  ).toBe(1);
  const page = async (before: unknown) => {
    const result = await invokeOperation(
      registry,
      'neo.ask.history',
      { projectId: 'a', before },
      {
        source: 'rpc',
        principal: 'local',
        device: { deviceId: 'relay', kind: 'relay' },
      }
    );
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error(result.message);
    return result.value as { entries: NonNullable<NeoSnapshot['todoAsks']>; nextCursor: unknown };
  };
  const older = await page({ updatedAt: 1000, id: 'done-22' });
  expect(older.entries).toHaveLength(20);
  expect(older.entries.map((entry) => entry.ask.id)).toEqual(
    Array.from({ length: 20 }, (_, i) => `done-${String(21 - i).padStart(2, '0')}`)
  );
  expect(older.entries.every((entry) => !!entry.summary && entry.ask.projectId === 'a')).toBe(true);
  const last = await page(older.nextCursor);
  expect(last.entries.map((entry) => entry.ask.id)).toEqual(['done-01', 'done-00']);
  expect(last.nextCursor).toBeNull();
});
