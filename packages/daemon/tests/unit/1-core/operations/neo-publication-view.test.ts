import { beforeEach, describe, expect, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoPublication, NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import {
  isNeoPublicationViewReset,
  NEO_PUBLICATION_VIEW_RECENT,
  neoPublicationViewNote,
  nextNeoPublicationAnchor,
  readNeoPublicationView,
  withNeoPublicationView,
} from '../../../../src/lib/neo/publication-view.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder';
const said = (sequence: number, extra: Partial<NeoPublication> = {}) =>
  ({
    sequence,
    createdAt: `2026-10-15T21:0${sequence}:00.000Z`,
    shortText: `Told ${sequence}.`,
    askSummary: 'Add .DS_Store',
    ...extra,
  }) as NeoPublication;

describe('isNeoPublicationViewReset', () => {
  test('resets for a new session, a fresh context or a compaction, not for a resumed one', () => {
    const anchor = { sequence: 5, compaction: 10 };
    expect(isNeoPublicationViewReset(null, { fresh: false, compaction: 10 })).toBe(true);
    expect(isNeoPublicationViewReset(anchor, { fresh: true, compaction: 10 })).toBe(true);
    expect(isNeoPublicationViewReset(anchor, { fresh: false, compaction: 12 })).toBe(true);
    expect(isNeoPublicationViewReset(anchor, { fresh: false, compaction: 10 })).toBe(false);
  });
});

describe('nextNeoPublicationAnchor', () => {
  test('moves to the last item given, or stays put when nothing was new', () => {
    const mark = { fresh: false, compaction: 3 };
    expect(
      nextNeoPublicationAnchor({ sequence: 5, compaction: 3 }, [said(6), said(7)], mark)
    ).toEqual({
      sequence: 7,
      compaction: 3,
    });
    expect(nextNeoPublicationAnchor({ sequence: 5, compaction: 1 }, [], mark)).toEqual({
      sequence: 5,
      compaction: 3,
    });
  });
});

describe('neoPublicationViewNote', () => {
  test('lists what the human read, oldest first, and leaves out interim posts', () => {
    const note = neoPublicationViewNote(
      [said(6), said(7, { interim: true }), said(8, { corrects: 'p6', askSummary: undefined })],
      false
    );
    expect(note).toBe(
      [
        'What the human has read from Neo since your last turn, oldest first:',
        '- 2026-10-15T21:06:00.000Z, on "Add .DS_Store": Told 6.',
        '- 2026-10-15T21:08:00.000Z (correction): Told 8.',
        'The human already has these.',
      ].join('\n')
    );
    expect(neoPublicationViewNote([said(7, { interim: true })], true)).toBeNull();
  });
});

describe('withNeoPublicationView', () => {
  test('adds the note after the input text and leaves the input itself unchanged', () => {
    const text = { uuid: 'm1', message: { role: 'user', content: 'Hi' } };
    expect(withNeoPublicationView(text, 'Seen.')).toEqual({
      uuid: 'm1',
      message: { role: 'user', content: 'Hi\n\nSeen.' },
    });
    expect(text.message.content).toBe('Hi');
    const blocks = { message: { content: [{ type: 'text', text: 'Hi' }] } };
    expect(withNeoPublicationView(blocks, 'Seen.').message.content).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'text', text: 'Seen.' },
    ]);
    expect(withNeoPublicationView(text, null)).toBe(text);
  });
});

describe('Neo turn publication view', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let count = 0;
  const publish = () => {
    count += 1;
    const input: NeoPublicationInput = {
      conversationId,
      publicationId: `20000000-0000-4000-8000-${String(count).padStart(12, '0')}`,
      askOrigin: { sessionId: holder, messageId: 'human-1' },
      producerInput: { sessionId: holder, messageId: 'human-1' },
      shortText: `Reply ${count}.`,
      fullText: `Reply ${count}.`,
      links: [],
    };
    new NeoPublicationRepository(db.getDatabase()).append(input);
  };
  const shown = (fresh = false) =>
    (readNeoPublicationView(db, holder, fresh) ?? '')
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.split(': ').at(-1));

  beforeEach(async () => {
    db = await createTestDb();
    count = 0;
    db.createSession(createTestSession(holder));
    new NeoRepository(db.getDatabase()).reserveBinding({
      sessionId: root,
      kind: 'neo',
      projectId: null,
    });
  });

  test('a turn sees only what was said since its last turn, and a new context sees the recent window again', () => {
    for (let i = 0; i < NEO_PUBLICATION_VIEW_RECENT + 2; i++) publish();
    expect(shown(true)).toEqual([
      'Reply 3.',
      'Reply 4.',
      'Reply 5.',
      'Reply 6.',
      'Reply 7.',
      'Reply 8.',
    ]);
    expect(shown()).toEqual([]);
    publish();
    publish();
    expect(shown()).toEqual(['Reply 9.', 'Reply 10.']);
    expect(shown()).toEqual([]);
    db.getSDKMessageRepo().saveSDKMessage(holder, {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compacted',
      session_id: holder,
      compact_metadata: { trigger: 'auto', pre_tokens: 1 },
    } as unknown as SDKUserMessage);
    expect(shown()).toEqual([
      'Reply 5.',
      'Reply 6.',
      'Reply 7.',
      'Reply 8.',
      'Reply 9.',
      'Reply 10.',
    ]);
  });

  test('a resumed turn sees the replies its interrupted turn already posted', () => {
    expect(shown(true)).toEqual([]);
    publish();
    publish();
    expect(shown()).toEqual(['Reply 1.', 'Reply 2.']);
  });
});
