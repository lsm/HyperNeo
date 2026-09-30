import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { admitNeoConversationAsk } from '../../../../src/lib/neo/conversation-ask.ts';
import { toMailboxMessage } from '../../../../src/lib/mailbox/entry.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { Database as DaemonDatabase } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../../../../src/lib/db-query/scope-config.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
function input(index = 1) {
  const requestId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    conversationId,
    requestId,
    askOrigin: { sessionId: `neo:${conversationId}`, messageId: requestId },
    content: '  Compare these fictional sources.\nDo not publish.  ',
  };
}
const photo = {
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: 'image/png' as const,
    data: 'ZmljdGlvbmFsLXBob3Rv',
  },
};

describe('durable public ask storage', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoConversationAskRepository;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration289(mailbox.db);
    repo = new NeoConversationAskRepository(mailbox.db);
  });
  afterEach(() => mailbox.close());

  test('preserves stable identity, authored whitespace and canonical SDK text-block content synchronously', () => {
    const value = input();
    const parsed = admitNeoConversationAsk(value);
    expect(parsed).toEqual({
      value: { ...value, content: [{ type: 'text', text: value.content }] },
    });
    const first = repo.append(value);
    expect(first).not.toBeInstanceOf(Promise);
    expect(first).toMatchObject({
      accepted: true,
      created: true,
      ask: { ...value, content: [{ type: 'text', text: value.content }] },
    });
    if (!first.accepted) throw new Error('fixture rejected');
    expect(first.ask.sequence).toBe(1);
    expect(new Date(first.ask.createdAt).toISOString()).toBe(first.ask.createdAt);
    expect(repo.list(conversationId)).toEqual([first.ask]);
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });

  test('identical replay and equivalent text-block representation retain original time and sequence', () => {
    const value = input();
    const first = repo.append(value);
    expect(
      repo.append({
        content: [{ type: 'text', text: value.content }],
        askOrigin: { messageId: value.requestId, sessionId: value.askOrigin.sessionId },
        requestId: value.requestId,
        conversationId,
      })
    ).toEqual({ ...first, created: false });
    expect(repo.list(conversationId)).toHaveLength(1);
  });

  test('preserves whitespace content already admitted by the canonical mailbox boundary', () => {
    const message = { type: 'user' as const, parent_tool_use_id: null, message: { content: ' ' } };
    expect(toMailboxMessage(message)).not.toHaveProperty('reason');
    expect(repo.append({ ...input(), content: ' ' })).toMatchObject({
      accepted: true,
      ask: { content: [{ type: 'text', text: ' ' }] },
    });
  });

  test.each([
    { content: 'Changed request' },
    { content: [{ type: 'text', text: input().content }, photo] },
    { askOrigin: { ...input().askOrigin, sessionId: 'another-source' } },
  ])('conflicting retry never rewrites content or original attribution %o', (patch) => {
    const first = repo.append(input());
    expect(repo.append({ ...input(), ...patch })).toEqual({
      accepted: false,
      reason: 'ask_conflict',
    });
    expect(first.accepted && repo.list(conversationId)).toEqual(
      first.accepted ? [first.ask] : false
    );
  });

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const)(
    'preserves photo-only content for %s',
    (media_type) => {
      const value = {
        ...input(),
        content: [{ ...photo, source: { ...photo.source, media_type } }],
      };
      expect(repo.append(value)).toMatchObject({ accepted: true, ask: value });
      expect(repo.list(conversationId)?.[0].content).toEqual(value.content);
    }
  );

  test('photo order, payload and text coexist without loss and changed photo retries conflict', () => {
    const content = [{ type: 'text', text: 'Keep this draft' }, photo];
    const first = repo.append({ ...input(), content });
    expect(first).toMatchObject({ accepted: true, ask: { content } });
    expect(repo.append({ ...input(), content: [photo, content[0]] })).toEqual({
      accepted: false,
      reason: 'ask_conflict',
    });
    expect(
      repo.append({
        ...input(),
        content: [{ ...photo, source: { ...photo.source, data: 'changed' } }],
      })
    ).toEqual({ accepted: false, reason: 'ask_conflict' });
    expect(first.accepted && repo.list(conversationId)).toEqual(
      first.accepted ? [first.ask] : false
    );
  });

  test.each([
    null,
    {},
    { ...input(), conversationId: 'not-uuid' },
    { ...input(), requestId: 'not-uuid' },
    { ...input(), askOrigin: { ...input().askOrigin, messageId: input(2).requestId } },
    { ...input(), askOrigin: { ...input().askOrigin, sessionId: '' } },
    { ...input(), askOrigin: { ...input().askOrigin, sessionId: ' ' } },
    { ...input(), askOrigin: { ...input().askOrigin, sessionId: 'x'.repeat(161) } },
    { ...input(), content: '' },
    { ...input(), content: [{ type: 'text', text: '' }] },
    { ...input(), content: [] },
    { ...input(), content: [{ type: 'tool_result', content: 'system' }] },
    { ...input(), content: [{ type: 'image', source: { ...photo.source, type: 'url' } }] },
    {
      ...input(),
      content: [{ ...photo, source: { ...photo.source, media_type: 'application/pdf' } }],
    },
    { ...input(), content: [{ ...photo, source: { ...photo.source, data: '' } }] },
    { ...input(), actor: 'human' },
    { ...input(), createdAt: '2020-01-01' },
    { ...input(), sequence: 99 },
    { ...input(), askOrigin: { ...input().askOrigin, authority: 'human' } },
  ])('invalid or injected input is rejected before persistence %o', (value) => {
    expect(admitNeoConversationAsk(value)).toEqual({ reason: 'invalid_ask' });
    expect(repo.append(value)).toEqual({ accepted: false, reason: 'invalid_ask' });
    expect(repo.list(conversationId)).toEqual([]);
  });

  test('immutable asks survive returned-object mutation and SDK transcript removal', () => {
    repo.append({ ...input(), content: [photo] });
    const original = repo.list(conversationId);
    const returned = repo.list(conversationId)![0];
    Object.assign(returned.askOrigin, { sessionId: 'mutated' });
    Object.assign(returned.content[0], { type: 'text', text: 'mutated' });
    expect(
      mailbox.sdkMessageRepo.saveSDKMessage(input().askOrigin.sessionId, {
        type: 'user',
        uuid: input().requestId,
        session_id: input().askOrigin.sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Raw internal transcript' },
      } as SDKUserMessage)
    ).toBe(true);
    expect(mailbox.sdkRows()).toHaveLength(1);
    mailbox.db.exec('DELETE FROM sdk_messages');
    expect(repo.list(conversationId)).toEqual(original);
    expect(mailbox.rows()).toEqual([]);
  });

  test('reads are bounded and isolated by conversation and durable cursor', () => {
    repo.append(input());
    repo.append({ ...input(2), conversationId: foreignId });
    repo.append(input(3));
    const first = repo.list(conversationId, 0, 1)!;
    expect(first.map((value) => value.requestId)).toEqual([input().requestId]);
    const second = repo.list(conversationId, first[0].sequence, 1)!;
    expect(second.map((value) => value.requestId)).toEqual([input(3).requestId]);
    expect(repo.list(conversationId, second[0].sequence)).toEqual([]);
    expect(repo.list(foreignId)?.map((value) => value.requestId)).toEqual([input(2).requestId]);
    expect(repo.list('not-uuid')).toBeNull();
  });

  test.each([
    [-1, 1],
    [0.5, 1],
    [0, 0],
    [0, 101],
    [0, 1.5],
    [Infinity, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])('invalid cursor/bounds %s/%s cannot become unbounded', (after, limit) => {
    repo.append(input());
    expect(repo.list(conversationId, after, limit)).toBeNull();
  });

  test('maximum page size and terminal safe cursor are supported', () => {
    for (let i = 1; i <= 101; i++) expect(repo.append(input(i)).accepted).toBe(true);
    expect(repo.list(conversationId, 0, 100)).toHaveLength(100);
    expect(repo.list(conversationId, Number.MAX_SAFE_INTEGER, 100)).toEqual([]);
  });

  test('participates in an owning outer transaction without leaving partial reservations', () => {
    expect(() =>
      mailbox.db.transaction(() => {
        expect(repo.append(input()).accepted).toBe(true);
        throw new Error('rollback fixture');
      })()
    ).toThrow('rollback fixture');
    expect(repo.list(conversationId)).toEqual([]);
    expect(repo.append(input())).toMatchObject({ accepted: true, created: true });
  });

  test('corrupt stored data surfaces an infrastructure failure rather than false empty history', () => {
    repo.append(input());
    mailbox.db.prepare('UPDATE neo_conversation_asks SET payload_json = ?').run('{}');
    expect(() => repo.list(conversationId)).toThrow('Invalid stored Neo conversation ask');
  });
});

