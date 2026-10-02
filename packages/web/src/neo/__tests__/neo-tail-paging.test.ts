import { describe, expect, it } from 'vitest';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { presentConversationAskPage } from '../conversation-ask-client.ts';
import { admitPublicationCursor, presentPublicationPage } from '../publication-client.ts';
import { placeAskTail, prependAskWindow, type NeoAskState } from '../useNeoConversationAsks.ts';
import {
  placePublicationTail,
  prependPublicationWindow,
  type NeoPublicationState,
} from '../useNeoPublications.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const id = (sequence: number) => `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
const newest = Number.MAX_SAFE_INTEGER;

function ask(sequence: number): NeoConversationAsk {
  return {
    conversationId,
    requestId: id(sequence),
    askOrigin: { sessionId: root, messageId: id(sequence) },
    content: [{ type: 'text', text: `Fictional ask ${sequence}` }],
    sequence,
    createdAt: '2026-10-02T00:00:00.000Z',
  } as NeoConversationAsk;
}

function publication(sequence: number): NeoPublication {
  return {
    conversationId,
    publicationId: id(sequence),
    askOrigin: { sessionId: root, messageId: id(sequence) },
    producerInput: { sessionId: 'holder:fictional', messageId: id(sequence) },
    shortText: `Fictional reply ${sequence}`,
    fullText: `Fictional details ${sequence}`,
    links: [],
    sequence,
    createdAt: '2026-10-02T00:00:00.000Z',
  } as NeoPublication;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const ready = <T>(items: T[], nextAfter: number) => ({
  state: 'ready' as const,
  items,
  nextAfter,
});

describe('backward cursor admission', () => {
  it('accepts a before cursor only from the start of the forward cursor', () => {
    const tail = { conversationId, after: 0, limit: 50, before: newest };
    expect(admitPublicationCursor(tail)).toEqual({ value: tail });
    for (const before of [0, -1, 1.5, newest + 1])
      expect(admitPublicationCursor({ ...tail, before })).toEqual({
        reason: { state: 'unavailable' },
      });
    expect(admitPublicationCursor({ ...tail, after: 3 })).toEqual({
      reason: { state: 'unavailable' },
    });
  });

  it('rejects a backward page that reaches the cursor or beyond', () => {
    const page = { conversationId, after: 0, limit: 50, before: 5 };
    const body = (items: unknown[]) => ({
      ok: true,
      conversationId,
      items,
      nextAfter: (items.at(-1) as { sequence: number } | undefined)?.sequence ?? 0,
    });
    expect(presentPublicationPage(body([2, 3, 4].map(publication)), page)).toMatchObject({
      value: { state: 'ready', nextAfter: 4 },
    });
    expect(presentPublicationPage(body([3, 4, 5].map(publication)), page)).toEqual({
      reason: { state: 'unavailable' },
    });
    expect(presentConversationAskPage(body([2, 3, 4].map(ask)), page)).toMatchObject({
      value: { state: 'ready', nextAfter: 4 },
    });
    expect(presentConversationAskPage(body([4, 6].map(ask)), page)).toEqual({
      reason: { state: 'unavailable' },
    });
  });
});

describe.each([
  {
    name: 'asks',
    item: ask as (sequence: number) => never,
    tail: placeAskTail as (state: never, page: never) => NeoAskState,
    prepend: prependAskWindow as (state: never, page: never) => NeoAskState,
  },
  {
    name: 'publications',
    item: publication as (sequence: number) => never,
    tail: placePublicationTail as (state: never, page: never) => NeoPublicationState,
    prepend: prependPublicationWindow as (state: never, page: never) => NeoPublicationState,
  },
])('$name tail window', ({ item, tail, prepend }) => {
  const empty = {
    conversationId,
    status: 'loading' as const,
    items: [],
    nextAfter: 0,
    hasMore: false,
    hasEarlier: false,
  };
  const sequences = (state: { items: readonly { sequence: number }[] }) =>
    state.items.map((entry) => entry.sequence);

  it('a full newest page marks earlier history and live-tails from its last entry', () => {
    const state = tail(empty as never, ready(range(51, 100).map(item), 100) as never);
    expect(sequences(state)).toEqual(range(51, 100));
    expect(state).toMatchObject({
      status: 'ready',
      nextAfter: 100,
      hasMore: false,
      hasEarlier: true,
    });
  });

  it('a short newest page has no earlier history', () => {
    const state = tail(empty as never, ready(range(1, 3).map(item), 3) as never);
    expect(state).toMatchObject({ nextAfter: 3, hasEarlier: false });
  });

  it('prepends an earlier page and keeps the live cursor', () => {
    const current = tail(empty as never, ready(range(51, 100).map(item), 100) as never);
    const state = prepend(current as never, ready(range(1, 50).map(item), 50) as never);
    expect(sequences(state)).toEqual(range(1, 100));
    expect(state).toMatchObject({ nextAfter: 100, hasMore: false, hasEarlier: true });
    const first = prepend(state as never, ready([], 0) as never);
    expect(first.hasEarlier).toBe(false);
    expect(sequences(first)).toEqual(range(1, 100));
  });

  it('caps the window at 500 by dropping the newest and paging forward to them later', () => {
    const current = {
      ...empty,
      status: 'ready' as const,
      items: range(51, 530).map(item),
      nextAfter: 530,
      hasEarlier: true,
    };
    const state = prepend(current as never, ready(range(1, 50).map(item), 50) as never);
    expect(state.items).toHaveLength(500);
    expect(sequences(state)[0]).toBe(1);
    expect(sequences(state).at(-1)).toBe(500);
    expect(state).toMatchObject({ nextAfter: 500, hasMore: true, hasEarlier: true });
  });
});
