import { describe, expect, it } from 'vitest';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import {
  admitNeoPublicSources,
  neoWorkSummaries,
  neoWorkSummary,
  projectNeoPublicConversation,
  requireNeoPublicIdentities,
} from '../public-conversation.ts';
import type { NeoAskState } from '../useNeoConversationAsks.ts';
import type { NeoPublicationState } from '../useNeoPublications.ts';

const id = '10000000-0000-4000-8000-000000000001';
const root = `neo:${id}`;
const at = '2026-09-30T20:00:00.000Z';
const ask = (sequence = 1, sessionId = root): NeoConversationAsk => ({
  conversationId: id,
  requestId: `ask-${sequence}`,
  sequence,
  createdAt: at,
  askOrigin: { sessionId, messageId: `ask-${sequence}` },
  content: [{ type: 'text', text: `Keep fictional draft ${sequence}.` }],
});
const publication = (sequence = 1): NeoPublication => ({
  conversationId: id,
  publicationId: `publication-${sequence}`,
  sequence,
  createdAt: at,
  askOrigin: ask().askOrigin,
  producerInput: { sessionId: 'holder:fictional', messageId: 'neo-consult:check:request' },
  shortText: 'The draft is ready.',
  fullText: '**Full detail**. Nothing was sent.',
  links: [{ kind: 'work', id: 'work:1', label: 'View the draft' }],
});
const asks = (items: readonly NeoConversationAsk[] = [ask()]): NeoAskState => ({
  conversationId: id,
  status: 'ready',
  items,
  nextAfter: items.at(-1)?.sequence ?? 0,
  hasMore: false,
  hasEarlier: false,
});
const publications = (items: readonly NeoPublication[] = [publication()]): NeoPublicationState => ({
  conversationId: id,
  status: 'ready',
  items,
  nextAfter: items.at(-1)?.sequence ?? 0,
  hasMore: false,
  hasEarlier: false,
});

