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
      { createSession, getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    service.repo.saveProject({ id: 'web', title: 'Web', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    service.repo.reserveBinding({ sessionId: holder, kind: 'project', projectId: 'web' });
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
    const live = service.repo.proposeWork({
      id: 'live',
      requestKey: 'live',
      projectId: 'web',
      originSessionId: holder,
      originMessageId: 'm1',
      title: 'Live',
      instruction: 'Live',
    });
    const ended = service.repo.proposeWork({ ...live, id: 'ended', requestKey: 'ended' });
    service.repo.transitionWork(ended.id, ended, { status: 'cancelled' });
    service.askRecords.open({
      id: 'legacy',
      requestKey: 'legacy',
      projectId: 'web',
      originSessionId: holder,
      originMessageId: 'm1',
      title: 'Legacy',
      ask: 'Legacy',
      doneWhen: 'Done',
      doneSource: 'human',
    });

    runMigration393(db.getDatabase());
    runMigration393(db.getDatabase());
    expect(owners('neo_asks', 'session_id')).toEqual({ mine: root, open: root, settled: holder });
    expect(owners('neo_work', 'origin_session_id')).toEqual({ ended: holder, live: root });
    expect(owners('legacy_neo_asks', 'origin_session_id')).toEqual({ legacy: root });
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

  test('m395 ends what holders still hold, closes dead legacy items and archives holders, waking no one', async () => {
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
    service.askRecords.open({
      id: 'legacy',
      requestKey: 'legacy',
      projectId: 'web',
      originSessionId: root,
      originMessageId: 'm1',
      title: 'Legacy',
      ask: 'Legacy',
      doneWhen: 'Done',
      doneSource: 'human',
    });
    const card = (id: string) =>
      service.repo.proposeWork({
        id,
        requestKey: id,
        projectId: 'web',
        originSessionId: root,
        originMessageId: 'm1',
        title: id,
        instruction: id,
      });
    card('proposed');
    const failed = card('failed');
    service.repo.transitionWork(failed.id, failed, { status: 'failed', report: 'Never started' });
    const reported = card('reported');
    service.repo.transitionWork(reported.id, reported, { status: 'reported', report: 'Done' });

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
    expect(service.askRecords.get('legacy')).toMatchObject({ status: 'abandoned' });
    expect(service.repo.getWork('reported')?.report).toBe(
      'Closed as done by the move to one Neo session.\n\nDone'
    );
    expect(
      Object.fromEntries(service.repo.listWork().map((work) => [work.id, work.status]))
    ).toEqual({
      proposed: 'cancelled',
      failed: 'cancelled',
      reported: 'reported',
    });
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
