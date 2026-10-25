import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const rootId = 'neo:10000000-0000-4000-8000-000000000002';

describe('Neo daemon notes', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let workerStatus: string;
  let turnEnds: { id: string; at: number; message: string; notify?: false }[];

  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    await db.createSession({ ...createTestSession(rootId), workspacePath: null });
    turnEnds = [];
    workerStatus = 'running';
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'Synthetic worker status',
        inputSchema: z.unknown(),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          ok: true,
          value: { status: workerStatus, lastActivityAt: Date.now(), turnEnds },
        }),
      }),
    ]);
    service = createNeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: rootId, projectId: null, kind: 'neo' });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  const queued = (messageId: string) =>
    db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': rootId, messageUuid: messageId })
      .map((job) => job.payload.deliveryMode);

  test.each(['wakeNeo', 'sendToRef'])('%s keeps structured PR events immediate', async (path) => {
    if (path === 'wakeNeo') await service.wakeNeo('structured-pr', 'PR requires action.');
    else
      await service.sendToRef(
        { adapter: 'hyperneo', id: rootId },
        'structured-pr',
        'PR requires action.'
      );
    expect(queued('structured-pr')).toEqual(['immediate']);
    const job = db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': rootId, messageUuid: 'structured-pr' })[0];
    expect((job.payload.message as { neoWakeEvent?: boolean }).neoWakeEvent).toBe(true);
  });

  test('a burst of 20 unstructured worker notes does not start Neo', async () => {
    for (let i = 0; i < 20; i++)
      await service.deliverForward(rootId, `chatty-${i}`, `chatty-${i}`, 'worker');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': rootId })
    ).toHaveLength(0);
  });

  test('notes to busy and idle Neo both use immediate ordinary mailbox delivery', async () => {
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward(rootId, 'note-busy', 'A card reported.', rootId, 'event');
    expect(queued('note-busy')).toEqual(['immediate']);
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'idle' } as never,
    });
    await service.deliverForward(rootId, 'note-idle', 'A card reported.', rootId, 'event');
    expect(queued('note-idle')).toEqual(['immediate']);
  });

  test.each(['focused', 'heartbeat', 'failed', 'needs_you'])(
    '%s status uses its wake policy',
    async (kind) => {
      const now = Date.now();
      const ref = { adapter: 'hyperneo', id: 'discussion' };
      const ask = service.todos.openAsk({
        id: 'focused-ask',
        projectId: null,
        sessionId: rootId,
        originMessageId: 'human-request',
        title: 'Discuss',
        request: 'Prepare a discussion',
        createdAt: now,
      });
      if (kind !== 'heartbeat')
        service.todos.focusAsk(
          ask.id,
          {
            ...ref,
            name: 'Discussion',
            label: 'Discussion',
            provider: 'Anthropic',
            link: '/session/discussion',
          },
          now
        );
      const todo = service.todos.addTodo(
        'focused-todo',
        ask.id,
        {
          title: 'Discuss',
          doneWhen: 'Human decides',
          instruction: null,
          named: null,
          check: null,
        },
        now
      );
      service.todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
      service.todoSessions.bind(todo.id, ref, now);
      const dispatch = await service.todoSessions.inputs.accept(
        todo.id,
        rootId,
        { verb: 'send', ref },
        'Prepare a discussion',
        now
      );
      await service.todoSessions.inputs.recordOutcome(dispatch, { ref }, now);
      turnEnds = [
        {
          id: 'discussion-turn',
          at: now + 1,
          message: 'Prepared the discussion.',
          ...(kind === 'heartbeat' ? { notify: false as const } : {}),
        },
      ];
      if (['failed', 'needs_you'].includes(kind)) workerStatus = kind;
      await service.todoRunner.refresh((message, error) => {
        throw new Error(message, { cause: error });
      });
      const key = `neo-todo-turn:${todo.id}:${dispatch}:discussion-turn`;
      expect(queued(key)).toEqual([]);
      expect(db.getSDKMessageRepo().findMessageIdByUuid(rootId, key)).toBeTruthy();
    }
  );

  const storedCount = (messageId: string) =>
    (
      db
        .getDatabase()
        .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?')
        .get(rootId, messageId) as { n: number }
    ).n;

  test.each(['focused_status', 'quiet_heartbeat'] as const)(
    '%s retry preserves one pending urgent delivery',
    async (kind) => {
      const id = 'pending-urgent';
      const urgent = service.deliverForward(rootId, id, 'Worker failed.', rootId, 'event');
      await service.deliverForward(rootId, id, 'Quiet retry.', rootId, kind);
      await urgent;
      expect(storedCount(id)).toBe(0);
      expect(queued(id)).toEqual(['immediate']);
    }
  );

  test.each(['focused_status', 'quiet_heartbeat'] as const)(
    '%s retry preserves one queued urgent delivery',
    async (kind) => {
      const id = 'queued-urgent';
      await service.deliverForward(rootId, id, 'Worker failed.', rootId, 'event');
      await service.deliverForward(rootId, id, 'Quiet retry.', rootId, kind);
      expect(storedCount(id)).toBe(0);
      expect(queued(id)).toEqual(['immediate']);
    }
  );

  test.each(['focused_status', 'quiet_heartbeat'] as const)(
    '%s concurrent retries record one history row without a wake',
    async (kind) => {
      const id = 'concurrent-quiet';
      await Promise.all(
        Array.from({ length: 10 }, () =>
          service.deliverForward(rootId, id, 'Quiet report.', rootId, kind)
        )
      );
      expect(storedCount(id)).toBe(1);
      expect(queued(id)).toEqual([]);
    }
  );

  test('a message to a busy ordinary chat is not deferred', async () => {
    await db.createSession(createTestSession('chat-1'));
    await events.publish('session.updated', {
      sessionId: 'chat-1',
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward('chat-1', 'brief-1', 'Do the work.', rootId);
    expect(
      db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': 'chat-1', messageUuid: 'brief-1' })
        .map((job) => job.payload.deliveryMode)
    ).toEqual(['immediate']);
  });
});
