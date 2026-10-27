import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { Database } from '../../../../src/storage/database';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { createTables } from '../../../../src/storage/schema';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat';

describe('message.count reader boundary', () => {
  let main: SQLite;
  let reader: SQLite;
  let gateway: DbGateway;
  let db: Database;
  let restore: ReturnType<typeof mock>;
  let ready: ReturnType<typeof mock>;

  function request(explicitDb = true) {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const hub = {
      onRequest: (name: string, handler: (data: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    } as unknown as MessageHub;
    const manager = { getSessionForControl: restore, getDatabase: () => db };
    setupMessageHandlers(hub, manager as unknown as SessionManager, explicitDb ? db : undefined);
    return (sessionId: string) => handlers.get('message.count')!({ sessionId });
  }

  beforeEach(() => {
    main = new SQLite(':memory:');
    reader = new SQLite(':memory:');
    createTables(reader);
    reader
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
         VALUES ('session', 'Count fixture', ?, ?, 'active', '{}', '{}')`
      )
      .run(new Date().toISOString(), new Date().toISOString());
    const insert = reader.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, parent_tool_use_id,
        send_status, sdk_message, timestamp) VALUES (?, 'session', ?, ?, ?, ?, '{}', ?)`
    );
    for (const [id, type, subtype, parent, status] of [
      ['consumed', 'user', null, null, 'consumed'],
      ['pending', 'user', null, null, 'enqueued'],
      ['assistant', 'assistant', null, null, null],
      ['child', 'assistant', null, 'tool', null],
      ['hidden', 'system', 'thinking_tokens', null, null],
      ['result', 'result', 'success', null, null],
    ])
      insert.run(id, type, subtype, parent, status, new Date().toISOString());
    gateway = new DbGateway(':memory:', reader);
    bindGateway(main, gateway);
    main.prepare = () => {
      throw new Error('message-count SQL reached main');
    };
    ready = mock(async () => {});
    restore = mock(async () => {
      throw new Error('message count must not restore an actor');
    });
    db = {
      getDbPath: () => ':memory:',
      getDatabase: () => main,
      waitForSdkMessageColumns: ready,
    } as unknown as Database;
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    reader.close();
  });

  test('counts the same visible top-level messages without main SQL or an actor', async () => {
    expect(await request()('session')).toEqual({ count: 3 });
    expect(restore).not.toHaveBeenCalled();
  });

  test('supports the implicit store for persisted sessions', async () => {
    expect(await request(false)('session')).toEqual({ count: 3 });
    expect(restore).not.toHaveBeenCalled();
  });

  test('preserves missing-session errors and explicit conversation fallback', async () => {
    await expect(request()('missing')).rejects.toThrow('Session not found');
    expect(await request()('conv:missing')).toEqual({ count: 0 });
    await expect(request(false)('conv:missing')).rejects.toThrow('Session not found');
    expect(restore).not.toHaveBeenCalled();
  });

  test('a fresh count observes a later committed message', async () => {
    expect(await request()('session')).toEqual({ count: 3 });
    reader.exec(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
       VALUES ('later', 'session', 'assistant', '{}', '2026-01-01')`
    );
    expect(await request()('session')).toEqual({ count: 4 });
  });

  test('reader errors reject without an actor or main fallback', async () => {
    reader.exec('DROP TABLE sdk_messages');
    await expect(request()('session')).rejects.toThrow('sdk_messages');
    expect(restore).not.toHaveBeenCalled();
  });

  test('retains the nonwaiting message-column preparation gate', async () => {
    ready.mockRejectedValueOnce(new Error('Message history is being prepared'));
    await expect(request()('session')).rejects.toThrow('Message history is being prepared');
    expect(ready).toHaveBeenCalledWith('session', false);
    expect(restore).not.toHaveBeenCalled();
  });
});
