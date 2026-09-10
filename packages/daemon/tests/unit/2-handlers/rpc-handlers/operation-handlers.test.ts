import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { setupOperationHandlers } from '../../../../src/lib/rpc-handlers/operation-handlers';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message = { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null };

describe('operation.invoke RPC registration', () => {
  let mailbox: MailboxTestDb;
  let client: MessageHub;
  let server: MessageHub;
  let transports: [InProcessTransport, InProcessTransport];
  let unregister: () => void;
  beforeEach(async () => {
    mailbox = createMailboxTestDb();
    client = new MessageHub();
    server = new MessageHub();
    transports = InProcessTransport.createPair();
    client.registerTransport(transports[0]);
    server.registerTransport(transports[1]);
    unregister = setupOperationHandlers(server, mailbox.jobQueue);
    await Promise.all(transports.map((transport) => transport.initialize()));
  });
  afterEach(async () => {
    unregister();
    client.cleanup();
    server.cleanup();
    await Promise.all(transports.map((transport) => transport.close()));
    mailbox.close();
  });

  test('responds with persisted acceptance over the actual hub protocol', async () => {
    const receipt = await client.request<{ kind: string; mailboxId: string; messageId: string }>(
      'operation.invoke',
      { name: 'message.send', input: { sessionId: 'destination', message } }
    );
    expect(receipt.kind).toBe('accepted');
    expect(mailbox.rows()).toHaveLength(1);
    const entry = JSON.parse(mailbox.rows()[0].payload);
    expect(entry.id).toBe(receipt.mailboxId);
    expect(entry.messageUuid).toBe(receipt.messageId);
    expect(entry.to).toEqual({ kind: 'session', sessionId: 'destination' });
    expect(entry.origin).toBe('chat');
    expect(mailbox.sdkRows()).toEqual([]);
  });

  test('rejects invalid operation input without persisting', async () => {
    await expect(
      client.request('operation.invoke', {
        name: 'message.send',
        input: { sessionId: '', message },
      })
    ).rejects.toThrow();
    expect(mailbox.rows()).toEqual([]);
  });

  test('keeps existing handlers and supports unregistering only the new endpoint', async () => {
    server.onRequest('message.send', () => ({ legacy: true }));
    expect(await client.request('message.send', {})).toEqual({ legacy: true });
    unregister();
    await expect(
      client.request('operation.invoke', {
        name: 'message.send',
        input: { sessionId: 'destination', message },
      })
    ).rejects.toThrow('No handler');
    expect(await client.request('message.send', {})).toEqual({ legacy: true });
    expect(mailbox.rows()).toEqual([]);
  });
});
