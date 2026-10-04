import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send';
import {
  classifyMessageDelivery,
  createMessageStatusOperation,
  type MessageStatusReaders,
} from '../../../../src/lib/messaging/message-status';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message = { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null };

describe('classifyMessageDelivery', () => {
  test.each([
    ['enqueued', 'queued'],
    ['deferred', 'deferred'],
    ['submitted', 'processing'],
    ['consumed', 'delivered'],
    ['failed', 'failed'],
  ] as const)('maps a %s transcript row to %s', (sendStatus, expected) => {
    expect(classifyMessageDelivery({ sendStatus, admission: null })).toBe(expected);
  });

  test('reports a message still waiting in the mailbox as queued', () => {
    expect(
      classifyMessageDelivery({ sendStatus: null, admission: { status: 'pending', error: null } })
    ).toBe('queued');
  });

  test('reports a dead-lettered mailbox entry as failed', () => {
    expect(
      classifyMessageDelivery({
        sendStatus: null,
        admission: { status: 'dead', error: 'mailbox: target session archived' },
      })
    ).toBe('failed');
  });

  test('reports a message with no trace as unknown', () => {
    expect(classifyMessageDelivery({ sendStatus: null, admission: null })).toBe('unknown');
  });
});

describe('message.status operation', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  function registry(readSendStatus: MessageStatusReaders['readSendStatus'] = () => null) {
    return createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, () => true),
      createMessageStatusOperation({
        readSendStatus,
        readMailboxAdmission: (sessionId, messageId) =>
          mailbox.jobQueue.getLatestByPayload(MAILBOX_LANE, {
            'to.sessionId': sessionId,
            messageUuid: messageId,
          }),
        readDeliveryError: () => null,
      }),
    ]);
  }

  async function send(ops: ReturnType<typeof registry>) {
    const outcome = await invokeOperation(
      ops,
      'message.send',
      { sessionId: 'destination', message },
      { source: 'mcp', sessionId: 'neo:root' }
    );
    if (outcome.kind !== 'completed' || outcome.value.kind !== 'accepted')
      throw new Error('send was not accepted');
    return outcome.value;
  }

  test('follows an accepted send from the mailbox to a failure with its reason', async () => {
    const ops = registry();
    const receipt = await send(ops);
    const read = () =>
      invokeOperation(
        ops,
        'message.status',
        { sessionId: 'destination', messageId: receipt.messageId },
        { source: 'mcp', sessionId: 'neo:root' }
      );

    expect(await read()).toEqual({ kind: 'completed', value: { status: 'queued' } });

    const job = mailbox.jobQueue.getLatestByPayload(MAILBOX_LANE, {
      messageUuid: receipt.messageId,
    });
    mailbox.jobQueue.markDead(job!.id, 'mailbox: target session archived');

    expect(await read()).toEqual({
      kind: 'completed',
      value: { status: 'failed', reason: 'mailbox: target session archived' },
    });
  });

  test('says a remote-daemon receipt belongs to that daemon instead of guessing', async () => {
    expect(
      await invokeOperation(
        registry(() => 'consumed'),
        'message.status',
        { sessionId: 'daemon:b::session:session-on-b', messageId: 'remote-message' },
        { source: 'mcp', sessionId: 'neo:root' }
      )
    ).toMatchObject({
      kind: 'completed',
      value: { status: 'unknown', reason: expect.stringContaining('another daemon') },
    });
  });

  test('reports delivered once the target consumed the message', async () => {
    const ops = registry(() => 'consumed');
    const receipt = await send(ops);
    expect(
      await invokeOperation(
        ops,
        'message.status',
        { sessionId: 'destination', messageId: receipt.messageId },
        { source: 'rpc' }
      )
    ).toEqual({ kind: 'completed', value: { status: 'delivered' } });
  });
});
