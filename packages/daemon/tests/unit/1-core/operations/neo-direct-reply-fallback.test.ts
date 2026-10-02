import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  type NeoDirectReplyRuntime,
  type NeoTurnReply,
  publishNeoDirectReplyFallback,
  requireNeoReplySession,
  requireUnpublishedDirectAnswer,
} from '../../../../src/lib/neo/direct-reply-fallback.ts';
import { readNeoTurnReply } from '../../../../src/lib/neo/turn-reply.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { MessageHub } from '@hyperneo/shared';
import type { Database } from '../../../../src/storage/database.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:fictional-holder';
const askA = '20000000-0000-4000-8000-00000000000a';
const askB = '20000000-0000-4000-8000-00000000000b';
const publicationId = '30000000-0000-4000-8000-000000000001';

function ask(requestId = askA, sessionId = root): NeoConversationAsk {
  return {
    conversationId,
    requestId,
    askOrigin: { sessionId, messageId: requestId },
    content: 'Fictional small talk.',
    sequence: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
  } as NeoConversationAsk;
}

const ended = (text: string | null = '  Fictional warm reply.  '): NeoTurnReply => ({
  status: 'ended',
  text,
});

function runtime(overrides: Partial<NeoDirectReplyRuntime> = {}) {
  const value: NeoDirectReplyRuntime = {
    getBinding: (id) =>
      id === root
        ? { sessionId: root, kind: 'neo', concernId: null }
        : id === holder
          ? { sessionId: holder, kind: 'concern', concernId: 'garden' }
          : id === 'worker'
            ? { sessionId: 'worker', kind: 'worker', concernId: null }
            : null,
    getRootBinding: () => ({ sessionId: root, kind: 'neo', concernId: null }),
    recentAsks: (_conversation, id) => [ask(askA, id)],
    isPublished: () => false,
    startedWork: () => false,
    turnReply: () => ended(),
    append: vi.fn(() => ({ accepted: true })),
    notify: vi.fn(),
    newId: () => publicationId,
    ...overrides,
  };
  return value;
}

describe('Neo direct reply fallback', () => {
  test('publishes the final reply text of an unpublished direct answer', () => {
    const io = runtime();
    expect(publishNeoDirectReplyFallback(root, io)).toEqual([
      {
        conversationId,
        publicationId,
        askOrigin: { sessionId: root, messageId: askA },
        producerInput: { sessionId: root, messageId: askA },
        shortText: 'Fictional warm reply.',
        fullText: 'Fictional warm reply.',
        links: [],
      },
    ]);
    expect(io.append).toHaveBeenCalledTimes(1);
    expect(io.notify).toHaveBeenCalledTimes(1);
  });

  test('publishes a finished earlier ask while a newer ask from the same session is still open', () => {
    const turnReply = vi.fn((_session: string, messageId: string) =>
      messageId === askA ? ended('Reply to A.') : { status: 'open' as const, text: null }
    );
    const io = runtime({ recentAsks: () => [ask(askA), ask(askB)], turnReply });
    const published = publishNeoDirectReplyFallback(root, io);
    expect(published.map((item) => [item.producerInput.messageId, item.fullText])).toEqual([
      [askA, 'Reply to A.'],
    ]);
    expect(turnReply).toHaveBeenCalledWith(root, askB);
  });

  test('publishes a concern holder answer under its own session', () => {
    expect(publishNeoDirectReplyFallback(holder, runtime())).toMatchObject([
      {
        askOrigin: { sessionId: holder, messageId: askA },
        producerInput: { sessionId: holder, messageId: askA },
      },
    ]);
  });

  test('bounds long replies to the publication limits', () => {
    const [result] = publishNeoDirectReplyFallback(
      root,
      runtime({ turnReply: () => ended('x'.repeat(20000)) })
    );
    expect(result.shortText).toHaveLength(2000);
    expect(result.shortText.endsWith('…')).toBe(true);
    expect(result.fullText).toHaveLength(16000);
  });

  test.each([
    ['an already published answer', { isPublished: () => true }],
    ['a turn that started a consultation or work', { startedWork: () => true }],
    ['a turn still running', { turnReply: () => ({ status: 'open' as const, text: 'Partial' }) }],
    ['a failed turn', { turnReply: () => ({ status: 'failed' as const, text: 'Partial' }) }],
    ['a turn without reply text', { turnReply: () => ended('   ') }],
    ['a turn with no reply at all', { turnReply: () => ended(null) }],
    ['a session with no human ask', { recentAsks: () => [] }],
    ['a missing root conversation', { getRootBinding: () => null }],
    [
      'a root without a conversation identity',
      { getRootBinding: () => ({ sessionId: 'legacy', kind: 'neo' as const, concernId: null }) },
    ],
  ] as [string, Partial<NeoDirectReplyRuntime>][])('skips %s', (_name, overrides) => {
    const io = runtime(overrides);
    expect(publishNeoDirectReplyFallback(root, io)).toEqual([]);
    expect(io.append).not.toHaveBeenCalled();
    expect(io.notify).not.toHaveBeenCalled();
  });

  test.each(['worker', 'unbound'])('never publishes for a %s session', (sessionId) => {
    const io = runtime();
    expect(requireNeoReplySession(sessionId, io)).toBeNull();
    expect(publishNeoDirectReplyFallback(sessionId, io)).toEqual([]);
    expect(io.append).not.toHaveBeenCalled();
  });

  test('does not notify when the ledger refuses the publication', () => {
    const io = runtime({ append: vi.fn(() => ({ accepted: false })) });
    expect(publishNeoDirectReplyFallback(root, io)).toEqual([]);
    expect(io.notify).not.toHaveBeenCalled();
  });

  test('checks publication and started work against the exact ask', () => {
    const isPublished = vi.fn(() => false);
    const startedWork = vi.fn(() => false);
    const io = runtime({ isPublished, startedWork });
    expect(
      requireUnpublishedDirectAnswer({ sessionId: holder, conversationId, ask: ask(askB) }, io)
    ).toMatchObject({ value: { text: 'Fictional warm reply.' } });
    expect(isPublished).toHaveBeenCalledWith(holder, askB);
    expect(startedWork).toHaveBeenCalledWith(holder, askB);
  });
});

