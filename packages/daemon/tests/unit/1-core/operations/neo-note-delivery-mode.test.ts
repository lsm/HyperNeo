import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { neoNoteDeliveryMode } from '../../../../src/lib/neo/direct-reply-fallback.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const rootId = 'neo:10000000-0000-4000-8000-000000000002';

describe('neoNoteDeliveryMode', () => {
  test.each([
    ['processing', 'defer'],
    ['queued', 'defer'],
    ['idle', 'immediate'],
    ['interrupted', 'immediate'],
    [null, 'immediate'],
  ] as const)('a note to a %s Neo is %s', (status, mode) => {
    expect(neoNoteDeliveryMode(status)).toBe(mode);
  });
});

describe('Neo daemon notes', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;

  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    db.createSession({ ...createTestSession(rootId), workspacePath: null });
    service = new NeoService(
      db,
      {} as unknown as SessionManager,
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

  test('a note to a busy Neo waits for its next turn, and one to an idle Neo starts a turn', async () => {
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward(rootId, 'note-busy', 'A card reported.', rootId, null);
    expect(queued('note-busy')).toEqual(['defer']);
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'idle' } as never,
    });
    await service.deliverForward(rootId, 'note-idle', 'A card reported.', rootId, null);
    expect(queued('note-idle')).toEqual(['immediate']);
  });

  test('a message to a busy ordinary chat is not deferred', async () => {
    db.createSession(createTestSession('chat-1'));
    await events.publish('session.updated', {
      sessionId: 'chat-1',
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward('chat-1', 'brief-1', 'Do the work.', rootId, null);
    expect(
      db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': 'chat-1', messageUuid: 'brief-1' })
        .map((job) => job.payload.deliveryMode)
    ).toEqual(['immediate']);
  });
});
