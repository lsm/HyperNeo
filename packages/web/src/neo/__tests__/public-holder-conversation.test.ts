import { describe, expect, it } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import {
  admitNeoPublicHolderScope,
  projectNeoPublicHolderConversation,
} from '../public-holder-conversation.ts';

const id = '10000000-0000-4000-8000-000000000001';
const root = `neo:${id}`;
const holder = 'fictional-context-holder';
const snapshot = (fields: Partial<NeoSnapshot> = {}): NeoSnapshot => ({
  ok: true,
  sessionId: root,
  concerns: [],
  work: [],
  ...fields,
});
const ask = (sessionId: string, messageId: string, sequence: number): NeoConversationAsk => ({
  conversationId: id,
  requestId: messageId,
  askOrigin: { sessionId, messageId },
  content: `Ask ${messageId}`,
  sequence,
  createdAt: `2026-10-01T00:00:0${sequence}Z`,
});
const project = (asks: NeoConversationAsk[] = []) =>
  projectNeoPublicConversation(
    root,
    {
      conversationId: id,
      status: 'ready',
      items: asks,
      nextAfter: asks.length,
      hasEarlier: false,
      hasMore: false,
    },
    {
      conversationId: id,
      status: 'ready',
      items: [] as NeoPublication[],
      nextAfter: 0,
      hasEarlier: false,
      hasMore: false,
    }
  );

describe('public root conversation admission', () => {
  it.each([
    [null, root],
    [snapshot(), null],
    [snapshot({ sessionId: 'native-session' }), root],
    [snapshot(), holder],
  ] as const)('rejects an unavailable or non-root scope %#', (value, session) => {
    const conversation = project([ask(root, 'unrelated', 1)]);
    const gate = admitNeoPublicHolderScope(conversation, value, session);
    expect('reason' in gate).toBe(true);
    expect(projectNeoPublicHolderConversation(conversation, value, session)).toMatchObject({
      status: 'unavailable',
      entries: [],
      hasEarlier: false,
      hasMore: false,
    });
  });

  it('rejects a projected conversation belonging to another root', () => {
    const conversation = { ...project(), conversationId: 'foreign-root' };
    expect('reason' in admitNeoPublicHolderScope(conversation, snapshot(), root)).toBe(true);
    expect(projectNeoPublicHolderConversation(conversation, snapshot(), root).entries).toEqual([]);
  });

  it('keeps the root conversation object identity', () => {
    const conversation = project([ask(holder, 'other-ask', 1)]);
    expect(admitNeoPublicHolderScope(conversation, snapshot(), root)).toEqual({
      value: conversation,
    });
    expect(projectNeoPublicHolderConversation(conversation, snapshot(), root)).toBe(conversation);
  });
});
