import { describe, expect, it } from 'vitest';
import type {
  NeoConcern,
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoPublicationState } from '../useNeoPublications.ts';
import {
  admitNeoPublicAuthorSources,
  presentNeoPublicAuthors,
  projectNeoPublicAuthors,
} from '../public-authors.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'fictional-holder-session';
const binding = () => ({
  sessionId: holder,
  concernId: 'fictional-context',
  kind: 'concern' as const,
});
const concern = (id = 'fictional-context', title = 'Source context'): NeoConcern => ({
  id,
  title,
  summary: 'Summary',
  context: 'Context',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});
const consultation = (fields: Partial<NeoConsultation> = {}): NeoConsultation => ({
  id: 'check',
  requestKey: 'request',
  concernId: concern().id,
  originSessionId: root,
  originMessageId: 'ask',
  sessionId: holder,
  question: 'Compare sources',
  status: 'reported',
  answer: 'Authored answer',
  createdAt: 1,
  ...fields,
});
const publication = (producer = holder): NeoPublication => ({
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: root, messageId: 'ask' },
  producerInput: { sessionId: producer, messageId: 'consult-input' },
  shortText: 'Authored short answer',
  fullText: 'Authored complete answer',
  links: [{ kind: 'concern', id: 'unrelated', label: 'Never infer this author' }],
  sequence: 1,
  createdAt: '2026-09-30T12:00:00Z',
});
const state = (items = [publication()]): NeoPublicationState => ({
  conversationId,
  status: 'ready',
  items,
  nextAfter: items.length,
  hasEarlier: false,
  hasMore: false,
});
const snapshot = (fields: Partial<NeoSnapshot> = {}): NeoSnapshot => ({
  ok: true,
  sessionId: root,
  concerns: [concern()],
  work: [],
  consultations: [consultation()],
  publicAuthorBindings: [binding()],
  ...fields,
});

describe('public author source admission', () => {
  it.each([
    [null, state()],
    [snapshot({ sessionId: holder }), state()],
    [snapshot(), { ...state(), conversationId: null }],
    [snapshot(), { ...state(), conversationId: 'foreign-conversation' }],
    [snapshot(), state([{ ...publication(), conversationId: 'foreign-conversation' }])],
    [snapshot(), state(Array.from({ length: 501 }, () => publication()))],
  ] as const)('rejects mismatched or unbounded sources %#', (value, publications) => {
    const gate = admitNeoPublicAuthorSources(value, publications);
    expect('reason' in gate).toBe(true);
    expect(projectNeoPublicAuthors(value, publications).size).toBe(0);
  });

  it('passes the actual matching sources to the presentation stage', () => {
    const value = snapshot();
    const publications = state();
    expect(admitNeoPublicAuthorSources(value, publications)).toEqual({
      value: { snapshot: value, publications },
    });
    expect(presentNeoPublicAuthors({ snapshot: value, publications }).get(holder)).toBe(
      'Source context'
    );
  });
});

describe('public author label projection', () => {
  it('keeps the oldest retained producer labelled after newer consultations displace its receipt', () => {
    const newer = Array.from({ length: 20 }, (_, index) =>
      consultation({
        id: `new-${index}`,
        sessionId: `new-holder-${index}`,
        concernId: `new-context-${index}`,
      })
    );
    const value = {
      ...snapshot({ consultations: newer }),
      publicAuthorBindings: [
        { sessionId: holder, concernId: concern().id, kind: 'concern' as const },
      ],
    };
    const items = [
      publication(),
      ...Array.from({ length: 499 }, (_, index) => ({
        ...publication(root),
        sequence: index + 2,
        publicationId: `20000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
      })),
    ];
    expect(value.consultations?.some((item) => item.sessionId === holder)).toBe(false);
    expect(items).toHaveLength(500);
    expect(projectNeoPublicAuthors(value, state(items)).get(holder)).toBe('Source context');
    expect(projectNeoPublicAuthors(value, { ...state(items), status: 'loading' }).get(holder)).toBe(
      'Source context'
    );
  });

  it('labels only actual visible producers without changing authored payloads', () => {
    const items = [publication(holder), publication(root), publication('unknown')];
    const value = snapshot();
    const before = JSON.stringify({ value, items });
    const labels = projectNeoPublicAuthors(value, state(items));
    expect([...labels]).toEqual([
      [holder, 'Source context'],
      [root, 'Neo'],
    ]);
    expect(labels.has('unknown')).toBe(false);
    expect(labels.has('unrelated')).toBe(false);
    expect(JSON.stringify({ value, items })).toBe(before);
  });

  it.each(['loading', 'unavailable'] as const)(
    'keeps attribution for retained %s entries',
    (status) => {
      expect(projectNeoPublicAuthors(snapshot(), { ...state(), status }).get(holder)).toBe(
        'Source context'
      );
    }
  );

  it('does not attribute an ask origin or link label to an unknown producer', () => {
    expect(projectNeoPublicAuthors(snapshot(), state([publication('other-session')])).size).toBe(0);
    expect(projectNeoPublicAuthors(snapshot(), state([])).size).toBe(0);
  });

  it('labels queued holders from durable bindings without a completed consultation', () => {
    const waiter: NeoConsultationWaiter = {
      ...consultation(),
      status: 'queued',
      originMessageId: 'ask',
    };
    expect(
      projectNeoPublicAuthors(
        snapshot({ consultations: [], consultationWaiters: [waiter] }),
        state()
      ).get(holder)
    ).toBe('Source context');
  });

  it.each([
    { concerns: [] },
    { concerns: [concern('fictional-context', ' ')] },
    { concerns: [concern(), concern('fictional-context', 'Conflicting title')] },
    { publicAuthorBindings: [binding(), { ...binding(), concernId: 'different-context' }] },
    { publicAuthorBindings: [] },
    { publicAuthorBindings: undefined },
  ])('leaves absent or conflicting associations unlabelled %#', (fields) => {
    expect(projectNeoPublicAuthors(snapshot(fields), state()).has(holder)).toBe(false);
  });

  it('accepts repeated consistent associations but never promotes execution workers to holders', () => {
    const value = snapshot({
      consultations: [consultation(), consultation({ id: 'second' })],
      publicAuthorBindings: [binding(), binding()],
    });
    expect(projectNeoPublicAuthors(value, state()).get(holder)).toBe('Source context');
    const work: NeoWork = {
      id: 'work',
      requestKey: 'work-request',
      concernId: concern().id,
      originSessionId: root,
      originMessageId: 'ask',
      title: 'Work',
      instruction: 'Do work',
      sessionId: holder,
      status: 'queued',
      report: null,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(projectNeoPublicAuthors({ ...value, work: [work] }, state()).has(holder)).toBe(false);
    expect(
      projectNeoPublicAuthors(
        snapshot({ work: [{ ...work, sessionId: 'worker' }] }),
        state([publication('worker')])
      ).size
    ).toBe(0);
  });
});
