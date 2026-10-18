import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  isNeoPublicationViewReset,
  isNeoSlashCommand,
  NEO_PUBLICATION_VIEW_RECENT,
  neoPublicationViewNote,
  nextNeoPublicationAnchor,
  readNeoPublicationView,
  readNeoTurnInput,
  withNeoPublicationView,
} from '../../../../src/lib/neo/publication-view.ts';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoPublicationAnchorRepository } from '../../../../src/storage/repositories/neo-publication-anchor-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder';
const cursor = { at: '2026-10-16T10:00:00.000Z', role: 'human' as const, sequence: 1 };

describe('isNeoPublicationViewReset', () => {
  test('resets missing, legacy, fresh and compacted cursors while retaining a resumed context', () => {
    const anchor = { cursor, compaction: 10 };
    expect(isNeoPublicationViewReset(null, { fresh: false, compaction: 10 })).toBe(true);
    expect(
      isNeoPublicationViewReset({ cursor: null, compaction: 10 }, { fresh: false, compaction: 10 })
    ).toBe(true);
    expect(isNeoPublicationViewReset(anchor, { fresh: true, compaction: 10 })).toBe(true);
    expect(isNeoPublicationViewReset(anchor, { fresh: false, compaction: 12 })).toBe(true);
    expect(isNeoPublicationViewReset(anchor, { fresh: false, compaction: 10 })).toBe(false);
  });
});

describe('withNeoPublicationView', () => {
  test('adds recorded context without changing the original message or its attachment blocks', () => {
    const text = { uuid: 'm1', message: { role: 'user', content: 'Hi' } };
    expect(withNeoPublicationView(text, 'Seen.')).toEqual({
      uuid: 'm1',
      message: { role: 'user', content: 'Hi\n\nSeen.' },
    });
    expect(text.message.content).toBe('Hi');
    const image = { type: 'image', source: { type: 'url', url: 'https://example.com/photo' } };
    const blocks = { message: { content: [{ type: 'text', text: 'Hi' }, image] } };
    expect(withNeoPublicationView(blocks, 'Seen.').message.content).toEqual([
      ...blocks.message.content,
      { type: 'text', text: 'Seen.' },
    ]);
    expect(withNeoPublicationView(text, null)).toBe(text);
  });
});

describe('isNeoSlashCommand', () => {
  test('a prompt whose first token starts with a slash is a command', () => {
    const input = (content: unknown) => ({ message: { content } });
    expect(isNeoSlashCommand(input('/compact'))).toBe(true);
    expect(isNeoSlashCommand(input('  /compact keep the PR list'))).toBe(true);
    expect(isNeoSlashCommand(input([{ type: 'text', text: '/clear' }]))).toBe(true);
    expect(isNeoSlashCommand(input('compact /now'))).toBe(false);
    expect(isNeoSlashCommand(input([{ type: 'image' }, { type: 'text', text: 'hi' }]))).toBe(false);
    expect(isNeoSlashCommand({})).toBe(false);
  });
});

