import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { readSDKMessagePage } from '../../../../src/storage/sdk-status-reader';
import { createTables } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns';

const timestamp = '2026-10-26T00:00:00.000Z';

describe('SDKMessageRepository shutdown timestamp ties', () => {
  let db: Database;
  let repository: SDKMessageRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
       VALUES ('session', 'Synthetic history', ?, ?, 'active', '{}', '{}')`
    ).run(timestamp, timestamp);
    repository = new SDKMessageRepository(db);
  });

  afterEach(() => db.close());

  function seed(
    id: string,
    type: string,
    options: { at?: string; status?: string; parent?: string } = {}
  ) {
    const message = {
      type,
      uuid: id,
      session_id: 'session',
      parent_tool_use_id: options.parent ?? null,
      ...(type === 'system'
        ? { subtype: 'worker_shutting_down', reason: 'host_exit' }
        : { message: { role: type, content: [{ type: 'text', text: id }] } }),
    };
    db.prepare(
      `INSERT INTO sdk_messages
       (id, session_id, message_type, message_subtype, sdk_message, timestamp,
        send_status, parent_tool_use_id, sdk_uuid, replacement_metadata_normalized)
       VALUES (?, 'session', ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      type,
      type === 'system' ? 'worker_shutting_down' : null,
      JSON.stringify(message),
      options.at ?? timestamp,
      options.status ?? 'consumed',
      options.parent ?? null,
      id
    );
    fillSdkMessageFixtureColumns(db);
  }

  for (const projected of [false, true]) {
    const mode = projected ? 'projected reader' : 'full repository';
    const read = (repo: SDKMessageRepository, limit = 10) =>
      projected
        ? readSDKMessagePage(repo, { sessionId: 'session', page: { limit } }).sdkMessages
        : repo.getSDKMessages('session', limit).messages;

    test(`${mode} removes a stale shutdown before applying the limit using insertion order`, () => {
      seed('older', 'assistant', { at: '2026-10-25T23:59:59.000Z' });
      seed('z-shutdown', 'system');
      seed('a-newer', 'assistant');

      expect(read(repository, 2).map((message) => message.uuid)).toEqual(['older', 'a-newer']);
    });

    test(`${mode} retains the actual shutdown tail despite an earlier larger ID`, () => {
      seed('z-older', 'assistant');
      seed('a-shutdown', 'system');

      expect(read(repository).map((message) => message.uuid)).toEqual(['z-older', 'a-shutdown']);
    });

    test(`${mode} keeps only the last of two shutdown markers sharing a timestamp`, () => {
      seed('z-shutdown', 'system');
      seed('a-shutdown', 'system');

      expect(read(repository).map((message) => message.uuid)).toEqual(['a-shutdown']);
    });

    for (const status of ['deferred', 'enqueued', 'submitted', 'consumed', 'failed']) {
      test(`${mode} respects a tied user message in ${status} state`, () => {
        seed('z-shutdown', 'system');
        seed('a-user', 'user', { status });

        expect(read(repository).map((message) => message.uuid)).toEqual(
          status === 'consumed' || status === 'failed' ? ['a-user'] : ['z-shutdown']
        );
      });
    }

    test(`${mode} ignores later nested messages when choosing the top-level tail`, () => {
      seed('a-shutdown', 'system');
      seed('z-child', 'assistant', { parent: 'nested-tool' });

      expect(read(repository).map((message) => message.uuid)).toEqual(['a-shutdown']);
    });
  }

  test('before and since rowid cursors agree with shutdown visibility across tied timestamps', () => {
    seed('older', 'assistant', { at: '2026-10-25T23:59:59.000Z' });
    seed('z-shutdown', 'system');
    seed('a-newer', 'assistant');
    const row = db
      .prepare('SELECT rowid AS rowid FROM sdk_messages WHERE id = ?')
      .get('a-newer') as {
      rowid: number;
    };
    const before = readSDKMessagePage(repository, {
      sessionId: 'session',
      page: { limit: 2, before: Date.parse(timestamp), beforeRowid: row.rowid },
    });
    const since = readSDKMessagePage(repository, {
      sessionId: 'session',
      page: { limit: 2, since: Date.parse(timestamp), sinceRowid: row.rowid - 1 },
    });

    expect(before.sdkMessages.map((message) => message.uuid)).toEqual(['older']);
    expect(before.hasMore).toBe(false);
    expect(since.sdkMessages.map((message) => message.uuid)).toEqual(['a-newer']);
  });
});