describe('readNeoTurnReply', () => {
  let db: Database;
  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession(root));
  });
  afterEach(() => db.close());

  function save(message: Record<string, unknown>, origin: string) {
    db.getSDKMessageRepo().saveSDKMessage(root, {
      session_id: root,
      ...message,
      neoInputOrigin: { sessionId: root, messageId: origin },
    } as unknown as SDKMessage);
  }
  const assistant = (uuid: string, content: unknown) => ({
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'assistant', content },
  });
  const result = (uuid: string, subtype: string) => ({ type: 'result', uuid, subtype });

  test('reads only the answering turn of each ask, even when turns interleave', () => {
    save(assistant('a-1', [{ type: 'thinking', thinking: 'private' }]), askA);
    save(assistant('b-1', [{ type: 'text', text: 'Reply to B.' }]), askB);
    save(assistant('a-2', [{ type: 'text', text: 'Reply to A.' }]), askA);
    save(result('a-done', 'success'), askA);
    expect(readNeoTurnReply(db, root, askA)).toEqual({ status: 'ended', text: 'Reply to A.' });
    expect(readNeoTurnReply(db, root, askB)).toEqual({ status: 'open', text: 'Reply to B.' });
  });

  test('reports a failed turn and an empty turn', () => {
    save(assistant('a-1', 'Partial answer'), askA);
    save(result('a-done', 'error_during_execution'), askA);
    expect(readNeoTurnReply(db, root, askA)).toEqual({ status: 'failed', text: 'Partial answer' });
    expect(readNeoTurnReply(db, root, 'missing')).toEqual({ status: 'open', text: null });
  });
});

describe('NeoService direct reply fallback wiring', () => {
  let db: Database;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let service: NeoService;
  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      events
    );
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    service.repo.saveConcern({ id: 'garden', title: 'Garden', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, concernId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: holder, concernId: 'garden', kind: 'concern' });
    const { sequence: _sequence, createdAt: _createdAt, ...input } = ask(askA);
    expect(service.asks.append(input).accepted).toBe(true);
    for (const message of [
      {
        type: 'assistant',
        uuid: 'reply',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: 'Let me check with Garden.' },
      },
      { type: 'result', uuid: 'done', subtype: 'success' },
    ])
      db.getSDKMessageRepo().saveSDKMessage(root, {
        session_id: root,
        ...message,
        neoInputOrigin: { sessionId: root, messageId: askA },
      } as unknown as SDKMessage);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });
  const idle = () =>
    events.publish('session.updated', { sessionId: root, processingState: { status: 'idle' } });
  const published = () => service.publications.list(conversationId, 0, 50) ?? [];

  test('keeps a pending line unpublished while its consultation is still queued', async () => {
    service.consultationWaiters.enqueue({
      id: 'waiter',
      requestKey: 'check-garden',
      concernId: 'garden',
      originSessionId: root,
      originMessageId: askA,
      sessionId: holder,
      question: 'What is planted?',
    });
    await idle();
    expect(published()).toEqual([]);
  });

  test('finds the ask behind more than twenty newer consultations and waiters', async () => {
    service.consultationWaiters.enqueue({
      id: 'old-waiter',
      requestKey: 'old-check',
      concernId: 'garden',
      originSessionId: root,
      originMessageId: askA,
      sessionId: holder,
      question: 'Older check',
    });
    db.getDatabase().prepare("UPDATE neo_consultation_waiters SET status = 'cancelled'").run();
    for (let index = 0; index < 25; index++)
      service.consultationWaiters.enqueue({
        id: `newer-${index}`,
        requestKey: `newer-${index}`,
        concernId: 'garden',
        originSessionId: root,
        originMessageId: `other-${index}`,
        sessionId: holder,
        question: 'Unrelated check',
      });
    await idle();
    expect(published()).toEqual([]);
  });

  test('publishes the finished reply once nothing is pending for its ask', async () => {
    await idle();
    expect(published().map((item) => [item.producerInput.messageId, item.fullText])).toEqual([
      [askA, 'Let me check with Garden.'],
    ]);
    await idle();
    expect(published()).toHaveLength(1);
  });
});