describe('recorded conversation injection', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let count = 0;
  const human = (text = `Human ${count + 1}.`) => {
    count++;
    const requestId = `30000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
    const result = new NeoConversationAskRepository(db.getDatabase()).append({
      conversationId,
      requestId,
      askOrigin: { sessionId: holder, messageId: requestId },
      content: text,
    });
    if (!result.accepted) throw new Error('human fixture rejected');
    stamp('neo_conversation_asks', result.ask.sequence);
    return result.ask;
  };
  const publish = (text = `Reply ${count + 1}.`) => {
    count++;
    const result = new NeoPublicationRepository(db.getDatabase()).append({
      conversationId,
      publicationId: `20000000-0000-4000-8000-${String(count).padStart(12, '0')}`,
      askOrigin: { sessionId: holder, messageId: 'human-1' },
      producerInput: { sessionId: holder, messageId: `input-${count}` },
      shortText: text,
      fullText: `${text}\nFull details.`,
      links: [],
    });
    if (!result.accepted) throw new Error('publication fixture rejected');
    stamp('neo_publications', result.publication.sequence);
    return result.publication;
  };
  const stamp = (table: 'neo_conversation_asks' | 'neo_publications', sequence: number) =>
    db
      .getDatabase()
      .prepare(`UPDATE ${table} SET created_at = ? WHERE sequence = ?`)
      .run(new Date(Date.UTC(2026, 9, 16, 10, count)).toISOString(), sequence);
  const entries = (fresh = false, sessionId = holder) =>
    (readNeoPublicationView(db, sessionId, fresh).note ?? '')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
  const texts = (fresh = false, sessionId = holder) =>
    entries(fresh, sessionId).map((item) =>
      item.role === 'human' ? item.ask.content[0].text : item.publication.shortText
    );
  beforeEach(async () => {
    db = await createTestDb();
    count = 0;
    db.createSession(createTestSession(holder));
    db.createSession(createTestSession(root));
    new NeoRepository(db.getDatabase()).reserveBinding({
      sessionId: root,
      kind: 'neo',
      projectId: null,
    });
  });
  afterEach(() => db.close());

  test('injects the latest seven recorded messages from both sides, with independent session cursors', () => {
    for (let i = 0; i < 10; i++) i % 2 ? publish() : human();
    expect(NEO_PUBLICATION_VIEW_RECENT).toBe(7);
    const recent = [
      'Reply 4.',
      'Human 5.',
      'Reply 6.',
      'Human 7.',
      'Reply 8.',
      'Human 9.',
      'Reply 10.',
    ];
    expect(texts(true)).toEqual(recent);
    expect(texts()).toEqual([]);
    expect(texts(false, root)).toEqual(recent);
    human();
    publish();
    expect(texts()).toEqual(['Human 11.', 'Reply 12.']);
    expect(texts(false, root)).toEqual(['Human 11.', 'Reply 12.']);
    expect(texts()).toEqual([]);
  });

  test('fresh context and compaction restore the human words verbatim from the ledger', () => {
    const words = '  Please keep MY wording.\nUse  two spaces — 不要改写。\n';
    human(words);
    publish('Recorded answer.');
    expect(texts(true)).toEqual([words, 'Recorded answer.']);
    expect(texts()).toEqual([]);
    db.getSDKMessageRepo().saveSDKMessage(holder, {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compacted',
      session_id: holder,
      compact_metadata: { trigger: 'auto', pre_tokens: 1 },
    } as unknown as SDKUserMessage);
    expect(texts()).toEqual([words, 'Recorded answer.']);
    expect(texts()).toEqual([]);
    expect(texts(true)).toEqual([words, 'Recorded answer.']);
    expect(
      new NeoConversationAskRepository(db.getDatabase()).list(conversationId)?.[0].content
    ).toEqual([{ type: 'text', text: words }]);
  });

  test('a slash command reaches the session bare and leaves the view for the next input', async () => {
    human();
    publish();
    const anchors = new NeoPublicationAnchorRepository(db.getDatabase());
    const before = anchors.get(holder);
    let snapshots = 0;
    const snapshot = async () => `Snapshot ${++snapshots}.`;
    const command = { uuid: 'c1', message: { role: 'user', content: '/compact' } };
    const skipped = await readNeoTurnInput(db, holder, command, true, snapshot);
    expect(skipped).toEqual({ input: command, viewed: false });
    expect(anchors.get(holder)).toEqual(before);
    expect(snapshots).toBe(0);
    const next = { uuid: 'm2', message: { role: 'user', content: 'Hi' } };
    const fed = await readNeoTurnInput(db, holder, next, true, snapshot);
    expect(fed.viewed).toBe(true);
    expect(fed.input.message.content).toStartWith(
      'Hi\n\nSnapshot 1.\n\nRecent recorded conversation'
    );
    expect(fed.input.message.content).toContain('Reply 2.');
  });

  test('an empty context stays readable and receives its first human message later', () => {
    expect(entries(true)).toEqual([]);
    expect(entries()).toEqual([]);
    human();
    expect(texts()).toEqual(['Human 1.']);
    expect(texts()).toEqual([]);
  });

  test('incremental injection stays at seven and older facts remain available through the reader', () => {
    human();
    texts(true);
    for (let i = 0; i < 12; i++) publish();
    expect(texts()).toEqual(Array.from({ length: 7 }, (_, i) => `Reply ${i + 7}.`));
    expect(
      new NeoConversationReader(db.getDatabase()).read({ conversationId, limit: 50 }).items
    ).toHaveLength(13);
  });

  test('full published details and revisions survive recovery without routing-log paraphrases', () => {
    human('My exact question.');
    const publication = publish('First answer.');
    texts(true);
    const changed = new NeoPublicationRepository(db.getDatabase()).edit(
      conversationId,
      publication.publicationId,
      { shortText: 'Revised.', fullText: 'Exact revised details.' },
      '2026-10-16T12:00:00.000Z',
      holder,
      { sessionId: holder, messageId: 'revision-input' },
      '40000000-0000-4000-8000-000000000001'
    );
    expect(changed.accepted).toBe(true);
    const restored = entries(true);
    expect(restored[0].ask.content).toEqual([{ type: 'text', text: 'My exact question.' }]);
    expect(restored[1].publication.fullText).toBe('Exact revised details.');
    expect(restored[1].publication.revisions[0].fullText).toBe('First answer.\nFull details.');
  });

  test('anchors advance to the last injected item and reset when a fresh context has no messages', () => {
    human();
    publish();
    const seen = new NeoConversationReader(db.getDatabase()).read({
      conversationId,
      limit: 7,
    }).items;
    const mark = { fresh: false, compaction: 3 };
    const anchor = { cursor, compaction: 3 };
    expect(nextNeoPublicationAnchor(anchor, seen, mark)).toEqual({
      cursor: seen.at(-1)?.cursor,
      compaction: 3,
    });
    expect(nextNeoPublicationAnchor(anchor, [], mark)).toEqual(anchor);
    expect(nextNeoPublicationAnchor(anchor, [], { fresh: true, compaction: 3 })).toEqual({
      cursor: null,
      compaction: 3,
    });
    expect(neoPublicationViewNote([], true)).toBeNull();
    expect(neoPublicationViewNote(seen, true)).toContain('neo.conversation.read');
    entries(true);
    expect(new NeoPublicationAnchorRepository(db.getDatabase()).get(holder)?.cursor).toEqual(
      seen.at(-1)?.cursor
    );
  });
});
