import { describe, expect, it } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoConcern, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import {
  admitNeoPublicHolderScope,
  presentNeoPublicHolderConversation,
  projectNeoPublicHolderConversation,
} from '../public-holder-conversation.ts';

const id = '10000000-0000-4000-8000-000000000001';
const root = `neo:${id}`;
const holder = 'fictional-context-holder';
const other = 'other-fictional-holder';
const concern = (id = 'context'): NeoConcern => ({
  id,
  title: 'Source context',
  summary: 'Summary',
  context: 'Context',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});
const binding = (sessionId = holder, concernId = 'context') => ({
  sessionId,
  concernId,
  kind: 'concern' as const,
});
const snapshot = (fields: Partial<NeoSnapshot> = {}): NeoSnapshot => ({
  ok: true,
  sessionId: root,
  concerns: [concern(), concern('other')],
  work: [],
  publicAuthorBindings: [binding(), binding(other, 'other')],
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
const publication = (
  producer: string,
  origin: NeoPublication['askOrigin'],
  sequence: number
): NeoPublication => ({
  conversationId: id,
  publicationId: `publication-${sequence}`,
  askOrigin: origin,
  producerInput: { sessionId: producer, messageId: `input-${sequence}` },
  shortText: `Authored short ${sequence}`,
  fullText: `Authored full ${sequence}`,
  links: [{ kind: 'work', id: 'unrelated', label: 'Never infer a holder from this' }],
  sequence,
  createdAt: `2026-10-01T00:00:0${sequence}Z`,
});
const project = (asks: NeoConversationAsk[] = [], publications: NeoPublication[] = []) =>
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
      items: publications,
      nextAfter: publications.length,
      hasEarlier: false,
      hasMore: false,
    }
  );

describe('public holder scope admission', () => {
  it.each([
    [null, holder],
    [snapshot(), null],
    [snapshot({ sessionId: 'native-session' }), holder],
    [snapshot(), 'unknown-session'],
    [snapshot({ publicAuthorBindings: undefined }), holder],
    [snapshot({ publicAuthorBindings: [binding(holder, 'missing')] }), holder],
    [snapshot({ publicAuthorBindings: [binding(), binding(holder, 'other')] }), holder],
    [snapshot({ work: [{ sessionId: holder } as NeoWork] }), holder],
  ] as const)(
    'rejects unavailable, unbound, conflicting or execution-worker scope %#',
    (value, session) => {
      const conversation = project([ask(root, 'unrelated', 1)]);
      const gate = admitNeoPublicHolderScope(conversation, value, session);
      expect('reason' in gate).toBe(true);
      expect(projectNeoPublicHolderConversation(conversation, value, session)).toMatchObject({
        status: 'unavailable',
        entries: [],
        hasEarlier: false,
        hasMore: false,
      });
    }
  );

  it('rejects a projected conversation belonging to another root before either presentation', () => {
    const conversation = { ...project(), conversationId: 'foreign-root' };
    for (const session of [root, holder]) {
      expect('reason' in admitNeoPublicHolderScope(conversation, snapshot(), session)).toBe(true);
      expect(projectNeoPublicHolderConversation(conversation, snapshot(), session).entries).toEqual(
        []
      );
    }
  });

  it('passes declared scope values and tolerates consistent duplicate bindings', () => {
    const conversation = project();
    const gate = admitNeoPublicHolderScope(
      conversation,
      snapshot({ publicAuthorBindings: [binding(), binding()] }),
      holder
    );
    expect(gate).toEqual({ value: { conversation, sessionId: holder, root } });
    if (!('value' in gate)) throw new Error('Expected admitted holder');
    expect(presentNeoPublicHolderConversation(gate.value)).toEqual(conversation);
  });
});