describe('migration 289 accepted ask durability', () => {
  test('generic agent SQL cannot bypass future intake admission', () => {
    expect(getExcludedTableNames()).toContain('neo_conversation_asks');
    for (const scope of ['global', 'room', 'space'] as const)
      expect(getAccessibleTableNames(scope)).not.toContain('neo_conversation_asks');
  });

  test('migration does not create a missing Neo subsystem and is additive/repeatable when present', () => {
    const db = new Database(':memory:');
    try {
      runMigration289(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'neo_%'").all()).toEqual(
        []
      );
      createNeoTables(db);
      db.prepare(
        "INSERT INTO neo_session_bindings(session_id, concern_id, kind) VALUES ('root', NULL, 'neo')"
      ).run();
      const before = db.prepare('SELECT * FROM neo_session_bindings').all();
      runMigration289(db);
      const repo = new NeoConversationAskRepository(db);
      const first = repo.append(input());
      runMigration289(db);
      expect(db.prepare('SELECT * FROM neo_session_bindings').all()).toEqual(before);
      expect(first.accepted && repo.list(conversationId)).toEqual(
        first.accepted ? [first.ask] : false
      );
    } finally {
      db.close();
    }
  });

  test('actual daemon migration runner upgrades existing storage and survives reopen with immutable replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-public-asks-'));
    const path = join(dir, 'fictional.db');
    let daemon: DaemonDatabase | null = null;
    try {
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize(createReactiveDatabase(daemon));
      daemon.getDatabase().exec('DROP TABLE neo_conversation_asks');
      daemon
        .getDatabase()
        .prepare('DELETE FROM migration_markers WHERE key = ?')
        .run('migration_289');
      daemon.close();
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize(createReactiveDatabase(daemon));
      expect(
        daemon
          .getDatabase()
          .prepare('SELECT key FROM migration_markers WHERE key = ?')
          .get('migration_289')
      ).toEqual({ key: 'migration_289' });
      const first = new NeoConversationAskRepository(daemon.getDatabase()).append({
        ...input(),
        content: [photo],
      });
      expect(first.accepted).toBe(true);
      daemon.close();
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize(createReactiveDatabase(daemon));
      const repo = new NeoConversationAskRepository(daemon.getDatabase());
      expect(first.accepted && repo.list(conversationId)).toEqual(
        first.accepted ? [first.ask] : false
      );
      expect(repo.append({ ...input(), content: [photo] })).toEqual({ ...first, created: false });
    } finally {
      daemon?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
