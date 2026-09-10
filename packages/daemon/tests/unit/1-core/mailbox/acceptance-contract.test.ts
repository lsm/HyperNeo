import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { parseMailboxEntry, type MailboxMessage } from '../../../../src/lib/mailbox/entry';
import { handoffPromptToMailbox } from '../../../../src/lib/mailbox/handoff';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'A message for another session' },
  parent_tool_use_id: null,
};

describe('durable message acceptance boundary', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  test('acknowledges persisted work before destination lookup or SDK materialization', async () => {
    const getSession = mock(async () => null);
    const deliver = createMailboxDeliveryHandler({
      ...mailbox,
      getSession,
      isSessionArchived: () => false,
    });
    const receipt = await handoffPromptToMailbox({
      to: 'session:destination',
      message,
      origin: 'test',
      messageUuid: 'message-1',
      jobQueue: mailbox.jobQueue,
    });
    expect(receipt.kind).toBe('enqueued');
    if (receipt.kind !== 'enqueued') throw new Error(receipt.reason);
    const rows = mailbox.jobsByQueue(MAILBOX_LANE);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    const entry = parseMailboxEntry(JSON.parse(rows[0].payload));
    expect(entry?.id).toBe(receipt.id);
    expect(entry?.messageUuid).toBe('message-1');
    expect(entry?.to).toEqual({ kind: 'session', sessionId: 'destination' });
    expect(entry?.message).toEqual(message);
    expect(getSession).not.toHaveBeenCalled();
    expect(mailbox.sdkRows()).toEqual([]);
    const [job] = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
    await expect(deliver(job)).rejects.toThrow('session destination not found');
    expect(getSession).toHaveBeenCalledWith('destination');
    expect(receipt).toEqual({ kind: 'enqueued', id: entry?.id });
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.jobsByQueue(MAILBOX_LANE)).toHaveLength(1);
  });

  test('an archived destination fails delivery after acceptance without creating SDK input', async () => {
    const receipt = await handoffPromptToMailbox({
      to: 'session:archived',
      message,
      origin: 'test',
      jobQueue: mailbox.jobQueue,
    });
    expect(receipt.kind).toBe('enqueued');
    const getSession = mock(async () => ({}));
    const deliver = createMailboxDeliveryHandler({
      ...mailbox,
      getSession,
      isSessionArchived: () => true,
    });
    const [job] = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
    await expect(deliver(job)).rejects.toThrow('target session archived');
    expect(getSession).not.toHaveBeenCalled();
    expect(mailbox.sdkRows()).toEqual([]);
  });

  test.each([
    { to: 'invalid', message },
    { to: 'session:destination', message: { ...message, message: { content: '' } } },
  ])('rejects invalid handoffs without persisted work: %j', async (input) => {
    const receipt = await handoffPromptToMailbox({
      ...input,
      origin: 'test',
      jobQueue: mailbox.jobQueue,
    });
    expect(receipt.kind).toBe('rejected');
    expect(mailbox.rows()).toEqual([]);
    expect(mailbox.sdkRows()).toEqual([]);
  });
});
