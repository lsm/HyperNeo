import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { Database } from '../../../../src/storage/database';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createTables } from '../../../../src/storage/schema';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat';

describe('session.export reader boundary', () => {
  let main: SQLite;
  let reader: SQLite;
  let gateway: DbGateway;
  let db: Database;
  let restore: ReturnType<typeof mock>;
  let ready: ReturnType<typeof mock>;
  let cached: Session | null;
  const text = 'Full export text 🦊\n'.repeat(2000);

  function request(explicitDb = true) {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const hub = {
      onRequest: (name: string, handler: (data: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    } as unknown as MessageHub;
    const manager = {
      getSessionForControl: restore,
      getDatabase: () => db,
      getCachedSession: () =>
        cached ? ({ getSessionData: () => cached } as unknown as AgentSession) : null,
    };
    setupMessageHandlers(hub, manager as unknown as SessionManager, explicitDb ? db : undefined);
    return (data: Record<string, unknown> = {}) =>
      handlers.get('session.export')!({ sessionId: 'session', ...data });
  }

  beforeEach(() => {
    main = new SQLite(':memory:');
    reader = new SQLite(':memory:');
    createTables(reader);
    for (const id of ['session', 'empty'])
      reader
        .prepare(
          `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
           VALUES (?, 'Export fixture', ?, ?, 'active', '{"model":"test-model"}', '{}')`
        )
        .run(id, new Date().toISOString(), new Date().toISOString());
    reader
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_uuid, sdk_message, timestamp)
         VALUES ('reply', 'session', 'assistant', 'export-reply', ?, ?)`
      )
      .run(
        JSON.stringify({
          type: 'assistant',
          uuid: 'export-reply',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }),
        new Date().toISOString()
      );
    gateway = new DbGateway(':memory:', reader);
    bindGateway(main, gateway);
    main.prepare = () => {
      throw new Error('export SQL reached main');
    };
    restore = mock(async () => {
      throw new Error('export must not restore an actor');
    });
    ready = mock(async () => {});
    cached = null;
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

  test('exports complete JSON without main SQL or actor restoration', async () => {
    expect(await request()({ format: 'json' })).toEqual({
      session: new SessionRepository(reader).getSession('session'),
      messages: new SDKMessageRepository(reader).getSDKMessages('session', 10000).messages,
    });
    expect(restore).not.toHaveBeenCalled();
  });

  test('default and explicit Markdown retain full text and formatting', async () => {
    const session = new SessionRepository(reader).getSession('session')!;
    const expected = [
      '# Export fixture',
      '',
      '**Session ID:** session',
      '**Model:** test-model',
      `**Created:** ${session.createdAt}`,
      '',
      '---',
      '',
      `## Assistant\n\n${text}\n`,
      '',
    ].join('\n');
    expect(await request()()).toEqual({ markdown: expected });
    expect(await request()({ format: 'markdown' })).toEqual({ markdown: expected });
  });

  test('retains cached session metadata without making the actor read SQL', async () => {
    cached = { ...new SessionRepository(reader).getSession('session')!, title: 'Runtime title' };
    const result = (await request()({ format: 'json' })) as { session: Session };
    expect(result.session).toEqual(cached);
    expect(restore).not.toHaveBeenCalled();
  });

  test('uses the implicit store and preserves empty exports', async () => {
    const result = (await request(false)({ sessionId: 'empty', format: 'json' })) as {
      messages: unknown[];
      session: Session;
    };
    expect(result.messages).toEqual([]);
    expect(result.session.id).toBe('empty');
  });

  test('missing ordinary and conversation sessions retain their error', async () => {
    for (const sessionId of ['missing', 'conv:missing'])
      await expect(request()({ sessionId })).rejects.toThrow('Session not found');
  });

  test('reader errors reject without restoring an actor', async () => {
    reader.exec('DROP TABLE sdk_messages');
    await expect(request()({ format: 'json' })).rejects.toThrow('sdk_messages');
    expect(restore).not.toHaveBeenCalled();
  });

  test('retains the nonwaiting message preparation gate', async () => {
    ready.mockRejectedValueOnce(new Error('Message history is being prepared'));
    await expect(request()()).rejects.toThrow('Message history is being prepared');
    expect(ready).toHaveBeenCalledWith('session', false);
  });

  test('keeps the existing 10000-message selection limit', async () => {
    const insert = reader.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_uuid, sdk_message, timestamp)
       VALUES (?, 'session', 'assistant', ?, ?, '2026-10-27T00:00:00Z')`
    );
    reader.transaction(() => {
      for (let i = 0; i < 10001; i++)
        insert.run(
          `limit-${i}`,
          `limit-${i}`,
          JSON.stringify({ type: 'assistant', uuid: `limit-${i}`, message: { content: [] } })
        );
    })();
    const result = (await request()({ format: 'json' })) as { messages: { uuid: string }[] };
    const reference = new SDKMessageRepository(reader).getSDKMessages('session', 10000).messages;
    expect(result.messages).toEqual(reference);
    expect(result.messages).toHaveLength(10000);
  });
});
