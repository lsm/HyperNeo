import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import {
  type NeoDirectReplyRuntime,
  publishNeoDirectReplyFallback,
  requireNeoReplySession,
  requireUnpublishedDirectAnswer,
} from '../../../../src/lib/neo/direct-reply-fallback.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:fictional-holder';
const askId = '20000000-0000-4000-8000-000000000001';
const publicationId = '30000000-0000-4000-8000-000000000001';

function ask(sessionId = root): NeoConversationAsk {
  return {
    conversationId,
    requestId: askId,
    askOrigin: { sessionId, messageId: askId },
    content: 'Fictional small talk.',
    sequence: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
  } as NeoConversationAsk;
}

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
    newestAsk: (_conversation, id) => ask(id),
    isPublished: () => false,
    startedWork: () => false,
    turnEnded: () => 'ended',
    finalText: () => '  Fictional warm reply.  ',
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
    expect(publishNeoDirectReplyFallback(root, io)).toEqual({
      conversationId,
      publicationId,
      askOrigin: { sessionId: root, messageId: askId },
      producerInput: { sessionId: root, messageId: askId },
      shortText: 'Fictional warm reply.',
      fullText: 'Fictional warm reply.',
      links: [],
    });
    expect(io.append).toHaveBeenCalledTimes(1);
    expect(io.notify).toHaveBeenCalledTimes(1);
  });

  test('publishes a concern holder answer under its own session', () => {
    const io = runtime();
    expect(publishNeoDirectReplyFallback(holder, io)).toMatchObject({
      askOrigin: { sessionId: holder, messageId: askId },
      producerInput: { sessionId: holder, messageId: askId },
    });
  });

  test('bounds long replies to the publication limits', () => {
    const io = runtime({ finalText: () => 'x'.repeat(20000) });
    const result = publishNeoDirectReplyFallback(root, io) as {
      shortText: string;
      fullText: string;
    };
    expect(result.shortText).toHaveLength(2000);
    expect(result.shortText.endsWith('…')).toBe(true);
    expect(result.fullText).toHaveLength(16000);
  });

  test.each([
    ['an already published answer', { isPublished: () => true }],
    ['a turn that started a consultation or work', { startedWork: () => true }],
    ['a turn still running', { turnEnded: () => 'open' as const }],
    ['a failed turn', { turnEnded: () => 'failed' as const }],
    ['a turn without reply text', { finalText: () => '   ' }],
    ['a turn with no reply at all', { finalText: () => null }],
    ['a session with no human ask', { newestAsk: () => null }],
    ['a missing root conversation', { getRootBinding: () => null }],
    [
      'a root without a conversation identity',
      { getRootBinding: () => ({ sessionId: 'legacy', kind: 'neo' as const, concernId: null }) },
    ],
  ] as [string, Partial<NeoDirectReplyRuntime>][])('skips %s', (_name, overrides) => {
    const io = runtime(overrides);
    expect(publishNeoDirectReplyFallback(root, io)).toEqual({ skipped: true });
    expect(io.append).not.toHaveBeenCalled();
    expect(io.notify).not.toHaveBeenCalled();
  });

  test.each(['worker', 'unbound'])('never publishes for a %s session', (sessionId) => {
    const io = runtime();
    expect(publishNeoDirectReplyFallback(sessionId, io)).toEqual({ skipped: true });
    expect(io.append).not.toHaveBeenCalled();
  });

  test('does not notify when the ledger refuses the publication', () => {
    const io = runtime({ append: vi.fn(() => ({ accepted: false })) });
    expect(publishNeoDirectReplyFallback(root, io)).toEqual({ skipped: true });
    expect(io.notify).not.toHaveBeenCalled();
  });

  test('gates read the newest ask of the replying session', () => {
    const newestAsk = vi.fn(() => ask(holder));
    const io = runtime({ newestAsk });
    const turn = requireNeoReplySession(holder, io);
    expect(newestAsk).toHaveBeenCalledWith(conversationId, holder);
    if (!('value' in turn)) throw new Error('expected a turn');
    const isPublished = vi.fn(() => false);
    const startedWork = vi.fn(() => false);
    expect(
      requireUnpublishedDirectAnswer(turn.value, runtime({ isPublished, startedWork }))
    ).toMatchObject({ value: { text: 'Fictional warm reply.' } });
    expect(isPublished).toHaveBeenCalledWith(holder, askId);
    expect(startedWork).toHaveBeenCalledWith(holder, askId);
  });
});