describe('durable public conversation projection', () => {
  it('keeps authored content, producer attribution and labelled detail without an SDK transcript', () => {
    const a = ask();
    const p = publication();
    const result = projectNeoPublicConversation(root, asks([a]), publications([p]));
    expect(result).toMatchObject({
      conversationId: id,
      status: 'ready',
      entries: [
        { kind: 'ask', ask: a },
        { kind: 'publication', publication: p, replyTo: a },
      ],
    });
    const reply = result.entries[1];
    if (reply.kind !== 'publication') throw new Error('Expected publication');
    expect(reply.publication).toBe(p);
    expect(reply.publication.producerInput.sessionId).toBe('holder:fictional');
    expect(reply.publication.shortText).toBe('The draft is ready.');
    expect(reply.publication.fullText).toBe('**Full detail**. Nothing was sent.');
    expect(reply.publication.links).toEqual([
      { kind: 'work', id: 'work:1', label: 'View the draft' },
    ]);
    expect(result.entries.map((entry) => entry.key)).toEqual([
      JSON.stringify([id, 'ask', a.requestId]),
      JSON.stringify([id, 'publication', p.publicationId]),
    ]);
  });

  it('retains photos, Markdown and attachment text without rewriting the immutable ask', () => {
    const a = {
      ...ask(),
      content: [
        { type: 'text' as const, text: '**Draft**\nAttached file: fictional-notes.txt' },
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/png' as const,
            data: 'ZmFrZQ==',
          },
        },
      ],
    };
    const before = structuredClone(a);
    const result = projectNeoPublicConversation(root, asks([a]), publications([]));
    expect(result.entries).toMatchObject([{ kind: 'ask', ask: before }]);
    expect(a).toEqual(before);
  });

  it('joins the recorded session/message pair, not a newer ask or a message-only match', () => {
    const original = ask();
    const newer = ask(2);
    const wrongSession = ask(1, 'holder:other');
    const result = projectNeoPublicConversation(root, asks([original, newer]), publications());
    const reply = result.entries.find((entry) => entry.kind === 'publication');
    expect(reply).toMatchObject({ replyTo: original });
    const missing = projectNeoPublicConversation(root, asks([newer, wrongSession]), publications());
    expect(missing.entries.find((entry) => entry.kind === 'publication')).toMatchObject({
      replyTo: null,
    });
  });

  it('keeps delayed replies honest when the original ask is outside the retained window', () => {
    const result = projectNeoPublicConversation(
      root,
      { ...asks([]), hasEarlier: true },
      publications()
    );
    expect(result).toMatchObject({
      hasEarlier: true,
      entries: [{ kind: 'publication', publication: publication(), replyTo: null }],
    });
  });

  it('orders independent ledger timestamps deterministically with asks first on ties', () => {
    const laterAsk = { ...ask(2), createdAt: '2026-09-30T20:00:01.000Z' };
    const earlierReply = { ...publication(2), createdAt: '2026-09-30T19:59:59.000Z' };
    const a = [laterAsk, ask()];
    const p = [publication(), earlierReply];
    const first = projectNeoPublicConversation(root, asks(a), publications(p));
    const reordered = projectNeoPublicConversation(
      root,
      asks([...a].reverse()),
      publications([...p].reverse())
    );
    expect(first.entries).toEqual(reordered.entries);
    expect(
      first.entries.map((entry) =>
        entry.kind === 'ask' ? entry.ask.requestId : entry.publication.publicationId
      )
    ).toEqual(['publication-2', 'ask-1', 'publication-1', 'ask-2']);
    expect(a[0]).toBe(laterAsk);
    expect(p[0].publicationId).toBe('publication-1');
    expect(first.entries[2].key).toBe(reordered.entries[2].key);
  });

  it.each(['idle', 'loading', 'unavailable', 'ready'] as const)(
    'preserves data while exposing %s client state instead of claiming readiness',
    (status) => {
      const result = projectNeoPublicConversation(
        root,
        { ...asks(), status, hasMore: true },
        publications()
      );
      expect(result.status).toBe(
        status === 'ready' ? 'ready' : status === 'unavailable' ? 'unavailable' : 'loading'
      );
      expect(result.entries).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(projectNeoPublicConversation(root, asks(), { ...publications(), status }).status).toBe(
        result.status
      );
    }
  );

  it.each([null, 'ordinary', 'neo:invalid', 'neo:20000000-0000-4000-8000-000000000002'])(
    'refuses unavailable or switched root %s without leaking retained data',
    (sessionId) => {
      const result = projectNeoPublicConversation(sessionId, asks(), publications());
      expect(result.status).toBe('unavailable');
      expect(result.entries).toEqual([]);
      expect(admitNeoPublicSources(sessionId, asks(), publications())).toHaveProperty('reason');
    }
  );

  it.each(['asks', 'publications'] as const)('refuses a mismatched %s client', (which) => {
    const a = asks();
    const p = publications();
    if (which === 'asks') a.conversationId = 'other';
    else p.conversationId = 'other';
    expect(projectNeoPublicConversation(root, a, p).entries).toEqual([]);
  });

  it.each([
    'duplicate-id',
    'duplicate-sequence',
    'foreign',
    'invalid-date',
    'zero-sequence',
    'oversize',
  ])('refuses %s rows in either ledger at the identity gate', (kind) => {
    const variants = <T extends NeoConversationAsk | NeoPublication>(one: T, two: T): T[] => {
      if (kind === 'duplicate-id') return [one, { ...one, sequence: 2 }];
      if (kind === 'duplicate-sequence') return [one, { ...two, sequence: 1 }];
      if (kind === 'foreign') return [{ ...one, conversationId: 'other' }];
      if (kind === 'invalid-date') return [{ ...one, createdAt: 'not-a-time' }];
      if (kind === 'zero-sequence') return [{ ...one, sequence: 0 }];
      return Array.from({ length: 501 }, (_, i) => ({
        ...one,
        sequence: i + 1,
        ...('requestId' in one
          ? { requestId: `ask-${i}`, askOrigin: { ...one.askOrigin, messageId: `ask-${i}` } }
          : { publicationId: `publication-${i}` }),
      }));
    };
    const a = asks(variants(ask(), ask(2)));
    const p = publications(variants(publication(), publication(2)));
    expect(requireNeoPublicIdentities({ asks: a, publications: publications() })).toHaveProperty(
      'reason'
    );
    expect(requireNeoPublicIdentities({ asks: asks(), publications: p })).toHaveProperty('reason');
    expect(projectNeoPublicConversation(root, a, publications()).entries).toEqual([]);
    expect(projectNeoPublicConversation(root, asks(), p).entries).toEqual([]);
  });

  it('allows identical raw ids across the two ledger namespaces without key collisions', () => {
    const p = { ...publication(), publicationId: ask().requestId };
    const result = projectNeoPublicConversation(root, asks(), publications([p]));
    expect(result.status).toBe('ready');
    expect(new Set(result.entries.map((entry) => entry.key)).size).toBe(2);
  });

  it('refuses an ask id that contradicts its immutable original message', () => {
    const a = asks([{ ...ask(), askOrigin: { ...ask().askOrigin, messageId: 'other' } }]);
    expect(requireNeoPublicIdentities({ asks: a, publications: publications() })).toHaveProperty(
      'reason'
    );
    expect(projectNeoPublicConversation(root, a, publications()).entries).toEqual([]);
  });
});

describe('neoWorkSummaries', () => {
  it('takes Neo’s latest publication linked to each work, short text first', () => {
    const entry = (item: NeoPublication) => ({
      kind: 'publication' as const,
      key: item.publicationId,
      publication: item,
      replyTo: null,
    });
    const later = {
      ...publication(2),
      shortText: ' ',
      fullText: 'Blocked: two files are missing.',
    };
    const other = { ...publication(3), links: [] };
    const summaries = neoWorkSummaries([
      entry(publication(1)),
      { kind: 'ask', key: 'a', ask: ask() },
      entry(later),
      entry(other),
    ]);
    expect([...summaries]).toEqual([
      ['work:1', { text: 'Blocked: two files are missing.', at: Date.parse(at) }],
    ]);
    expect(neoWorkSummaries([entry(publication(1))]).get('work:1')?.text).toBe(
      'The draft is ready.'
    );
    expect([...neoWorkSummaries(undefined)]).toEqual([]);
  });

  it('ignores what Neo said about a work before its latest change, like the hand-off note', () => {
    const summaries = new Map([['work:1', { text: 'Handed it to Codex.', at: 100 }]]);
    expect(neoWorkSummary(summaries, { id: 'work:1', updatedAt: 100 })).toBe('Handed it to Codex.');
    expect(neoWorkSummary(summaries, { id: 'work:1', updatedAt: 101 })).toBeUndefined();
    expect(neoWorkSummary(summaries, { id: 'work:2', updatedAt: 0 })).toBeUndefined();
  });
});
