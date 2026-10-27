import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { Database } from '../../../../src/storage/database';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createTables } from '../../../../src/storage/schema';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat';

describe('message.sdkMessage reader boundary', () => {
  let main: SQLite;
  let reader: SQLite;
  let gateway: DbGateway;
  let request: (data: unknown) => Promise<unknown>;
  const full = {
    type: 'user',
    uuid: 'full-output',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool', content: '🦊 output\n'.repeat(4000) }],
    },
  };

  beforeEach(() => {
    main = new SQLite(':memory:');
    reader = new SQLite(':memory:');
    createTables(reader);
    for (const id of ['session', 'other'])
      reader
        .prepare(
          `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
           VALUES (?, 'Synthetic message reader', ?, ?, 'active', '{}', '{}')`
        )
        .run(id, new Date().toISOString(), new Date().toISOString());
    reader
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_uuid, sdk_message, timestamp)
         VALUES ('body', 'session', 'user', ?, ?, ?)`
      )
      .run(full.uuid, JSON.stringify(full), new Date().toISOString());
    gateway = new DbGateway(':memory:', reader);
    bindGateway(main, gateway);
    main.prepare = () => {
      throw new Error('single-message SQL reached main');
    };
    const db = {
      getDbPath: () => ':memory:',
      getDatabase: () => main,
      getSession: (id: string) => new SessionRepository(main).getSession(id),
    } as unknown as Database;
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const hub = {
      onRequest: (method: string, handler: (data: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as unknown as MessageHub;
    setupMessageHandlers(hub, {} as SessionManager, db);
    request = handlers.get('message.sdkMessage')!;
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    reader.close();
  });

  test('returns complete output with the main connection unavailable', async () => {
    expect(await request({ sessionId: 'session', messageUuid: full.uuid })).toEqual({
      sdkMessage: full,
    });
  });

  test('caps only the requested reply while preserving the stored full body', async () => {
    const result = (await request({
      sessionId: 'session',
      messageUuid: full.uuid,
      capped: true,
    })) as { sdkMessage: typeof full & { output_capped: boolean } };

    expect(result.sdkMessage.output_capped).toBe(true);
    expect(result.sdkMessage.message.content[0].content).toBe(
      full.message.content[0].content.slice(0, 16 * 1024)
    );
    expect(await request({ sessionId: 'session', messageUuid: full.uuid })).toEqual({
      sdkMessage: full,
    });
  });

  test('preserves missing-session and missing-message errors without a main fallback', async () => {
    await expect(request({ sessionId: 'missing', messageUuid: full.uuid })).rejects.toThrow(
      'Session not found'
    );
    await expect(request({ sessionId: 'session', messageUuid: 'missing' })).rejects.toThrow(
      'Message not found'
    );
    await expect(request({ sessionId: 'other', messageUuid: full.uuid })).rejects.toThrow(
      'Message not found'
    );
  });

  test('validates required parameters before reading', async () => {
    await expect(request({ sessionId: 'session' })).rejects.toThrow(
      'sessionId and messageUuid are required'
    );
    await expect(request({ messageUuid: full.uuid })).rejects.toThrow(
      'sessionId and messageUuid are required'
    );
  });

  test('propagates a reader SQL failure without retrying main', async () => {
    reader.exec('DROP TABLE sdk_messages');
    await expect(request({ sessionId: 'session', messageUuid: full.uuid })).rejects.toThrow(
      'sdk_messages'
    );
  });
});
