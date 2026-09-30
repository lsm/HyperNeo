import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { Database as DaemonDatabase } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { admitNeoPublication } from '../../../../src/lib/neo/publication.ts';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../../../../src/lib/db-query/scope-config.ts';

const input: NeoPublicationInput = {
  conversationId: '10000000-0000-4000-8000-000000000001',
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: 'public-intake', messageId: 'original-ask' },
  producerInput: { sessionId: 'avatar', messageId: 'internal-input' },
  shortText: 'The comparison is ready. [View comparison]',
  fullText: 'Two sources agree; the third differs. Nothing was published.',
  links: [{ label: 'View comparison', kind: 'work', id: 'work-1' }],
};
const otherConversation = '10000000-0000-4000-8000-000000000002';
const next = (number: number): NeoPublicationInput => ({
  ...input,
  publicationId: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
});

describe('Neo publication ledger', () => {
  let db: Database;
  let repo: NeoPublicationRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    createNeoTables(db);
    runMigration288(db);
    repo = new NeoPublicationRepository(db);
  });
  afterEach(() => db.close());

  test('stores the complete authored publication in one immutable synchronous append', () => {
    const result = repo.append(input);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ accepted: true, created: true, publication: input });
    if (!result.accepted) throw new Error('Expected accepted publication');
    expect(result.publication.sequence).toBe(1);
    expect(new Date(result.publication.createdAt).toISOString()).toBe(result.publication.createdAt);
    expect(repo.list(input.conversationId)).toEqual([result.publication]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM neo_publications').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT * FROM neo_work').all()).toEqual([]);
  });

  test('identical retries preserve original sequence and timestamp despite object key order', () => {
    const first = repo.append(input);
    expect(first.accepted).toBe(true);
    const retry = repo.append({
      links: [{ id: 'work-1', kind: 'work', label: 'View comparison' }],
      fullText: input.fullText,
      shortText: input.shortText,
      producerInput: { messageId: 'internal-input', sessionId: 'avatar' },
      askOrigin: { messageId: 'original-ask', sessionId: 'public-intake' },
      publicationId: input.publicationId,
      conversationId: input.conversationId,
    });
    expect(retry).toEqual({ ...first, created: false });
    expect(repo.list(input.conversationId)).toHaveLength(1);
  });

  test.each([
    { shortText: 'Changed short reply' },
    { fullText: 'Changed details' },
    { askOrigin: { ...input.askOrigin, messageId: 'other-ask' } },
    { producerInput: { ...input.producerInput, sessionId: 'other-avatar' } },
    { links: [{ label: 'Changed label', kind: 'work', id: 'work-1' }] },
    { links: [{ label: 'View comparison', kind: 'concern', id: 'work-1' }] },
    { links: [{ label: 'View comparison', kind: 'work', id: 'work-2' }] },
    { links: [] },
  ])('conflicting retry cannot rewrite any authored content or attribution: %j', (patch) => {
    const first = repo.append(input);
    expect(repo.append({ ...input, ...patch })).toEqual({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(first.accepted && repo.list(input.conversationId)).toEqual(
      first.accepted ? [first.publication] : false
    );
  });

  test.each([
    null,
    {},
    { ...input, conversationId: 'not-a-uuid' },
    { ...input, publicationId: 'not-a-uuid' },
    { ...input, shortText: ' ' },
    { ...input, shortText: 'a'.repeat(2001) },
    { ...input, fullText: '' },
    { ...input, fullText: 'a'.repeat(16001) },
    { ...input, askOrigin: { sessionId: ' ', messageId: 'ask' } },
    { ...input, producerInput: { sessionId: 'avatar', messageId: '' } },
    { ...input, producerInput: { ...input.producerInput, authority: 'human' } },
    { ...input, createdAt: '2020-01-01' },
    { ...input, sequence: 99 },
    { ...input, links: [{ label: 'Open', kind: 'url', id: 'https://example.com' }] },
    { ...input, links: [{ label: 'Open', kind: 'work', id: 'work', href: '/sessions/private' }] },
    { ...input, links: [{ label: ' ', kind: 'work', id: 'work' }] },
    { ...input, links: [{ label: 'a'.repeat(121), kind: 'work', id: 'work' }] },
    { ...input, links: [{ label: 'Open', kind: 'work', id: 'a'.repeat(161) }] },
    { ...input, links: Array.from({ length: 17 }, () => input.links[0]) },
  ])('invalid publication is rejected before persistence: %j', (value) => {
    expect(admitNeoPublication(value)).toEqual({ reason: 'invalid_publication' });
    expect(repo.append(value)).toEqual({ accepted: false, reason: 'invalid_publication' });
    expect(repo.list(input.conversationId)).toEqual([]);
  });

  test('maximum bounds, Unicode, authored whitespace and link ordering are preserved', () => {
    const bounded = {
      ...input,
      shortText: 'a'.repeat(2000),
      fullText: 'a'.repeat(16000),
      links: Array.from({ length: 16 }, (_, index) => ({
        label: 'a'.repeat(120),
        kind: 'concern',
        id: `${index}${'a'.repeat(158)}`,
      })),
    };
    expect(repo.append(bounded)).toMatchObject({ accepted: true, publication: bounded });
    const authored = {
      ...next(2),
      shortText: '  准备好了。\n',
      fullText: '\n**Details**\n',
      links: [],
    };
    expect(repo.append(authored)).toMatchObject({ accepted: true, publication: authored });
  });

  test('reads are bounded, conversation scoped and ordered by durable cursor, not timestamps', () => {
    repo.append(input);
    repo.append({ ...next(2), conversationId: otherConversation });
    repo.append(next(3));
    repo.append(next(4));
    const firstPage = repo.list(input.conversationId, 0, 2)!;
    expect(firstPage.map((item) => item.publicationId)).toEqual([
      input.publicationId,
      next(3).publicationId,
    ]);
    const secondPage = repo.list(input.conversationId, firstPage[1].sequence, 2)!;
    expect(secondPage.map((item) => item.publicationId)).toEqual([next(4).publicationId]);
    expect(repo.list(input.conversationId, secondPage[0].sequence)).toEqual([]);
    expect(repo.list(otherConversation)).toHaveLength(1);
    expect(repo.append({ ...input, conversationId: otherConversation })).toMatchObject({
      accepted: true,
      created: true,
    });
  });

  test.each([
    [0, 0],
    [0, 101],
    [-1, 1],
    [0.5, 1],
    [0, 1.5],
    [Infinity, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])('invalid pagination (%s, %s) cannot become an unbounded read', (after, limit) => {
    repo.append(input);
    expect(repo.list(input.conversationId, after, limit)).toBeNull();
  });

  test('returned object mutation cannot rewrite stored attribution or links', () => {
    repo.append(input);
    const returned = repo.list(input.conversationId)![0];
    Object.assign(returned.askOrigin, { messageId: 'mutated' });
    Object.assign(returned.links[0], { label: 'mutated' });
    expect(repo.list(input.conversationId)).toMatchObject([input]);
    expect(repo.list('bad-conversation')).toBeNull();
  });
});

describe('migration 288 publication durability', () => {
  test('generic agent SQL cannot bypass future publication operation admission', () => {
    expect(getExcludedTableNames()).toContain('neo_publications');
    for (const scope of ['global', 'room', 'space'] as const)
      expect(getAccessibleTableNames(scope)).not.toContain('neo_publications');
  });

  test('missing Neo subsystem is not created by the migration', () => {
    const db = new Database(':memory:');
    try {
      runMigration288(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'neo_%'").all()).toEqual(
        []
      );
    } finally {
      db.close();
    }
  });

  test('additive migration is repeatable and preserves legacy bindings', () => {
    const db = new Database(':memory:');
    try {
      createNeoTables(db);
      db.prepare(
        "INSERT INTO neo_session_bindings(session_id, concern_id, kind) VALUES ('root', NULL, 'neo')"
      ).run();
      const before = db.prepare('SELECT * FROM neo_session_bindings').all();
      runMigration288(db);
      const repo = new NeoPublicationRepository(db);
      const appended = repo.append(input);
      runMigration288(db);
      expect(db.prepare('SELECT * FROM neo_session_bindings').all()).toEqual(before);
      expect(appended.accepted && repo.list(input.conversationId)).toEqual(
        appended.accepted ? [appended.publication] : false
      );
    } finally {
      db.close();
    }
  });

  test('real migration runner upgrades and preserves publications across database reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-publication-'));
    const path = join(directory, 'daemon.db');
    let daemon: DaemonDatabase | null = null;
    try {
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize(createReactiveDatabase(daemon));
      daemon.getDatabase().exec('DROP TABLE neo_publications');
      daemon
        .getDatabase()
        .prepare('DELETE FROM migration_markers WHERE key = ?')
        .run('migration_288');
      daemon.close();
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize(createReactiveDatabase(daemon));
      expect(
        daemon
          .getDatabase()
          .prepare('SELECT key FROM migration_markers WHERE key = ?')
          .get('migration_288')
      ).toEqual({ key: 'migration_288' });
      const first = new NeoPublicationRepository(daemon.getDatabase()).append(input);
      expect(first.accepted).toBe(true);
      daemon.close();
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize(createReactiveDatabase(daemon));
      const repo = new NeoPublicationRepository(daemon.getDatabase());
      expect(first.accepted && repo.list(input.conversationId)).toEqual(
        first.accepted ? [first.publication] : false
      );
      expect(repo.append(input)).toEqual({ ...first, created: false });
    } finally {
      daemon?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