describe('durable public holder conversation', () => {
  it('keeps root conversation object identity without requiring holder bindings', () => {
    const conversation = project([ask(other, 'other-ask', 1)]);
    expect(
      projectNeoPublicHolderConversation(
        conversation,
        snapshot({ publicAuthorBindings: undefined }),
        root
      )
    ).toBe(conversation);
  });

  it('keeps direct asks, authored replies and exact referenced root asks without cross-holder leakage', () => {
    const rootAsk = ask(root, 'root-question', 1);
    const direct = ask(holder, 'holder-question', 2);
    const unrelated = ask(other, 'other-question', 3);
    const waiting = ask(holder, 'waiting-question', 4);
    const replies = [
      publication(holder, rootAsk.askOrigin, 5),
      publication(root, direct.askOrigin, 6),
      publication(other, unrelated.askOrigin, 7),
    ];
    const original = project([rootAsk, direct, unrelated, waiting], replies);
    const before = JSON.stringify(original);
    const scoped = projectNeoPublicHolderConversation(original, snapshot(), holder);
    expect(scoped.entries).toEqual(
      original.entries.filter((entry) =>
        entry.kind === 'ask' ? entry.ask !== unrelated : entry.publication !== replies[2]
      )
    );
    expect(scoped.entries).toHaveLength(5);
    for (const entry of scoped.entries) expect(original.entries).toContain(entry);
    expect(JSON.stringify(original)).toBe(before);
    expect(
      scoped.entries.filter((entry) => entry.kind === 'publication').map((entry) => entry.replyTo)
    ).toEqual([rootAsk, direct]);
  });

  it('does not match original asks by message id alone or infer scope from scene references', () => {
    const unrelated = ask(root, 'shared-message', 1);
    const ownReply = publication(holder, { sessionId: other, messageId: 'shared-message' }, 2);
    const foreignReply = publication(other, unrelated.askOrigin, 3);
    const original = project([unrelated], [ownReply, foreignReply]);
    const scoped = projectNeoPublicHolderConversation(original, snapshot(), holder);
    expect(scoped.entries).toHaveLength(1);
    expect(scoped.entries[0]).toBe(original.entries[1]);
    expect(scoped.entries[0]).toMatchObject({ kind: 'publication', replyTo: null });
  });

  it.each(['ready', 'loading', 'unavailable'] as const)(
    'preserves %s retained rows, authored payloads and window boundaries',
    (status) => {
      const origin = ask(holder, 'holder-question', 1);
      const original = {
        ...project([origin], [publication(holder, origin.askOrigin, 2)]),
        status,
        hasEarlier: true,
        hasMore: true,
      };
      const scoped = projectNeoPublicHolderConversation(original, snapshot(), holder);
      expect(scoped).toEqual(original);
      expect(scoped.entries[0]).toBe(original.entries[0]);
      expect(scoped.entries[1]).toBe(original.entries[1]);
    }
  );

  it('keeps a known holder empty-ready rather than showing an unrelated execution transcript', () => {
    const original = project([ask(other, 'unrelated', 1)]);
    expect(projectNeoPublicHolderConversation(original, snapshot(), holder)).toEqual({
      conversationId: id,
      status: 'ready',
      entries: [],
      hasEarlier: false,
      hasMore: false,
    });
  });

  it('uses durable bindings for every retained reply without depending on recent consultations', () => {
    const replies = Array.from({ length: 500 }, (_, index) => ({
      ...publication(
        index % 2 ? other : holder,
        { sessionId: root, messageId: 'outside-window' },
        1
      ),
      publicationId: `retained-${index}`,
      sequence: index + 1,
    }));
    const original = project([], replies);
    const scoped = projectNeoPublicHolderConversation(
      { ...original, hasEarlier: true },
      snapshot({ consultations: [] }),
      holder
    );
    expect(scoped.entries).toHaveLength(250);
    expect(scoped.hasEarlier).toBe(true);
    expect(scoped.entries).toEqual(original.entries.filter((_, index) => index % 2 === 0));
    expect(
      scoped.entries.every((entry) => entry.kind === 'publication' && entry.replyTo === null)
    ).toBe(true);
    expect(projectNeoPublicHolderConversation(original, snapshot(), other).entries).toHaveLength(
      250
    );
  });
});
