import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createSendMessageOperation } from '../../../../src/lib/operations/message-send';
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

  test.each([
    'rpc',
    'mcp',
    'internal',
  ] as const)('accepts persisted work from %s before SDK delivery', async (source) => {
    const registry = createOperationRegistry([createSendMessageOperation(mailbox.jobQueue)]);
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
  });

  test('preserves deferred delivery, images, and reference metadata', async () => {
    const registry = createOperationRegistry([createSendMessageOperation(mailbox.jobQueue)]);
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
      referenceMetadata: { token: { type: 'task', id: 'task-1', displayText: 'Task one' } },
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
    { sessionId: 'destination', message: { ...message, message: { content: '' } } },
    { sessionId: 'destination', message: { ...message, type: 'assistant' } },
    { sessionId: 'destination', message, deliveryMode: 'unknown' },
  ])('rejects invalid input without persistence: %j', async (input) => {
    const registry = createOperationRegistry([createSendMessageOperation(mailbox.jobQueue)]);
    expect(await invokeOperation(registry, 'message.send', input, { source: 'mcp' })).toMatchObject(
      {
        kind: 'failed',
        code: 'invalid_input',
      }
    );
    expect(mailbox.rows()).toEqual([]);
  });

  test('does not report acceptance when persistence fails', async () => {
    const registry = createOperationRegistry([createSendMessageOperation(mailbox.jobQueue)]);
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
});
