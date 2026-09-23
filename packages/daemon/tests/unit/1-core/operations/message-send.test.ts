import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { z } from 'zod';
import {
  createSendMessageOperation,
  SendMessageInputSchema,
  selectMessageOrigin,
  mapMessageReceipt,
} from '../../../../src/lib/messaging/message-send';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { parseMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message = { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null };

describe('shared message.send operation', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  test.each(['rpc', 'mcp', 'internal'] as const)(
    'accepts persisted work from %s before SDK delivery',
    async (source) => {
      const registry = createOperationRegistry([
        createSendMessageOperation(mailbox.jobQueue, () => true),
      ]);
      const outcome = await invokeOperation(
        registry,
        'message.send',
        {
          sessionId: 'destination',
          message,
        },
        { source, sessionId: 'sender' }
      );
      const entry = parseMailboxEntry(JSON.parse(mailbox.rows()[0].payload));
      expect(outcome).toEqual({
        kind: 'completed',
        value: {
          kind: 'accepted',
          mailboxId: entry?.id,
          messageId: entry?.messageUuid,
        },
      });
      expect(entry?.messageUuid).toBeString();
      expect(entry?.to).toEqual({ kind: 'session', sessionId: 'destination' });
      expect(entry?.origin).toBe('session:sender');
      expect(entry?.message).toEqual(message);
      expect(mailbox.sdkRows()).toEqual([]);
    }
  );

  test('preserves deferred delivery, images, and reference metadata', async () => {
    const registry = createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, () => true),
    ]);
    const prepared = {
      ...message,
      priority: 'next',
      inputKind: 'human',
      message: {
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
      referenceMetadata: { token: { type: 'file', id: 'src/a.ts', displayText: 'a.ts' } },
    };
    await invokeOperation(
      registry,
      'message.send',
      {
        sessionId: 'destination',
        message: prepared,
        deliveryMode: 'defer',
      },
      { source: 'rpc' }
    );
    const entry = parseMailboxEntry(JSON.parse(mailbox.rows()[0].payload));
    expect(entry?.message).toEqual(prepared);
    expect(entry?.deliveryMode).toBe('defer');
    expect(entry?.origin).toBe('chat');
  });

  test.each([
    { sessionId: '', message },
    { sessionId: '\ud800', message },
    { sessionId: 'destination', message: { ...message, message: { content: '' } } },
    { sessionId: 'destination', message: { ...message, type: 'assistant' } },
    { sessionId: 'destination', message, deliveryMode: 'unknown' },
  ])('rejects invalid input without persistence: %j', async (input) => {
    const registry = createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, () => true),
    ]);
    expect(await invokeOperation(registry, 'message.send', input, { source: 'mcp' })).toMatchObject(
      {
        kind: 'failed',
        code: 'invalid_input',
      }
    );
    expect(mailbox.rows()).toEqual([]);
  });

  test('does not report acceptance when persistence fails', async () => {
    const registry = createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, () => true),
    ]);
    mailbox.db.exec('DROP TABLE job_queue');
    expect(
      await invokeOperation(
        registry,
        'message.send',
        {
          sessionId: 'destination',
          message,
        },
        { source: 'mcp' }
      )
    ).toMatchObject({ kind: 'completed', value: { kind: 'rejected' } });
  });
  test('describes the message envelope and content blocks structurally', () => {
    const schema = z.toJSONSchema(SendMessageInputSchema, { io: 'input' });
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('parent_tool_use_id');
    expect(serialized).toContain('media_type');
    expect(serialized).toContain('referenceMetadata');
    expect(schema.properties?.message).toMatchObject({ type: 'object' });
  });

  test('origin and receipt stages preserve provenance and rejection details', () => {
    expect(selectMessageOrigin({ source: 'mcp', sessionId: 'sender/one' })).toBe(
      'session:sender%2Fone'
    );
    expect(selectMessageOrigin({ source: 'internal' })).toBe('system');
    expect(mapMessageReceipt({ kind: 'enqueued', id: 'mailbox-1' }, 'message-1')).toEqual({
      kind: 'accepted',
      mailboxId: 'mailbox-1',
      messageId: 'message-1',
    });
    expect(mapMessageReceipt({ kind: 'rejected', reason: 'unavailable' }, 'message-1')).toEqual({
      kind: 'rejected',
      reason: 'unavailable',
    });
  });

  test('rejects a send to a session id that does not exist', async () => {
    const registry = createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, (sessionId) => sessionId === 'destination'),
    ]);
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { sessionId: 'session-ghost', message },
      { source: 'mcp', sessionId: 'agent-session' }
    );
    expect(outcome).toEqual({
      kind: 'completed',
      value: { kind: 'rejected', reason: 'Unknown session: session-ghost' },
    });
    expect(mailbox.rowCount()).toBe(0);
  });

  test('accepts a send addressed outside the caller Space', async () => {
    const registry = createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, (sessionId) => sessionId === 'space-b-session'),
    ]);
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { sessionId: 'space-b-session', message },
      { source: 'mcp', sessionId: 'space-a-session', spaceId: 'space-a', role: 'ad_hoc_member' }
    );
    expect(outcome.kind === 'completed' && outcome.value).toMatchObject({ kind: 'accepted' });
    expect(mailbox.rowCount()).toBe(1);
  });
});
