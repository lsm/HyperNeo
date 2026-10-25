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
  let turnEnds: { id: string; at: number; message: string }[];

  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    await db.createSession({ ...createTestSession(rootId), workspacePath: null });
    turnEnds = [];
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'Synthetic worker status',
        inputSchema: z.unknown(),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          ok: true,
          value: { status: 'running', lastActivityAt: Date.now(), turnEnds },
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

  test('notes to busy and idle Neo both use immediate ordinary mailbox delivery', async () => {
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward(rootId, 'note-busy', 'A card reported.', rootId);
    expect(queued('note-busy')).toEqual(['immediate']);
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'idle' } as never,
    });
    await service.deliverForward(rootId, 'note-idle', 'A card reported.', rootId);
    expect(queued('note-idle')).toEqual(['immediate']);
  });

  test('focused discussion status is recorded without waking Neo', async () => {
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
    service.todos.focusAsk(ask.id, ref, now);
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
    await service.todoSessions.inputs.recordOutcome(dispatch, { ok: true, ref }, now);
    turnEnds = [{ id: 'discussion-turn', at: now + 1, message: 'Prepared the discussion.' }];
    await service.todoRunner.refresh((message, error) => {
      throw new Error(message, { cause: error });
    });
    const key = `neo-todo-turn:${todo.id}:${dispatch}:discussion-turn`;
    expect(queued(key)).toEqual([]);
    expect(db.getSDKMessageRepo().findMessageIdByUuid(rootId, key)).toBeTruthy();
  });

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
