import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { vi } from 'vitest';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { runMigration393 } from '../../../../src/storage/schema/m393-neo-root-asks.ts';
import { runMigration395 } from '../../../../src/storage/schema/m395-neo-archive-holders.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const root = 'neo:root';
const holder = 'neo:holder:web';

describe('Neo as one session', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const told: { sessionId: string; messageId: string }[] = [];
  const createSession = vi.fn();

  beforeEach(async () => {
    told.length = 0;
    createSession.mockReset();
    db = await createTestDb();
    service = new NeoService(
      db,
      {
        createSession,
        getSessionAsync: vi.fn(),
        updateSession: async (id: string, updates: Parameters<typeof db.updateSession>[1]) => {
          db.updateSession(id, updates);
        },
      } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    service.repo.saveProject({ id: 'web', title: 'Web', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    db.getDatabase()
      .prepare(
        "INSERT INTO neo_session_bindings (session_id, concern_id, kind) VALUES (?, 'web', 'project')"
      )
      .run(holder);
    Object.assign(service, {
      deliverForward: async (sessionId: string, messageId: string) => {
        told.push({ sessionId, messageId });
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  const openAsk = (id: string, sessionId: string) =>
    service.todos.openAsk({
      id,
      projectId: 'web',
      sessionId,
      originMessageId: null,
      title: id,
      request: id,
      createdAt: 1,
    });
  const owners = (table: string, column: string) =>
    Object.fromEntries(
      (
        db
          .getDatabase()
          .prepare(`SELECT id, ${column} AS owner FROM ${table} ORDER BY id`)
          .all() as { id: string; owner: string }[]
      ).map((row) => [row.id, row.owner])
    );
  const caller = (sessionId: string): OperationCaller => ({
    source: 'mcp',
    sessionId,
    role: 'neo',
  });

  test('m393 moves what holders own and is live to root, and a rerun changes nothing', () => {
    openAsk('open', holder);
    service.todos.settleAsk(openAsk('settled', holder), 'done', 'Shipped', 2);
    openAsk('mine', root);
    runMigration393(db.getDatabase());
    runMigration393(db.getDatabase());
    expect(owners('neo_asks', 'session_id')).toEqual({ mine: root, open: root, settled: holder });
  });

  test('root works a moved ask and the todo note reaches root', async () => {
    openAsk('open', holder);
    runMigration393(db.getDatabase());
    const invoke = (name: string, input: unknown, as: OperationCaller) =>
      invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, as);
    const todo = { title: 'Fix header', doneWhen: 'Merged' };
    const added = await invoke('neo.todo.add', { askId: 'open', ...todo }, caller(root));
    expect(added).toMatchObject({ value: { ok: true } });
    const id = (added as { value: { todo: { id: string } } }).value.todo.id;

    service.todos.claimStart(service.todos.getTodo(id)!, 6);
    service.todoSessions.create(id, { verb: 'start' } as never);
    await service.todoRunner.refresh(() => {});
    expect(service.todos.getTodo(id)).toMatchObject({ state: 'failed' });
    expect(told.filter((note) => note.messageId.startsWith(`neo-todo:${id}:`))).toEqual([
      { sessionId: root, messageId: expect.stringContaining(id) },
    ]);
  });

  test('opening Neo always returns root and never creates a holder session', async () => {
    expect(await Promise.all([service.open(), service.open()])).toEqual([root, root]);
    expect(createSession).not.toHaveBeenCalled();
    db.getDatabase().exec("DELETE FROM neo_session_bindings WHERE kind = 'neo'");
    const fresh = await service.open();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(service.repo.defaultBinding()).toMatchObject({ sessionId: fresh, kind: 'neo' });
  });

  test('m395 ends what holders still hold and archives holders, waking no one', async () => {
    const jobs = db.getJobQueueRepo();
    const toHolder = jobs.enqueue({
      queue: 'mailbox',
      payload: { to: { kind: 'session', sessionId: holder }, messageUuid: 'note' },
    });
    const deliveryToHolder = jobs.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: holder, messageUuid: 'prompt' },
    });
    const toRoot = jobs.enqueue({
      queue: 'mailbox',
      payload: { to: { kind: 'session', sessionId: root }, messageUuid: 'root-note' },
    });
    for (const [sessionId, uuid] of [
      [holder, 'held'],
      [root, 'kept'],
    ])
      db.getSDKMessageRepo().saveSDKMessage(sessionId, {
        type: 'user',
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: 'note' },
      } as never);
    db.getDatabase().exec("UPDATE sdk_messages SET send_status = 'deferred'");
    runMigration395(db.getDatabase(), 5);
    runMigration395(db.getDatabase(), 6);

    const status = (id: string) => jobs.getJob(id)?.status;
    expect([toHolder, deliveryToHolder, toRoot].map((job) => status(job.id))).toEqual([
      'dead',
      'dead',
      'pending',
    ]);
    expect(
      db
        .getDatabase()
        .prepare('SELECT sdk_uuid, send_status FROM sdk_messages ORDER BY sdk_uuid')
        .all()
    ).toEqual([
      { sdk_uuid: 'held', send_status: 'failed' },
      { sdk_uuid: 'kept', send_status: 'deferred' },
    ]);
    expect([db.getSession(holder)?.status, db.getSession(root)?.status]).toEqual([
      'archived',
      'active',
    ]);
    const delivered: string[] = [];
    Object.assign(service, {
      deliver: async (sessionId: string, messageId: string) => {
        delivered.push(`${sessionId} ${messageId}`);
      },
    });
    await service.recover();
    expect([delivered, told]).toEqual([[], []]);
  });
});
